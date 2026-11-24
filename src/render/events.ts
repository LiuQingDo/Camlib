// 由 main.ts 拆分而来：仅做搬移，未改动逻辑。
import {
  applyDateRangeInputs,
  applyDateRangePreset,
  changeSortMode,
  clearAllFilters,
  clearDateRange,
  clearSelection,
  commitDensity,
  openMediaCard,
  previewDensity,
  removeFilter,
  selectDay,
  setAiSearchEnabled,
  setKindFilter,
  setRatingMin,
  setRatingUnratedOnly,
  toggleBurstOnlyFilter,
  toggleCardSelection,
  toggleFavoriteOnlyFilter,
  toggleTagFilter,
} from "../app/bindings/toolbar";
import { openMergeModal, openTagManager } from "../app/dialogs-ops";
import { applyBatchMeta, requestDeleteSelected, runAiTagging, toggleFavorite, toggleFavoriteSelected } from "../app/media-ops";
import { loadMore, selectCurrentResults } from "../app/media-query";
import { handleGridKeydown, handleGridPointerDown, syncGridTabStopIfNeeded } from "../app/selection-nav";
import { loadThumbnail } from "../media/cache";
import { state } from "../state";
import { loadModalAsset, toggleLivePreview } from "../views/preview";
import { app } from "./context";
import { applyThumbnailToCard, markThumbnailRetryable } from "./grid";
import {
  batchMetaDraft,
  closeFilterPanel,
  closeSelectionMore,
  openSelectionMore,
  setSelectionDraftRating,
  setSelectionDraftTag,
  setSelectionDraftTagMode,
  toggleFilterPanel,
  toggleSelectionMore,
} from "./toolbar";

// ---------------------------------------------------------------------------
// 事件委托（S3a）：媒体卡片区 + 粘性工具栏
//
// 这两块每次 render() 都被 app.innerHTML 重建，逐元素绑定等于每次交互都要
// 重绑上百个监听器。这里改为模块初始化时在 document 上注册一次，元素只声明
// "要做什么"（data-action），回调集中在下面的派发表里。
//
// 用捕获阶段的两个理由：
// 1. 卡片内的缩略图"重试"按钮（data-retry-thumbnail）由 app 上的冒泡监听
//    处理且会 stopPropagation()；改造前它先冒泡到卡片把预览打开，捕获阶段
//    派发保持了这层既有顺序，不产生行为差异。
// 2. 卡片按钮（选择/收藏）在改造前靠 stopPropagation() 压掉卡片打开；现在
//    由 closest("[data-action]") 取最内层动作，天然等价。
// ---------------------------------------------------------------------------

export type DelegatedHandler = (element: HTMLElement, event: Event) => void;

/** 点击动作。用字面量联合 + Record 兜住完整性：漏写分支 tsc 直接报错。 */
export type ClickAction =
  | "open-media"
  | "toggle-select"
  | "toggle-favorite"
  | "load-more"
  | "retry-load-more"
  | "select-current-results"
  | "select-day"
  | "clear-selection"
  | "batch-ai-tag"
  | "toggle-favorite-selected"
  | "open-selection-tags"
  | "toggle-selection-more"
  | "close-selection-more"
  | "selection-more-rating"
  | "apply-batch-meta"
  | "merge-selected"
  | "delete-selected"
  | "filter-kind"
  | "filter-favorites"
  | "filter-burst"
  | "filter-rating-min"
  | "toggle-filter-panel"
  | "remove-filter"
  | "close-filter-panel"
  | "reset-filters"
  | "open-tag-manager"
  | "date-preset"
  | "clear-date-range";

export type ChangeAction =
  | "filter-tag"
  | "filter-rating-unrated"
  | "filter-ai-search"
  | "apply-date-range"
  | "sort-change"
  | "density-input"
  | "selection-more-tag"
  | "selection-more-detach";

export type InputAction = "density-input";

export const delegatedClickActions: Record<ClickAction, DelegatedHandler> = {
  "open-media": (card) => openMediaCard(card),
  "toggle-select": (button, event) => toggleCardSelection(button, event as MouseEvent),
  "toggle-favorite": (button) => void toggleFavorite(button.dataset.id!),
  "load-more": () => void loadMore(),
  "retry-load-more": () => {
    state.loadMoreError = null;
    void loadMore();
  },
  "select-current-results": () => void selectCurrentResults(),
  "select-day": (button) => selectDay(button.dataset.day ?? ""),
  "clear-selection": () => clearSelection(),
  "batch-ai-tag": () => {
    const ids = state.page.items
      .filter((item) => state.selectedIds.has(item.id) && item.kind !== "video")
      .map((item) => item.id);
    void runAiTagging(ids);
  },
  // 收藏 / 取消收藏合成一个切换：批里有未收藏的就是「收藏」，全已收藏才是「取消」。
  "toggle-favorite-selected": () => toggleFavoriteSelected(),
  "open-selection-tags": () => openSelectionMore({ focusSearch: true }),
  "toggle-selection-more": () => toggleSelectionMore(),
  "close-selection-more": () => closeSelectionMore({ restoreFocus: true }),
  "selection-more-rating": (button) => setSelectionDraftRating(Number(button.dataset.rating)),
  "apply-batch-meta": () => void applyBatchMeta(batchMetaDraft()),
  "merge-selected": () => void openMergeModal(),
  "delete-selected": () => void requestDeleteSelected(),
  "filter-kind": (chip) => setKindFilter(chip.dataset.kind ?? ""),
  "filter-favorites": () => toggleFavoriteOnlyFilter(),
  "filter-burst": () => toggleBurstOnlyFilter(),
  "filter-rating-min": (button) => setRatingMin(Number(button.dataset.rating)),
  "toggle-filter-panel": () => toggleFilterPanel(),
  "remove-filter": (chip) => removeFilter(chip.dataset.removeFilter ?? ""),
  "close-filter-panel": () => closeFilterPanel(),
  "reset-filters": () => clearAllFilters(),
  "open-tag-manager": () => openTagManager(),
  "date-preset": (chip) => applyDateRangePreset(chip.dataset.rangePreset),
  "clear-date-range": () => clearDateRange(),
};

export const delegatedChangeActions: Record<ChangeAction, DelegatedHandler> = {
  "filter-tag": (input) => toggleTagFilter(input.dataset.tagId ?? ""),
  "filter-rating-unrated": (input) => setRatingUnratedOnly((input as HTMLInputElement).checked),
  "filter-ai-search": (input) => setAiSearchEnabled((input as HTMLInputElement).checked),
  // from / to 两个输入框共用：任一变更都重读两侧的值。
  "apply-date-range": () => applyDateRangeInputs(),
  "sort-change": (select) => changeSortMode((select as HTMLSelectElement).value),
  // 密度滑块同名动作分两段：拖动中走 input 只改本地，松手走 change 才落盘。
  "density-input": (input) => commitDensity((input as HTMLInputElement).value),
  "selection-more-tag": (input) =>
    setSelectionDraftTag(input.dataset.tagId ?? "", (input as HTMLInputElement).checked),
  "selection-more-detach": (input) => setSelectionDraftTagMode((input as HTMLInputElement).checked),
};

export const delegatedInputActions: Record<InputAction, DelegatedHandler> = {
  "density-input": (input) => previewDensity((input as HTMLInputElement).value),
};

/** 把事件派发给最内层的 [data-action] 元素；没有登记的动作静默忽略。 */
export function dispatchDelegated(table: Record<string, DelegatedHandler>, event: Event): void {
  const target = event.target as Element | null;
  if (!target || typeof target.closest !== "function") return;
  const element = target.closest<HTMLElement>("[data-action]");
  const action = element?.dataset.action;
  if (!element || !action) return;
  const handler = table[action];
  if (!handler) return;
  handler(element, event);
}

document.addEventListener("click", (event) => dispatchDelegated(delegatedClickActions, event), true);

document.addEventListener("change", (event) => dispatchDelegated(delegatedChangeActions, event), true);

document.addEventListener("input", (event) => dispatchDelegated(delegatedInputActions, event), true);

// 卡片的键盘选择模型（Space 选中 / Enter 预览 / 方向键移动 / Shift 扩选）。
// 用捕获阶段在 document 上派发，省掉每次重建卡片都要重绑的监听器；具体落点与
// 范围计算在 app/selection-nav（纯逻辑可单测）。
document.addEventListener("keydown", (event) => handleGridKeydown(event), true);

// 点卡也要搬 roving 落点：否则点完第 20 张再按 →，焦点会从上次键盘停的第 1 张跳走。
document.addEventListener("pointerdown", (event) => handleGridPointerDown(event), true);

// 虚拟滚动把停靠点那张卡回收掉之后要补一个回来，否则 Tab 再也进不了网格。
// 每帧只在「当前没有 tabindex=0 的卡片」时才动 DOM。
let tabStopFrame = 0;
document.addEventListener(
  "scroll",
  () => {
    if (tabStopFrame) return;
    tabStopFrame = requestAnimationFrame(() => {
      tabStopFrame = 0;
      syncGridTabStopIfNeeded();
    });
  },
  { capture: true, passive: true },
);

// Delegated handlers survive full re-renders and must be bound only once.
app.addEventListener("click", (event) => {
  const target = event.target as HTMLElement | null;
  if (!target) return;
  const retry = target.closest<HTMLElement>("[data-retry-thumbnail]");
  if (retry?.dataset.retryThumbnail) {
    event.preventDefault();
    event.stopPropagation();
    const card = retry.closest<HTMLElement>("[data-preview]");
    const id = retry.dataset.retryThumbnail;
    if (card) {
      card.dataset.loaded = "true";
      card.classList.remove("has-preview");
      card.querySelector(".preview-fallback-row, .preview-fallback, .preview-retry")?.remove();
      if (!card.querySelector(".preview-skeleton, .preview-loading")) {
        card.insertAdjacentHTML("afterbegin", `<span class="preview-skeleton" aria-hidden="true"></span>`);
      }
    }
    void loadThumbnail(id, true)
      .then((asset) => applyThumbnailToCard(id, asset))
      .catch(() => markThumbnailRetryable(id));
    return;
  }
  if (target.closest("#preview-retry-media")) {
    event.preventDefault();
    void loadModalAsset();
    return;
  }
  if (target.closest("#video-retry")) {
    event.preventDefault();
    void loadModalAsset();
    return;
  }
  if (target.closest("#live-toggle")) {
    event.preventDefault();
    toggleLivePreview();
    return;
  }
});
