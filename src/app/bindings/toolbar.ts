// 由 main.ts 拆分而来：仅做搬移，未改动逻辑。
import { MediaKind } from "../../api/media";
import { collectRangeIds } from "../../lib/selection";
import { app, bind } from "../../render/context";
import { persistUiPrefs, refreshMedia, render } from "../../render/paint";
import { applySelectionChrome, resetSidebarExpansionForSelection, searchUi } from "../../render/toolbar";
import { invalidateGridGeometry, scheduleGridPaint } from "../../render/virtual";
import { Density, SortMode, state } from "../../state";

/** 工具栏展开区（高级筛选）里需要逐个绑定的输入框。 */
export function bindToolbarEvents(): void {
  const semanticInput = app.querySelector<HTMLInputElement>("#semantic-search-input");
  if (semanticInput) {
    bind(semanticInput, "input", () => {
      searchUi.semantic = semanticInput.value;
    });
    bind(semanticInput, "keydown", (event) => {
      if ((event as KeyboardEvent).key !== "Enter") return;
      event.preventDefault();
      commitSemanticSearch();
    });
  }
  bind(app.querySelector("#semantic-search-button"), "click", () => commitSemanticSearch());
}

export function clearAllFilters(): void {
  state.search = "";
  searchUi.draft = "";
  state.kind = undefined;
  state.favoriteOnly = false;
  state.burstOnly = false;
  state.datePrefix = undefined;
  state.dateFrom = undefined;
  state.dateTo = undefined;
  state.firstSeenFrom = null;
  state.tagIds.clear();
  state.ratingEq = null;
  state.ratingMin = null;
  state.semanticSearch = null;
  searchUi.semantic = "";
  state.semanticMeta = null;
  state.semanticMode = null;
  resetSidebarExpansionForSelection();
  void refreshMedia();
}

/**
 * 工具栏命令。原先是 bindEvents 里的内联回调；改成事件委托后由派发表按
 * data-action 调用，state 变更顺序与原实现逐条一致。
 */
export function setKindFilter(kind: string): void {
  // Type tabs replace the whole filter set rather than stacking with 收藏/连拍.
  // Without resetting these flags, switching away kept querying only the
  // secondary subset and made the other tabs appear unresponsive.
  state.kind = (kind || undefined) as MediaKind | undefined;
  state.favoriteOnly = false;
  state.burstOnly = false;
  void refreshMedia();
}

export function toggleFavoriteOnlyFilter(): void {
  // 收藏 / 连拍 are exclusive secondary tabs: selecting one clears the other.
  if (state.favoriteOnly) state.favoriteOnly = false;
  else {
    state.favoriteOnly = true;
    state.burstOnly = false;
  }
  void refreshMedia();
}

export function toggleBurstOnlyFilter(): void {
  if (state.burstOnly) state.burstOnly = false;
  else {
    state.burstOnly = true;
    state.favoriteOnly = false;
  }
  void refreshMedia();
}

export function toggleTagFilter(tagId: string): void {
  if (!tagId) return;
  if (state.tagIds.has(tagId)) state.tagIds.delete(tagId);
  else state.tagIds.add(tagId);
  void refreshMedia();
}

export function applyRatingFilter(value: string): void {
  state.ratingEq = null;
  state.ratingMin = null;
  if (value.startsWith("eq:")) state.ratingEq = Number(value.slice(3));
  else if (value.startsWith("min:")) state.ratingMin = Number(value.slice(4));
  void refreshMedia();
}

/** 日期区间输入框（from / to 任一变更都重算整段区间）。 */
export function applyDateRangeInputs(): void {
  const from = app.querySelector<HTMLInputElement>("#date-from")?.value.trim();
  const to = app.querySelector<HTMLInputElement>("#date-to")?.value.trim();
  state.dateFrom = from || undefined;
  state.dateTo = to || undefined;
  if (state.dateFrom || state.dateTo) {
    // Range wins over sidebar prefix so the two cannot fight in the title.
    state.datePrefix = undefined;
  }
  void refreshMedia();
}

export function clearDateRange(): void {
  state.dateFrom = undefined;
  state.dateTo = undefined;
  void refreshMedia();
}

export function applyDateRangePreset(preset: string | undefined): void {
  const today = new Date();
  const toIso = (date: Date) => {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  };
  if (preset === "month") {
    state.dateFrom = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-01`;
    state.dateTo = toIso(today);
  } else if (preset === "year") {
    state.dateFrom = `${today.getFullYear()}-01-01`;
    state.dateTo = toIso(today);
  } else if (preset === "days30") {
    const start = new Date(today);
    start.setDate(start.getDate() - 29);
    state.dateFrom = toIso(start);
    state.dateTo = toIso(today);
  } else {
    return;
  }
  state.datePrefix = undefined;
  void refreshMedia();
}

export function changeSortMode(value: string): void {
  state.sort = value as SortMode;
  void persistUiPrefs({ uiSort: state.sort });
  void refreshMedia();
}

// Keep density live while dragging; persist only on release so the settings
// file is not rewritten on every slider tick.
export function previewDensity(value: string): void {
  state.density = Number(value) as Density;
  app.style.setProperty("--tile-min", `${[150, 185, 220, 260, 310][state.density - 1]}px`);
  // 密度改了 ⇒ 列宽改了 ⇒ 行高与行盒全部作废，立刻按新几何重排。
  invalidateGridGeometry();
  scheduleGridPaint();
}

export function commitDensity(value: string): void {
  state.density = Number(value) as Density;
  void persistUiPrefs({ uiDensity: state.density });
}

/** Exit semantic search and return to the normal filter pipeline. */
export function exitSemanticSearch(): void {
  state.semanticSearch = null;
  searchUi.semantic = "";
  state.semanticMeta = null;
  state.semanticMode = null;
  void refreshMedia();
}

/** Commit the semantic search box: empty input exits back to normal filters. */
export function commitSemanticSearch(): void {
  const input = app.querySelector<HTMLInputElement>("#semantic-search-input");
  const draft = (input?.value ?? searchUi.semantic).trim();
  searchUi.semantic = draft;
  state.semanticSearch = draft || null;
  // A committed semantic query replaces the plain filename search so the two
  // do not fight; other filters stay (the result banner explains precedence).
  state.search = "";
  searchUi.draft = "";
  void refreshMedia();
}

/**
 * 卡片点击：打开预览。委托层的 open-media 动作与焦点回车都走这里。
 * 预览弹窗尚未增量化：容器按签名重建一次，内容由 renderOverlays 装载。
 */
export function openMediaCard(card: HTMLElement): void {
  state.previewIndex = Number(card.dataset.index);
  state.previewImmersive = state.previewMode === "immersive";
  // 预览容器重建后由 renderOverlays 装载内容，这里不再额外重放一次
  // （两次装载会把已经画出来的 <img> 再换一遍，等于重新解码）。
  render();
}

/** 卡片选择按钮：Shift 走区间连线，否则单张切换。 */
export function toggleCardSelection(button: HTMLElement, event: MouseEvent): void {
  const card = button.closest<HTMLElement>(".media-card");
  const index = Number(card?.dataset.index ?? 0);
  toggleSelection(button.dataset.id!, index, event.shiftKey);
}

export function toggleSelection(id: string, index: number, range = false): void {
  if (range && state.lastSelectIndex !== null) {
    // Range endpoints are resolved by collectRangeIds; out-of-page rows are skipped.
    for (const rangeId of collectRangeIds(state.page.items, state.lastSelectIndex, index)) {
      state.selectedIds.add(rangeId);
    }
    // The range end becomes the next anchor so chained Shift+clicks extend.
    state.lastSelectIndex = index;
    applySelectionChrome();
    return;
  }
  if (state.selectedIds.has(id)) state.selectedIds.delete(id);
  else state.selectedIds.add(id);
  state.lastSelectIndex = index;
  applySelectionChrome();
}
