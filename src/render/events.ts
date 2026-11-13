// 由 main.ts 拆分而来：仅做搬移，未改动逻辑。
import {
  applyDateRangeInputs,
  applyDateRangePreset,
  applyRatingFilter,
  changeSortMode,
  clearAllFilters,
  clearDateRange,
  commitDensity,
  openMediaCard,
  previewDensity,
  setKindFilter,
  toggleBurstOnlyFilter,
  toggleCardSelection,
  toggleFavoriteOnlyFilter,
  toggleTagFilter,
} from "../app/bindings/toolbar";
import { openMergeModal, openTagManager } from "../app/dialogs-ops";
import {
  applyBatchFavorite,
  applyBatchRating,
  applyBatchTag,
  requestDeleteSelected,
  runAiTagging,
  toggleFavorite,
} from "../app/media-ops";
import { loadMore, selectCurrentResults } from "../app/media-query";
import { loadThumbnail } from "../media/cache";
import { state } from "../state";
import { loadModalAsset, toggleLivePreview } from "../views/preview";
import { app } from "./context";
import { applyThumbnailToCard, markThumbnailRetryable } from "./grid";
import { applySelectionChrome, toggleAdvancedFilters, toggleToolbarTagPopover } from "./toolbar";

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
  | "clear-selection"
  | "batch-ai-tag"
  | "batch-favorite"
  | "batch-unfavorite"
  | "batch-tag-attach"
  | "batch-tag-detach"
  | "batch-rating-apply"
  | "merge-selected"
  | "delete-selected"
  | "filter-kind"
  | "filter-favorites"
  | "filter-burst"
  | "filter-tag"
  | "toggle-tag-popover"
  | "open-tag-manager"
  | "toggle-advanced-filters"
  | "clear-filters"
  | "date-preset"
  | "clear-date-range";

export type ChangeAction = "filter-rating" | "apply-date-range" | "sort-change" | "density-input";

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
  "clear-selection": () => {
    state.selectedIds.clear();
    state.lastSelectIndex = null;
    applySelectionChrome();
  },
  "batch-ai-tag": () => {
    const ids = state.page.items
      .filter((item) => state.selectedIds.has(item.id) && item.kind !== "video")
      .map((item) => item.id);
    void runAiTagging(ids);
  },
  "batch-favorite": () => void applyBatchFavorite(true),
  "batch-unfavorite": () => void applyBatchFavorite(false),
  "batch-tag-attach": () => void applyBatchTag(true),
  "batch-tag-detach": () => void applyBatchTag(false),
  "batch-rating-apply": () => void applyBatchRating(),
  "merge-selected": () => void openMergeModal(),
  "delete-selected": () => void requestDeleteSelected(),
  "filter-kind": (chip) => setKindFilter(chip.dataset.kind ?? ""),
  "filter-favorites": () => toggleFavoriteOnlyFilter(),
  "filter-burst": () => toggleBurstOnlyFilter(),
  "filter-tag": (chip) => toggleTagFilter(chip.dataset.tagFilter ?? ""),
  "toggle-tag-popover": () => toggleToolbarTagPopover(),
  "open-tag-manager": () => openTagManager(),
  "toggle-advanced-filters": () => toggleAdvancedFilters(),
  "clear-filters": () => clearAllFilters(),
  "date-preset": (chip) => applyDateRangePreset(chip.dataset.rangePreset),
  "clear-date-range": () => clearDateRange(),
};

export const delegatedChangeActions: Record<ChangeAction, DelegatedHandler> = {
  "filter-rating": (select) => applyRatingFilter((select as HTMLSelectElement).value),
  // from / to 两个输入框共用：任一变更都重读两侧的值。
  "apply-date-range": () => applyDateRangeInputs(),
  "sort-change": (select) => changeSortMode((select as HTMLSelectElement).value),
  // 密度滑块同名动作分两段：拖动中走 input 只改本地，松手走 change 才落盘。
  "density-input": (input) => commitDensity((input as HTMLInputElement).value),
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

// 卡片焦点态下的 Enter / Space 打开预览。原监听在卡片上冒泡触发，因此卡片内
// 任意子元素（含按钮）拿到焦点时按回车同样会打开预览并压掉原生激活。
document.addEventListener(
  "keydown",
  (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const target = event.target as Element | null;
    if (!target || typeof target.closest !== "function") return;
    const card = target.closest<HTMLElement>('[data-action="open-media"]');
    if (!card) return;
    event.preventDefault();
    openMediaCard(card);
  },
  true,
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
