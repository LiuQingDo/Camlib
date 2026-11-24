// 由 main.ts 拆分而来：仅做搬移，未改动逻辑。
import { MediaKind } from "../../api/media";
import { presetRange, type DatePresetId } from "../../lib/date-range";
import { UNKNOWN_DAY } from "../../lib/grid";
import { collectRangeIds } from "../../lib/selection";
import { app } from "../../render/context";
import { persistUiPrefs, refreshMedia, render } from "../../render/paint";
import { patchSidebar } from "../../render/shell";
import { displayItems } from "../media-order";
import {
  applySelectionChrome,
  patchToolbar,
  resetSidebarExpansionForSelection,
  searchUi,
  syncSearchChrome,
} from "../../render/toolbar";
import { invalidateGridGeometry, scheduleGridPaint } from "../../render/virtual";
import { Density, SortMode, state } from "../../state";

/** 清掉除搜索词以外的全部筛选条件：空态两条出路共用同一份清单。 */
function resetFilterConditions(): void {
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
}

export function clearAllFilters(): void {
  state.search = "";
  searchUi.draft = "";
  searchUi.mode = "text";
  resetFilterConditions();
  resetSidebarExpansionForSelection();
  void refreshMedia();
}

/**
 * 空态出路之一：清掉所有筛选，但保留搜索词。
 * 搜索词是用户刚刚敲进去的，丢掉就得重打；筛选是点出来的，重选成本低。
 */
export function clearFiltersKeepSearch(): void {
  resetFilterConditions();
  resetSidebarExpansionForSelection();
  void refreshMedia();
}

/**
 * 工具栏命令。原先是 bindEvents 里的内联回调；改成事件委托后由派发表按
 * data-action 调用，state 变更顺序与原实现逐条一致。
 *
 * 单项条件（类型 / 收藏 / 连拍 / 标签 / 评分 / 日期 / 逐项移除）一律
 * `resetScroll: false`：改一个条件就把视图拽回顶部，等于每次点 chip 都丢掉
 * 用户刚滚到的位置。只有「重置全部」这类整轮重置才回顶部。
 */
export function setKindFilter(kind: string): void {
  // 筛选是 AND 集合：切换类型只改 kind，不能顺手清掉收藏/连拍。
  // 旧实现会重置这两项，导致「只看收藏的视频」无法表达，也让 chip 与查询不同步。
  state.kind = (kind || undefined) as MediaKind | undefined;
  void refreshMedia({ resetScroll: false });
}

export function toggleFavoriteOnlyFilter(): void {
  // 收藏与连拍各自独立切换，可以与类型、标签等条件任意叠加。
  state.favoriteOnly = !state.favoriteOnly;
  void refreshMedia({ resetScroll: false });
}

export function toggleBurstOnlyFilter(): void {
  state.burstOnly = !state.burstOnly;
  void refreshMedia({ resetScroll: false });
}

export function toggleTagFilter(tagId: string): void {
  if (!tagId) return;
  if (state.tagIds.has(tagId)) state.tagIds.delete(tagId);
  else state.tagIds.add(tagId);
  void refreshMedia({ resetScroll: false });
}

/**
 * 评分下限（≥N★）。点击当前已选的那一档视为取消，因此点同一颗星两次等于
 * 「不限」；`未评分` 与区间下限互斥，设下限时清掉它。
 */
export function setRatingMin(value: number): void {
  const next = Number.isInteger(value) && value >= 1 && value <= 5 ? value : null;
  state.ratingMin = state.ratingMin === next ? null : next;
  state.ratingEq = null;
  void refreshMedia({ resetScroll: false });
}

/** 「只看未评分」开关：ratingEq=0 是既有查询字段，不动后端参数。 */
export function setRatingUnratedOnly(enabled: boolean): void {
  state.ratingEq = enabled ? 0 : null;
  if (enabled) state.ratingMin = null;
  void refreshMedia({ resetScroll: false });
}

function decodeFilterValue(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * 逐项移除 chips：`data-remove-filter="<key>:<encodeURIComponent(value)>"`。
 * 只改这一项条件，其余条件原样保留，且不回顶部。
 */
export function removeFilter(raw: string): void {
  const separator = raw.indexOf(":");
  const key = separator < 0 ? raw : raw.slice(0, separator);
  const value = separator < 0 ? "" : decodeFilterValue(raw.slice(separator + 1));
  switch (key) {
    case "kind":
      state.kind = undefined;
      break;
    case "favorite":
      state.favoriteOnly = false;
      break;
    case "burst":
      state.burstOnly = false;
      break;
    case "tag":
      state.tagIds.delete(value);
      break;
    case "date":
      state.datePrefix = undefined;
      state.dateFrom = undefined;
      state.dateTo = undefined;
      // 侧栏的年/月选中态由同一份 state 决定，摘掉日期后要跟着取消高亮。
      patchSidebar();
      break;
    case "rating":
      state.ratingEq = null;
      state.ratingMin = null;
      break;
    case "semantic":
      state.semanticSearch = null;
      state.semanticMeta = null;
      state.semanticMode = null;
      searchUi.semantic = "";
      searchUi.mode = "text";
      patchToolbar();
      break;
    default:
      return;
  }
  void refreshMedia({ resetScroll: false });
}

/**
 * 面板里的「AI 语义检索」开关：复用顶栏搜索框的 semantic 模式，不另建管线。
 * 打开只是切到 AI 模式并把光标放进搜索框；真正的查询仍由回车提交。
 */
export function setAiSearchEnabled(enabled: boolean): void {
  const input = app.querySelector<HTMLInputElement>("#search-input");
  if (searchUi.mode === (enabled ? "ai" : "text")) {
    patchToolbar();
    if (enabled) input?.focus();
    return;
  }
  let changed = false;
  if (enabled) {
    // 普通搜索词与 AI 检索互斥（与 commitSemanticSearch 的收尾一致）。
    if (state.search) {
      state.search = "";
      searchUi.draft = "";
      changed = true;
    }
    searchUi.mode = "ai";
    if (input) input.value = searchUi.semantic;
  } else {
    if (state.semanticSearch) {
      state.semanticSearch = null;
      state.semanticMeta = null;
      state.semanticMode = null;
      changed = true;
    }
    searchUi.semantic = "";
    searchUi.mode = "text";
    if (input) input.value = searchUi.draft;
  }
  syncSearchChrome();
  if (changed) void refreshMedia({ resetScroll: false });
  else patchToolbar();
  if (enabled) input?.focus();
}

/** 日期区间输入框（from / to 任一变更都重算整段区间）。 */
export function applyDateRangeInputs(): void {
  const from = app.querySelector<HTMLInputElement>("#date-from")?.value.trim();
  const to = app.querySelector<HTMLInputElement>("#date-to")?.value.trim();
  state.dateFrom = from || undefined;
  state.dateTo = to || undefined;
  if (state.dateFrom || state.dateTo) {
    // 日期前缀（年/月/日）与区间是唯一允许互斥的一对：primaryDateLabel()
    // 只能把一种日期条件写进标题，两者叠加会让标题在「2025-03」和
    // 「2025-03-01 ~ 2025-03-31」之间二选一，产生歧义。
    // 其余筛选（类型 / 收藏 / 连拍 / 标签 / 评分…）一律 AND 叠加。
    if (state.datePrefix) {
      state.datePrefix = undefined;
      patchSidebar();
    }
  }
  void refreshMedia({ resetScroll: false });
}

export function clearDateRange(): void {
  state.dateFrom = undefined;
  state.dateTo = undefined;
  void refreshMedia({ resetScroll: false });
}

export function applyDateRangePreset(preset: string | undefined): void {
  const range = presetRange(preset as DatePresetId);
  if (!range) return;
  state.dateFrom = range.from;
  state.dateTo = range.to;
  // 预设区间同样清掉日期前缀：前缀 vs 区间是唯一合法互斥（见 applyDateRangeInputs）。
  if (state.datePrefix) {
    state.datePrefix = undefined;
    patchSidebar();
  }
  void refreshMedia({ resetScroll: false });
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
  // 搜索框回到普通模式：AI 词已经作废，留着模式标记会让人以为还在 AI 里。
  searchUi.mode = "text";
  state.semanticMeta = null;
  state.semanticMode = null;
  void refreshMedia();
}

/**
 * Commit the semantic search box: empty input exits back to normal filters.
 * The draft is owned by `searchUi.semantic` — the shell input writes it on
 * every keystroke, so this never has to read the DOM (and stays usable from
 * the AI chat drawer's「搜索」chip, where the input may not even be visible).
 */
export function commitSemanticSearch(): void {
  const draft = searchUi.semantic.trim();
  searchUi.semantic = draft;
  state.semanticSearch = draft || null;
  searchUi.mode = draft ? "ai" : "text";
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
    for (const rangeId of collectRangeIds(displayItems(), state.lastSelectIndex, index)) {
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

/** 清空选择：Esc 与弹层里的「清除选择」共用，锚点一起丢掉。 */
export function clearSelection(): void {
  if (!state.selectedIds.size) return;
  state.selectedIds.clear();
  state.lastSelectIndex = null;
  applySelectionChrome();
}

/**
 * 「选择这天」：把该天分组里的 id 全部加入选择（只加不减，方便按天累加）。
 * 分组边界与网格一致（`captureDate ?? "unknown"`），所以计数和标题上的「N 个项目」对得上。
 */
export function selectDay(date: string): void {
  if (!date) return;
  let changed = false;
  for (const item of displayItems()) {
    if ((item.captureDate ?? UNKNOWN_DAY) !== date) continue;
    if (state.selectedIds.has(item.id)) continue;
    state.selectedIds.add(item.id);
    changed = true;
  }
  if (changed) applySelectionChrome();
}
