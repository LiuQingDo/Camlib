// 由 main.ts 拆分而来：仅做搬移，未改动逻辑。
import { listNotices, syncStateNotices, type Notice } from "../app/notices";
import { finishTask, listTasks, taskPercent, upsertTask, type Task } from "../app/tasks";
import { MediaKind, MediaQueryInput, ScanProgressDto, TagDto } from "../api/media";
import { matchDatePreset, type DatePresetId } from "../lib/date-range";
import { formatDatePrefix, panelFilterCount, secondaryFilterParts } from "../lib/filters";
import { formatCount, formatRangeLabel } from "../lib/format";
import { SortMode, state } from "../state";
import { app, region, setRegionHtml, setText } from "./context";
import { bindStatusEvents } from "./paint";
import { escapeHtml, formatDate, groupedFacets } from "./text";

/**
 * 搜索框的两种模式：普通检索（文件名 / 标签 / 描述）与 AI 语义检索。
 * 两个草稿分开存，切换模式不会把另一边打了一半的字吃掉；同一时刻只有
 * 一种模式的条件生效（提交时由 app 层清掉另一边）。
 */
export type SearchMode = "text" | "ai";

// Keep the text being composed separate from the submitted query so typing
// never refreshes the media grid on every keystroke. This also preserves
// unsent text on redraws.
/** 搜索框草稿：输入不触发刷新，提交才刷新（与 semantic 分开保存）。 */
export const searchUi: { draft: string; semantic: string; mode: SearchMode } = {
  draft: "",
  semantic: "",
  mode: "text",
};
// Same draft discipline for the semantic (natural-language) search box.
/**
 * 筛选面板的开关与面板内 UI 状态。
 *
 * 都不进 `state`：它们不影响任何查询参数，放进去只会让「查询变了要刷新」
 * 的判断多出三个噪音字段。模块级变量同样能在 patch 之间存活。
 */
export let filterPanelOpen = false;

/** 面板内标签搜索词：面板重挂时回填，关一次不该把打了一半的词吃掉。 */
let filterPanelTagQuery = "";

/** 标签列表上次的滚动位置：面板重挂时恢复，选了深的标签不会跳回顶部。 */
let filterPanelTagScroll = 0;

/** 面板主行按钮的 `getBoundingClientRect()` 只在挂载与 patch 时读一次。 */
const FILTER_PANEL_GAP = 6;

export function primaryDateLabel(): string {
  if (state.firstSeenFrom) return "新导入";
  if (state.datePrefix) return formatDate(state.datePrefix);
  if (state.dateFrom || state.dateTo) return formatRangeLabel(state.dateFrom, state.dateTo);
  return "";
}

export function currentQueryFields(): Pick<
  MediaQueryInput,
  | "libraryId"
  | "kind"
  | "favoriteOnly"
  | "burstOnly"
  | "search"
  | "datePrefix"
  | "dateFrom"
  | "dateTo"
  | "firstSeenFrom"
  | "tagIds"
  | "ratingEq"
  | "ratingMin"
  | "sort"
> {
  if (!state.library) throw new Error("媒体库未就绪");
  return {
    libraryId: state.library.id,
    kind: state.kind,
    favoriteOnly: state.favoriteOnly,
    burstOnly: state.burstOnly,
    search: state.search || undefined,
    datePrefix: state.datePrefix,
    dateFrom: state.dateFrom,
    dateTo: state.dateTo,
    firstSeenFrom: state.firstSeenFrom ?? undefined,
    tagIds: state.tagIds.size ? [...state.tagIds] : undefined,
    ratingEq: state.ratingEq ?? undefined,
    ratingMin: state.ratingEq === null ? (state.ratingMin ?? undefined) : undefined,
    sort: state.sort,
  };
}

export function resetSidebarExpansionForSelection(): void {
  if (state.datePrefix) {
    const year = state.datePrefix.slice(0, 4);
    state.expandedYears = new Set([year]);
    if (state.datePrefix.length >= 7) {
      state.expandedMonths = new Set([state.datePrefix.slice(0, 7)]);
    } else {
      state.expandedMonths = new Set();
    }
    return;
  }
  // Default: show only the newest year's months, days stay closed.
  const newestYear = groupedFacets()[0]?.year;
  state.expandedYears = newestYear ? new Set([newestYear]) : new Set();
  state.expandedMonths = new Set();
}

export function scrollToContentTop(): void {
  const content = app.querySelector<HTMLElement>(".content");
  if (content) content.scrollTop = 0;
  window.scrollTo?.(0, 0);
}

/** Patch selection UI without rebuilding the grid (avoids thumbnail flicker). */
export function applySelectionChrome(): void {
  app.querySelectorAll<HTMLElement>(".media-card").forEach((card) => {
    const id = card.dataset.id;
    if (!id) return;
    const selected = state.selectedIds.has(id);
    card.classList.toggle("is-selected", selected);
    const button = card.querySelector<HTMLButtonElement>(".card-select");
    if (!button) return;
    button.classList.toggle("is-checked", selected);
    button.setAttribute("aria-pressed", String(selected));
    const item = state.page.items.find((entry) => entry.id === id);
    button.setAttribute("aria-label", `${selected ? "取消选择" : "选择"}${item?.displayName ?? ""}`);
  });
  // 选择工具栏有独立挂载点，内容不变就不碰 DOM（Shift 连选时这里会被高频调用）。
  setRegionHtml(region("selection"), renderSelectionToolbar());
}

export function updateFavoriteButton(id: string): void {
  const favorite = state.favorites.has(id);
  const pending = state.favoritePendingIds.has(id);
  const button = [...app.querySelectorAll<HTMLButtonElement>('[data-action="toggle-favorite"]')].find(
    (entry) => entry.dataset.id === id,
  );
  if (!button) return;
  button.classList.toggle("is-favorite", favorite);
  button.classList.toggle("is-pending", pending);
  button.disabled = pending;
  button.setAttribute("aria-pressed", String(favorite));
  button.setAttribute("aria-busy", String(pending));
}

/**
 * 主行：类型 / 收藏 / 连拍 三个即时开关 + 「筛选 (n) ▾」。
 *
 * 永远只有一行：chip 组放在一个横向可滚的壳里（滚条隐藏），右侧的「筛选」
 * 按钮固定在外层，窗口再窄也不会被挤出可见区。原来那行条件摘要与
 * 折叠箭头一并删掉——条件改由下一行的 chips 逐项呈现。
 */
export function renderPrimaryFilters(): string {
  // 类型 chip 是普通 AND 条件，高亮必须严格等于 state.kind。
  // 收藏 / 连拍 各自独立切换，可以和类型同时生效，也不会偷偷改查询。
  const kinds = [
    { value: undefined, label: "全部" },
    { value: "photo" as MediaKind, label: "照片" },
    { value: "video" as MediaKind, label: "视频" },
    { value: "live" as MediaKind, label: "实况" },
  ]
    .map(
      (filter) =>
        `<button class="filter-chip ${state.kind === filter.value ? "is-active" : ""}" type="button" data-action="filter-kind" data-kind="${filter.value ?? ""}">${filter.label}</button>`,
    )
    .join("");
  const kindGroup = `${kinds}<button class="filter-chip ${state.favoriteOnly ? "is-active" : ""}" type="button" id="favorite-filter" data-action="filter-favorites">收藏</button><button class="filter-chip ${state.burstOnly ? "is-active" : ""}" type="button" id="burst-filter" data-action="filter-burst">连拍</button>`;
  const panelCount = panelFilterCount(state);
  const toggleLabel = panelCount ? `筛选 (${panelCount})` : "筛选";
  return `<div class="filter-row-scroll"><div class="filter-group">${kindGroup}</div></div><button class="filter-chip filter-toggle ${panelCount ? "has-active" : ""}" type="button" id="toggle-filter-panel" data-action="toggle-filter-panel" aria-expanded="${filterPanelOpen}" aria-haspopup="dialog" aria-controls="filter-panel">${toggleLabel}<span class="filter-toggle-caret" aria-hidden="true">${filterPanelOpen ? "▴" : "▾"}</span></button>`;
}

/**
 * 条件 chips：每个已生效条件一枚，顺序由 `secondaryFilterParts()` 固定。
 * 点 × 立刻摘掉这一项且不回顶部；「重置全部」才把视图拉回顶端。
 */
export function renderFilterChips(): string {
  return secondaryFilterParts(state)
    .map((chip) => {
      // value 可能是带冒号/斜杠的 AI 查询，编码后塞进属性，读回来再解。
      const remove = `${chip.key}:${encodeURIComponent(chip.value)}`;
      return `<span class="chip" data-chip="${chip.key}"><span class="chip-label" title="${escapeHtml(chip.label)}">${escapeHtml(chip.label)}</span><button class="chip-x" type="button" data-action="remove-filter" data-remove-filter="${escapeHtml(remove)}" aria-label="移除 ${escapeHtml(chip.label)}" title="移除">×</button></span>`;
    })
    .join("");
}

/** Tag count-descending view for the panel's tag list. */
export function sortedTagsByUsage(): TagDto[] {
  return state.tags
    .slice()
    .sort((a, b) => (b.mediaCount ?? 0) - (a.mediaCount ?? 0) || a.name.localeCompare(b.name, "zh-Hans-CN"));
}

// ---------------------------------------------------------------------------
// 筛选面板（非模态浮层）
//
// 旧的三套范式——主行折叠层、吸顶条里的 132px 内滚动层、挂在吸顶条上的
// 标签浮层——合并成一个面板：
//   · 浮层挂在 `#overlay-host` 的 `[data-overlay="filters"]` 槽位，位置由主行
//     按钮的 rect 算出来，因此不会被 sticky 条的圆角或溢出裁切；
//   · 面板内只有标签列表一处滚动，其它分组按内容撑开；
//   · 控件全是原生 input/checkbox/button，自造日历与下拉只会把键盘、区域格式
//     和可访问性一起做丢。
// ---------------------------------------------------------------------------

/** 标签列表的结构签名：标签增删或计数变化才重建行，否则原地同步勾选态。 */
function tagSignature(): string {
  return state.tags.map((tag) => `${tag.id}:${tag.name}:${tag.mediaCount ?? -1}`).join("|");
}

function tagRowsHtml(): string {
  const tags = sortedTagsByUsage();
  if (!tags.length) {
    return `<div class="filter-panel-empty">还没有标签。<button class="text-button" type="button" data-action="open-tag-manager">管理标签</button></div>`;
  }
  return `${tags
    .map((tag) => {
      const active = state.tagIds.has(tag.id);
      return `<label class="tag-filter-row${active ? " is-active" : ""}" data-tag-name="${escapeHtml(tag.name.toLowerCase())}"><input type="checkbox" data-action="filter-tag" data-tag-id="${escapeHtml(tag.id)}" ${active ? "checked" : ""} /><span class="tag-filter-name">${escapeHtml(tag.name)}${tag.hasAi ? `<i class="ai-badge" aria-label="AI 标签">AI</i>` : ""}</span>${tag.mediaCount != null ? `<span class="tag-filter-count">${formatCount(tag.mediaCount)}</span>` : ""}</label>`;
    })
    .join("")}<div class="filter-panel-empty" data-tag-empty hidden>没有匹配的标签</div>`;
}

/** 标签组：可搜索 + 数量计数 + 原生复选框（取代原来那个浮动标签面板）。 */
export function renderTagFilterGroup(): string {
  return `<section class="filter-panel-group filter-panel-tags"><div class="filter-panel-group-head"><h3>标签</h3><span data-tag-selected>已选 ${state.tagIds.size}/${state.tags.length}</span><button class="text-button filter-panel-manage" type="button" data-action="open-tag-manager">管理</button></div><div class="tag-filter-search"><span aria-hidden="true">⌕</span><input id="filter-panel-tag-input" type="search" placeholder="搜索标签" value="${escapeHtml(filterPanelTagQuery)}" aria-label="搜索标签" /></div><div class="tag-filter-list" data-tag-list data-signature="${escapeHtml(tagSignature())}">${tagRowsHtml()}</div></section>`;
}

/** 评分：≥1..≥5 星级点击器 + 「未评分」开关（10 项下拉已删）。 */
export function renderRatingFilter(): string {
  const steps = [1, 2, 3, 4, 5]
    .map((value) => {
      const active = state.ratingMin === value;
      return `<button class="rating-step${active ? " is-active" : ""}" type="button" data-action="filter-rating-min" data-rating="${value}" aria-pressed="${active}" aria-label="评分不低于 ${value} 星">≥${value}★</button>`;
    })
    .join("");
  return `<section class="filter-panel-group"><div class="filter-panel-group-head"><h3>评分</h3><span>${state.ratingMin === null ? "不限下限" : `≥ ${state.ratingMin} 星`}</span></div><div class="rating-steps" role="group" aria-label="最低评分">${steps}</div><label class="filter-switch"><input type="checkbox" data-action="filter-rating-unrated" ${state.ratingEq === 0 ? "checked" : ""} /><span>只看未评分</span></label></section>`;
}

/** 日期预设；`clear` 是动作而不是区间，单独渲染成可禁用的按钮。 */
const DATE_PRESETS: ReadonlyArray<{ id: Exclude<DatePresetId, "clear">; label: string }> = [
  { id: "week", label: "本周" },
  { id: "month", label: "本月" },
  { id: "last-month", label: "上月" },
  { id: "year", label: "今年" },
];

function dateRangeNote(): string {
  if (state.datePrefix) {
    return `已按侧栏的「${formatDatePrefix(state.datePrefix)}」筛选。日期前缀与区间互斥，所以区间与预设先禁用；移除条件行里的「日期」chip 即可改用区间。`;
  }
  return "只填一侧表示开区间：自某天起 / 至某天止。";
}

export function renderDateRangeControls(): string {
  const locked = Boolean(state.datePrefix);
  const matched = matchDatePreset(state.dateFrom, state.dateTo);
  const presets = DATE_PRESETS.map((preset) => {
    const active = preset.id === matched;
    return `<button class="filter-chip range-preset${active ? " is-active" : ""}" type="button" data-action="date-preset" data-range-preset="${preset.id}" aria-pressed="${active}" ${locked ? "disabled" : ""}>${preset.label}</button>`;
  }).join("");
  const hasRange = Boolean(state.dateFrom || state.dateTo);
  return `<section class="filter-panel-group"><div class="filter-panel-group-head"><h3>日期</h3></div><div class="date-presets">${presets}<button class="filter-chip range-preset" type="button" data-action="clear-date-range" ${hasRange ? "" : "disabled"}>清除</button></div><div class="date-range" aria-label="日期区间"><label><span>从</span><input type="date" id="date-from" data-action="apply-date-range" value="${escapeHtml(state.dateFrom ?? "")}" aria-label="开始日期" ${locked ? "disabled" : ""} /></label><label><span>到</span><input type="date" id="date-to" data-action="apply-date-range" value="${escapeHtml(state.dateTo ?? "")}" aria-label="结束日期" ${locked ? "disabled" : ""} /></label></div><p class="filter-panel-note" data-date-note>${escapeHtml(dateRangeNote())}</p></section>`;
}

/** 检索组：AI 语义检索开关，复用搜索框的 semantic 模式，不另建一套管线。 */
function renderAiSearchGroup(): string {
  const on = searchUi.mode === "ai" || Boolean(state.semanticSearch);
  const note = state.semanticSearch
    ? `当前语义检索：${state.semanticSearch}`
    : "打开后在顶栏搜索框写一句描述（如「去年秋天湖边」），回车执行。";
  return `<section class="filter-panel-group"><div class="filter-panel-group-head"><h3>检索</h3></div><label class="filter-switch"><input type="checkbox" data-action="filter-ai-search" ${on ? "checked" : ""} /><span>AI 语义检索</span></label><p class="filter-panel-note" data-ai-note>${escapeHtml(note)}</p></section>`;
}

export function renderFilterPanel(): string {
  const count = panelFilterCount(state);
  return `<div class="filter-panel" id="filter-panel" role="dialog" aria-modal="false" aria-label="筛选" data-prefix-lock="${state.datePrefix ? "1" : ""}"><div class="filter-panel-head"><strong>筛选</strong><span class="filter-panel-count" data-filter-count>已选 ${count} 项</span><button class="icon-button filter-panel-close" type="button" data-action="close-filter-panel" aria-label="关闭筛选面板">×</button></div><div class="filter-panel-body">${renderTagFilterGroup()}${renderRatingFilter()}${renderDateRangeControls()}${renderAiSearchGroup()}</div><div class="filter-panel-foot"><button class="text-button" type="button" data-action="reset-filters">重置全部</button><button class="primary-button filter-panel-done" type="button" data-action="close-filter-panel">完成</button></div></div>`;
}

function filterPanelSlot(): HTMLElement | null {
  return app.querySelector<HTMLElement>('#overlay-host [data-overlay="filters"]');
}

/**
 * 贴按钮定位：左对齐按钮，top = 按钮底部 + 6px，右/下都不越出视口。
 * 窄屏（≤720px）交给 CSS 的底部抽屉，不写内联几何。
 */
function positionFilterPanel(panel: HTMLElement): void {
  const toggle = app.querySelector<HTMLElement>("#toggle-filter-panel");
  if (!toggle) return;
  if (window.matchMedia("(max-width: 720px)").matches) {
    for (const property of ["left", "top", "width", "max-height"]) panel.style.removeProperty(property);
    return;
  }
  const rect = toggle.getBoundingClientRect();
  const margin = 12;
  const width = Math.min(380, Math.max(280, window.innerWidth - 32));
  // 默认左对齐按钮；右边放不下就改成「右边缘对齐按钮」，比硬贴左边再被
  // clamp 到视口边缘更像是有意为之。
  let left = rect.left;
  if (left + width > window.innerWidth - margin) left = rect.right - width;
  left = Math.max(margin, left);
  panel.style.width = `${width}px`;
  panel.style.left = `${left}px`;
  panel.style.top = `${rect.bottom + FILTER_PANEL_GAP}px`;
  // 规格上限是 calc(100vh - 120px)；再按按钮的真实位置收一次，底栏才不会被裁掉。
  const available = window.innerHeight - rect.bottom - FILTER_PANEL_GAP - margin;
  panel.style.maxHeight = `${Math.max(240, Math.min(window.innerHeight - 120, available))}px`;
}

/** 面板内标签列表的搜索过滤（纯 DOM 显示切换，不碰 state）。 */
function filterTagRows(panel: HTMLElement): void {
  const query = filterPanelTagQuery.trim().toLowerCase();
  let visible = 0;
  panel.querySelectorAll<HTMLElement>("[data-tag-list] .tag-filter-row").forEach((row) => {
    const match = !query || (row.dataset.tagName ?? "").includes(query);
    row.hidden = !match;
    if (match) visible += 1;
  });
  const empty = panel.querySelector<HTMLElement>("[data-tag-empty]");
  if (empty) empty.hidden = visible > 0;
}

function bindFilterPanel(panel: HTMLElement): void {
  const input = panel.querySelector<HTMLInputElement>("#filter-panel-tag-input");
  input?.addEventListener("input", () => {
    filterPanelTagQuery = input.value;
    filterTagRows(panel);
  });
  filterTagRows(panel);
  const list = panel.querySelector<HTMLElement>("[data-tag-list]");
  if (list) {
    list.scrollTop = filterPanelTagScroll;
    list.addEventListener(
      "scroll",
      () => {
        filterPanelTagScroll = list.scrollTop;
      },
      { passive: true },
    );
  }
  // 打开即把光标放进搜索框：标签上百个时，滚着找比打字慢得多（键盘直接可用）。
  input?.focus();
}

/**
 * 原地同步：勾选态、星级、日期值、预设高亮、计数。
 * 不重建节点 ⇒ 标签列表的滚动位置与搜索框焦点都不会被打断。
 */
function syncFilterPanel(panel: HTMLElement): void {
  setText(panel.querySelector("[data-filter-count]"), `已选 ${panelFilterCount(state)} 项`);
  const list = panel.querySelector<HTMLElement>("[data-tag-list]");
  const signature = tagSignature();
  if (list && list.dataset.signature !== signature) {
    const scrollTop = list.scrollTop;
    list.dataset.signature = signature;
    list.innerHTML = tagRowsHtml();
    list.scrollTop = scrollTop;
    filterTagRows(panel);
  }
  panel.querySelectorAll<HTMLInputElement>('[data-tag-list] input[data-action="filter-tag"]').forEach((box) => {
    const id = box.dataset.tagId;
    if (!id) return;
    const active = state.tagIds.has(id);
    if (box.checked !== active) box.checked = active;
    box.closest(".tag-filter-row")?.classList.toggle("is-active", active);
  });
  setText(panel.querySelector("[data-tag-selected]"), `已选 ${state.tagIds.size}/${state.tags.length}`);
  panel.querySelectorAll<HTMLElement>('[data-action="filter-rating-min"]').forEach((button) => {
    const active = Number(button.dataset.rating) === state.ratingMin;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  const unrated = panel.querySelector<HTMLInputElement>('[data-action="filter-rating-unrated"]');
  if (unrated && unrated.checked !== (state.ratingEq === 0)) unrated.checked = state.ratingEq === 0;
  // 日期输入框有焦点时绝不覆盖：那可能正是用户敲到一半的值。
  const from = panel.querySelector<HTMLInputElement>("#date-from");
  if (from && document.activeElement !== from && from.value !== (state.dateFrom ?? ""))
    from.value = state.dateFrom ?? "";
  const to = panel.querySelector<HTMLInputElement>("#date-to");
  if (to && document.activeElement !== to && to.value !== (state.dateTo ?? "")) to.value = state.dateTo ?? "";
  const matched = matchDatePreset(state.dateFrom, state.dateTo);
  panel.querySelectorAll<HTMLElement>("[data-range-preset]").forEach((button) => {
    const active = button.dataset.rangePreset === matched;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  const clearRange = panel.querySelector<HTMLButtonElement>('[data-action="clear-date-range"]');
  if (clearRange) clearRange.disabled = !(state.dateFrom || state.dateTo);
  setText(panel.querySelector("[data-date-note]"), dateRangeNote());
  const ai = panel.querySelector<HTMLInputElement>('[data-action="filter-ai-search"]');
  const aiOn = searchUi.mode === "ai" || Boolean(state.semanticSearch);
  if (ai && ai.checked !== aiOn) ai.checked = aiOn;
  setText(
    panel.querySelector("[data-ai-note]"),
    state.semanticSearch
      ? `当前语义检索：${state.semanticSearch}`
      : "打开后在顶栏搜索框写一句描述（如「去年秋天湖边」），回车执行。",
  );
}

/** 面板挂载 / 卸载 / 原地同步；由 patchToolbar 每次统一调度。 */
export function patchFilterPanel(): void {
  // 任何模态层压上来都直接关掉面板：它非模态、没有焦点陷阱，留在模态底下的
  // 唯一效果是关掉模态后突然又冒出来。
  const blocked =
    state.previewIndex !== null ||
    state.settingsOpen ||
    state.backupOpen ||
    state.editorOpen ||
    state.mergeModalOpen ||
    state.tagsManagerOpen ||
    state.deleteConfirm !== null;
  if (blocked) filterPanelOpen = false;
  const slot = filterPanelSlot();
  const existing = slot?.querySelector<HTMLElement>("#filter-panel") ?? null;
  if (!filterPanelOpen) {
    existing?.remove();
    // 关掉即丢弃搜索词与滚动记忆：重开时是「全部标签」的干净起点。
    filterPanelTagQuery = "";
    filterPanelTagScroll = 0;
    return;
  }
  if (!slot) return;
  const lockKey = state.datePrefix ? "1" : "";
  if (!existing || existing.dataset.prefixLock !== lockKey) {
    slot.innerHTML = renderFilterPanel();
    const panel = slot.querySelector<HTMLElement>("#filter-panel");
    if (!panel) return;
    bindFilterPanel(panel);
    positionFilterPanel(panel);
    return;
  }
  positionFilterPanel(existing);
  syncFilterPanel(existing);
}

export function openFilterPanel(): void {
  if (filterPanelOpen) return;
  filterPanelOpen = true;
  patchToolbar();
}

export function closeFilterPanel(): void {
  if (!filterPanelOpen) return;
  // 焦点在面板里（标签搜索框）时，关掉后要把它还给主行按钮，而不是掉到 body。
  const restoreFocus =
    document.activeElement instanceof HTMLElement && document.activeElement.closest("#filter-panel") !== null;
  filterPanelOpen = false;
  // 关掉即丢弃搜索词与滚动记忆：重开时是「全部标签」的干净起点。
  filterPanelTagQuery = "";
  filterPanelTagScroll = 0;
  patchToolbar();
  if (restoreFocus) app.querySelector<HTMLElement>("#toggle-filter-panel")?.focus();
}

export function toggleFilterPanel(): void {
  if (filterPanelOpen) closeFilterPanel();
  else openFilterPanel();
}

// 面板外的点击关掉它。主行按钮自身走 data-action 的切换；整条吸顶筛选条
// （类型 chip、条件 chips、排序）都算「面板的地盘」，否则一边看面板一边点
// 类型，面板会被自己关掉，没法连续组合条件。
document.addEventListener("pointerdown", (event) => {
  if (!filterPanelOpen) return;
  const target = event.target instanceof HTMLElement ? event.target : null;
  if (!target) return;
  if (target.closest("#filter-panel") || target.closest(".sticky-controls")) return;
  closeFilterPanel();
});

/** 尺寸变了、内容区滚了，锚点就失效了：直接关掉，而不是让它跟着飘。 */
window.addEventListener("resize", () => {
  if (filterPanelOpen) closeFilterPanel();
});

document.addEventListener(
  "scroll",
  (event) => {
    if (!filterPanelOpen) return;
    const target = event.target;
    // 面板内部（标签列表）的滚动是唯一允许的那种，不算。
    if (target instanceof HTMLElement && target.closest("#filter-panel")) return;
    closeFilterPanel();
  },
  true,
);

export function scanStatusLabel(progress: ScanProgressDto): string {
  if (progress.total > 0) {
    const phase =
      progress.phase === "discovering" ? "发现文件" : progress.phase === "indexing" ? "建立索引" : "整理结果";
    return `正在扫描媒体库 · ${phase}`;
  }
  if (progress.processed > 0) return `正在扫描媒体库 · 已发现 ${formatCount(progress.processed)} 个文件`;
  return "正在扫描媒体库 · 发现文件";
}

export function scanPercentLabel(progress: ScanProgressDto): string {
  return progress.total > 0 ? `${Math.round((progress.processed / progress.total) * 100)}%` : "发现中";
}

/**
 * 查询状态横幅：现在是「只为 AI 搜索而生」的一条说明。
 *
 * 它回答的是「当前结果为什么长这样」，是查询状态而不是通知，所以留在原位、
 * 不迁进错误条；扫描进度归任务胶囊，其余告警归错误条，三者互不抢占。
 */
export function renderStatusBanner(): string {
  if (!state.semanticSearch) return "";
  const meta = state.semanticMeta;
  const modeLabel =
    state.semanticMode === "text"
      ? "描述/标签关键字"
      : state.semanticMode === "structured"
        ? "时间/类型条件"
        : "检索中…";
  const conditions: string[] = [];
  if (meta?.dateFrom || meta?.dateTo) {
    conditions.push(
      meta?.dateFrom && meta?.dateTo
        ? `${meta.dateFrom} ~ ${meta.dateTo}`
        : meta?.dateFrom
          ? `自 ${meta.dateFrom}`
          : `至 ${meta.dateTo}`,
    );
  }
  if (meta?.kind) conditions.push(meta.kind === "photo" ? "照片" : meta.kind === "video" ? "视频" : "实况");
  if (meta?.keywords) conditions.push(`关键词「${meta.keywords}」`);
  return `<div class="notice-banner is-info" role="status"><span class="notice-icon">✦</span><div><strong>AI 搜索：${escapeHtml(state.semanticSearch)}</strong><span>${escapeHtml(`模式：${modeLabel}${conditions.length ? ` · 解析条件：${conditions.join("，")}` : ""}。结果由 AI 检索决定，不叠加其他筛选。`)}</span></div><button class="text-button" id="exit-semantic-search" type="button">退出 AI 搜索</button></div>`;
}

// ---------------------------------------------------------------------------
// 反馈三通道
//
// 改造前这里是一条 if-else 链：语义搜索 → 扫描中 → 断盘 → 路径无效 → error
// → 最近任务 → ffmpeg，同一时刻只画一条，于是「扫描中」会把「索引损坏」盖掉，
// 删除反馈还画在内容流里，滚两屏就看不见。现在拆开：
//   错误条  —— 常驻错误 / 告警，读 app/notices.ts；
//   胶囊    —— 进行中的任务，读 app/tasks.ts；
//   toast   —— 一次性结果，见 app/toast.ts。
// 三者各自有挂载点，可以同时出现。
// ---------------------------------------------------------------------------

const NOTICE_ICON: Record<Notice["kind"], string> = {
  error: "!",
  warning: "!",
  info: "i",
  success: "✓",
};

/**
 * 派生通知的固定按钮。沿用骨架里既有的 id，绑定仍留在 bindStatusEvents，
 * 这样 render 层不必为了「重新检测」去 import app/library。
 */
const DERIVED_NOTICE_ACTIONS: Record<string, string> = {
  "library-disconnected": `<button class="text-button" type="button" id="rescan-button">重新检测</button>`,
  "library-invalid": `<button class="text-button" type="button" id="open-settings-from-banner">打开设置</button>`,
};

function noticeItemHtml(notice: Notice): string {
  const actions = [
    ...(notice.actions ?? []).map(
      (action, index) =>
        `<button class="text-button" type="button" data-notice-id="${escapeHtml(notice.id)}" data-notice-action="${index}">${escapeHtml(action.label)}</button>`,
    ),
    DERIVED_NOTICE_ACTIONS[notice.id] ?? "",
  ].join("");
  // 派生通知（断盘 / 路径无效）不给关闭：关掉下一帧同步又会推回来，看起来像没反应。
  const close =
    notice.closable === false
      ? ""
      : `<button class="error-bar-close" type="button" data-notice-dismiss="${escapeHtml(notice.id)}" aria-label="关闭通知">×</button>`;
  // 错误/告警的 detail 是技术细节，默认折叠；信息类（最近任务、缺 ffmpeg）的
  // detail 就是正文本身，折起来反而要用户多点一次才能读到。
  const collapsed = notice.kind === "error" || notice.kind === "warning";
  const detail = notice.detail
    ? collapsed
      ? `<details class="error-bar-detail"><summary>技术细节</summary><pre>${escapeHtml(notice.detail)}</pre></details>`
      : `<span class="error-bar-detail-inline">${escapeHtml(notice.detail)}</span>`
    : "";
  return `<div class="error-bar-item is-${notice.kind}" data-notice="${escapeHtml(notice.id)}" role="${notice.kind === "error" ? "alert" : "status"}"><span class="notice-icon" aria-hidden="true">${NOTICE_ICON[notice.kind]}</span><div class="error-bar-copy"><strong>${escapeHtml(notice.title)}</strong>${detail}</div>${actions}${close}</div>`;
}

/** 错误条：最多 3 条，其余只报数量（不悄悄吞掉）。 */
export function renderErrorBar(): string {
  const { visible, hidden } = listNotices();
  if (!visible.length) return "";
  const more = hidden > 0 ? `<span class="error-bar-more">还有 ${formatCount(hidden)} 条</span>` : "";
  return `<div class="error-bar" role="region" aria-label="通知">${visible.map(noticeItemHtml).join("")}${more}</div>`;
}

/** 展开 / 收起的纯 UI 状态；不放进 state 是因为它不影响任何查询。 */
let taskPillExpanded = false;

export function toggleTaskPill(): void {
  taskPillExpanded = !taskPillExpanded;
}

/** scan 的取消走既有 cancelCurrentScan()（app 层按 id 分派），注册表里不塞回调。 */
function canCancelTask(task: Task): boolean {
  return Boolean(task.cancel) || task.id === "scan";
}

function taskRowHtml(task: Task): string {
  const percent = taskPercent(task);
  const trackClass = percent === null ? " is-indeterminate" : "";
  const width = percent === null ? "35%" : `${percent}%`;
  const counts = task.total ? `${formatCount(task.done ?? 0)} / ${formatCount(task.total)}` : "";
  const cancel = canCancelTask(task)
    ? `<button class="text-button" type="button" data-task-cancel="${escapeHtml(task.id)}">取消</button>`
    : "";
  return `<div class="task-pill-row"><div class="task-pill-row-head"><span class="task-pill-row-title">${escapeHtml(task.title)}</span><strong>${percent === null ? "处理中" : `${percent}%`}</strong>${cancel}</div>${task.detail ? `<span class="task-pill-detail-text" data-task-detail>${escapeHtml(task.detail)}</span>` : ""}<div class="progress-track${trackClass}"><span data-task-track style="width:${width}"></span></div>${counts ? `<span class="task-pill-count">${counts}</span>` : ""}</div>`;
}

/**
 * 任务胶囊：标题 + 百分比，点击展开明细与取消。
 * 多条任务同时跑时，胶囊只显示队首，其余用 +N 标出。
 */
export function renderTaskPill(): string {
  syncScanTask();
  syncBackupTask();
  const tasks = listTasks();
  if (!tasks.length) {
    taskPillExpanded = false;
    return "";
  }
  const head = tasks[0];
  const percent = taskPercent(head);
  const extra = tasks.length > 1 ? `<span class="task-pill-extra">+${formatCount(tasks.length - 1)}</span>` : "";
  const panel = taskPillExpanded ? `<div class="task-pill-panel">${tasks.map(taskRowHtml).join("")}</div>` : "";
  return `<div class="task-pill${taskPillExpanded ? " is-expanded" : ""}"><button class="task-pill-main" type="button" data-task-toggle="1" aria-expanded="${taskPillExpanded}" aria-label="任务进度">${percent === null ? `<span class="spinner"></span>` : `<span class="task-pill-dot" aria-hidden="true"></span>`}<span class="task-pill-title">${escapeHtml(head.title)}</span><span class="task-pill-percent" data-task-percent>${percent === null ? "发现中" : `${percent}%`}</span>${extra}<span class="task-pill-caret" aria-hidden="true">${taskPillExpanded ? "▴" : "▾"}</span></button>${panel}</div>`;
}

/** 扫描是后台任务，登记进任务表；结束就撤掉，不占错误条。 */
function syncScanTask(): void {
  if (!state.scanning) {
    finishTask("scan");
    return;
  }
  const progress = state.scanProgress;
  const phase = !progress
    ? "准备中"
    : progress.phase === "discovering"
      ? "发现文件"
      : progress.phase === "indexing"
        ? "建立索引"
        : "整理结果";
  upsertTask({
    id: "scan",
    title: "正在扫描媒体库",
    detail: progress?.current ? `${phase} · ${progress.current}` : phase,
    done: progress?.processed,
    total: progress?.total,
  });
}

/**
 * 备份也是后台任务：抽屉关掉后进度不能跟着消失。
 * 这里只登记进度，取消仍走抽屉里的按钮（备份的取消语义比任务表更重）。
 */
function syncBackupTask(): void {
  const progress = state.backupProgress;
  const terminal = Boolean(progress && progress.state !== "running");
  const running = !terminal && (Boolean(state.backupJobId) || progress?.state === "running");
  if (!running) {
    finishTask("backup");
    return;
  }
  const phase = progress?.phase === "merging" ? "合并分段" : "复制文件";
  upsertTask({
    id: "backup",
    title: "正在导入照片",
    detail: progress?.currentFile ? `${phase} · ${progress.currentFile}` : progress ? phase : "准备中",
    done: progress?.fileProcessed,
    total: progress?.fileTotal,
  });
}

/**
 * 删除反馈只负责「进度 → 任务」。进度条原来画在内容流里，滚两屏就丢；
 * 结果 toast 在 app/media-ops.ts 发（render 层不 import app/ 里的动作）。
 */
export function renderDeleteFeedback(): void {
  if (state.deleting && state.deleteProgress) {
    const progress = state.deleteProgress;
    upsertTask({
      id: "delete",
      title: "正在移入回收站",
      detail: progress.current || undefined,
      done: progress.processedFiles,
      total: progress.totalFiles > 0 ? progress.totalFiles : undefined,
    });
    return;
  }
  finishTask("delete");
}

/** 错误条 patch：先同步派生通知，再按缓存写区域。 */
export function patchErrorBar(): void {
  syncStateNotices();
  if (setRegionHtml(region("error-bar"), renderErrorBar())) bindStatusEvents();
}

/** 任务胶囊 patch。 */
export function patchTaskPill(): void {
  if (setRegionHtml(region("task-pill"), renderTaskPill())) bindStatusEvents();
}

/**
 * 扫描进度的高频更新：只改胶囊里的文字与进度轨，不重画整块区域。
 * 胶囊还没建出来（刚进扫描态）时才回落到一次 patchToolbar。
 */
export function updateScanProgressView(): void {
  const progress = state.scanProgress;
  const pill = app.querySelector<HTMLElement>('[data-region="task-pill"] .task-pill');
  if (!progress || !pill) {
    patchToolbar();
    return;
  }
  const percent = taskPercent({ done: progress.processed, total: progress.total });
  setText(pill.querySelector("[data-task-percent]"), percent === null ? "发现中" : `${percent}%`);
  const track = pill.querySelector<HTMLElement>("[data-task-track]");
  if (track) {
    track.style.width = percent === null ? "35%" : `${percent}%`;
    track.parentElement?.classList.toggle("is-indeterminate", percent === null);
  }
  const detail = pill.querySelector<HTMLElement>("[data-task-detail]");
  if (detail && progress.current) setText(detail, progress.current);
}

export function renderSelectionToolbar(): string {
  if (!state.page.total) return "";
  const allSelected = state.selectedIds.size >= state.page.total;
  const tagOptions = state.tags
    .map((tag) => `<option value="${escapeHtml(tag.id)}">${escapeHtml(tag.name)}</option>`)
    .join("");
  const selectedCount = state.selectedIds.size;
  // Items selected beyond the loaded pages (select-all) have no local kind;
  // the video kind filter guarantees them, otherwise judge by loaded rows and
  // let the merge dialog validate the rest.
  const unloadedSelected = Math.max(
    0,
    selectedCount - state.page.items.filter((item) => state.selectedIds.has(item.id)).length,
  );
  const loadedSelectedVideos = state.page.items.filter(
    (item) => state.selectedIds.has(item.id) && item.kind === "video",
  ).length;
  const mergeUnavailable =
    selectedCount < 2
      ? "选择两个及以上视频后可合并"
      : state.kind === "video"
        ? ""
        : unloadedSelected > 0
          ? ""
          : loadedSelectedVideos < selectedCount
            ? "所选项目中包含非视频媒体，无法合并"
            : "";
  const mergeDisabled = Boolean(
    mergeUnavailable ||
    state.mergeBusy ||
    state.mergeJobId ||
    state.deleting ||
    state.favoritesBusy ||
    state.tagsBusy ||
    state.availability !== "available",
  );
  const mergeTitle = mergeUnavailable || "将所选视频按顺序合并为一个新文件";
  const aiEligible = state.page.items.filter((item) => state.selectedIds.has(item.id) && item.kind !== "video");
  const aiDisabled = Boolean(
    state.aiSingleBusy ||
    state.aiJobId ||
    state.availability !== "available" ||
    (selectedCount > 0 && aiEligible.length === 0),
  );
  const aiTitle =
    aiEligible.length === 0 && selectedCount > 0
      ? "所选项目中没有可打标的照片（视频暂不支持）"
      : `对所选 ${formatCount(aiEligible.length)} 张照片执行 AI 打标`;
  return `<div class="selection-toolbar" aria-label="批量选择工具"><button class="selection-button" id="select-current" data-action="select-current-results" type="button">${allSelected ? "取消全选" : "全选当前结果"}</button><span class="selection-summary">${state.selectedIds.size ? `已选 ${formatCount(state.selectedIds.size)} 项 · Shift+点击可范围选择` : "选择媒体后可批量管理 · Shift+点击可范围选择"}</span>${state.selectedIds.size ? `<button class="clear-selection-button" id="clear-selection" data-action="clear-selection" type="button">清除选择</button><button class="selection-button" id="batch-ai-tag" data-action="batch-ai-tag" type="button" title="${escapeHtml(aiTitle)}" ${aiDisabled ? "disabled" : ""}>${state.aiSingleBusy ? `AI ${formatCount(state.aiSingleDone)} / ${formatCount(state.aiSingleTotal)}…` : `✦ AI 打标`}</button><button class="selection-button" id="favorite-selected" data-action="batch-favorite" type="button" ${state.favoritesBusy || state.deleting ? "disabled" : ""}>${state.favoritesBusy ? "收藏中…" : "批量收藏"}</button><button class="selection-button" id="unfavorite-selected" data-action="batch-unfavorite" type="button" ${state.favoritesBusy || state.deleting ? "disabled" : ""}>${state.favoritesBusy ? "处理中…" : "取消收藏"}</button><span class="batch-tag-row"><select id="batch-tag-select" aria-label="批量标签" ${state.tagsBusy || state.deleting ? "disabled" : ""}><option value="">选择标签…</option>${tagOptions}</select><button class="selection-button" id="batch-tag-attach" data-action="batch-tag-attach" type="button" ${state.tagsBusy || state.deleting ? "disabled" : ""}>${state.tagsBusy ? "处理中…" : "打标"}</button><button class="selection-button" id="batch-tag-detach" data-action="batch-tag-detach" type="button" ${state.tagsBusy || state.deleting ? "disabled" : ""}>移除</button><select id="batch-rating-select" aria-label="批量评分" ${state.tagsBusy || state.deleting ? "disabled" : ""}><option value="">评分…</option><option value="1">★</option><option value="2">★★</option><option value="3">★★★</option><option value="4">★★★★</option><option value="5">★★★★★</option><option value="0">清除</option></select><button class="selection-button" id="batch-rating-apply" data-action="batch-rating-apply" type="button" ${state.tagsBusy || state.deleting ? "disabled" : ""}>应用</button></span><button class="selection-button" id="merge-selected" data-action="merge-selected" type="button" title="${escapeHtml(mergeTitle)}" ${mergeDisabled ? "disabled" : ""}>${state.mergeBusy || state.mergeJobId ? "合并中…" : "合并视频"}</button><button class="danger-button" id="delete-selected" data-action="delete-selected" type="button" ${state.deleting || state.favoritesBusy || state.tagsBusy || state.availability !== "available" ? "disabled" : ""}>${state.deleting ? "处理中…" : state.availability !== "available" ? "媒体库不可用" : "移入回收站"}</button>` : ""}</div>`;
}

export function patchToolbar(): void {
  setRegionHtml(region("topbar-title"), titleBlockHtml());
  if (setRegionHtml(region("status"), statusRegionHtml())) bindStatusEvents();
  // 顺序固定：删除进度先落进任务表，再一起 patch 胶囊；错误条独立于两者。
  renderDeleteFeedback();
  patchErrorBar();
  patchTaskPill();
  setRegionHtml(region("filter-row"), renderPrimaryFilters());
  // 条件 chips 与主行分属两个区域：主行是「改」，chips 是「看 + 逐项摘掉」。
  setRegionHtml(region("filter-chips"), renderFilterChips());
  syncToolbarRight();
  syncSearchInput();
  setRegionHtml(region("selection"), renderSelectionToolbar());
  const scanTop = app.querySelector<HTMLButtonElement>("#scan-top-button");
  if (scanTop) {
    const disabled = state.availability !== "available";
    if (scanTop.disabled !== disabled) scanTop.disabled = disabled;
    setText(scanTop, state.scanning ? "扫描中…" : "扫描媒体库");
  }
  // 面板挂在 overlay 槽位，不受上面这些区域 patch 影响；这里只做卸载/定位/同步。
  patchFilterPanel();
}

// ---------------------------------------------------------------------------
// 分区事件绑定
//
// 骨架只建一次、区域按 patch 重建，所以绑定也按区域拆开。每个 binder 内部用
// bind() 做幂等保护：区域重建出来的新节点没有标记，会正常挂上监听器；没被
// 替换的节点直接跳过，不会重复叠加。卡片区与工具栏的 data-action 仍走文件
// 末尾的委托层，这里不重复绑定。
// ---------------------------------------------------------------------------

/** 上一次渲染时搜索框所处的模式：用来判断是否需要强制换掉输入框里的草稿。 */
let renderedSearchMode: SearchMode = searchUi.mode;

/**
 * 搜索框回填 + 外观同步。
 *
 * 值只在没有焦点时写：输入期间覆盖用户正在打的字是最刺眼的一类 bug。
 * 例外是「模式刚变」——那时输入框里是另一套草稿，必须换成本模式的内容，
 * 否则会停在上一模式的词上，看着像词被吞了。
 */
export function syncSearchInput(): void {
  const input = app.querySelector<HTMLInputElement>("#search-input");
  if (!input) return;
  const draft = searchUi.mode === "ai" ? searchUi.semantic : searchUi.draft;
  const modeChanged = renderedSearchMode !== searchUi.mode;
  renderedSearchMode = searchUi.mode;
  if ((document.activeElement !== input || modeChanged) && input.value !== draft) input.value = draft;
  syncSearchChrome();
}

/** 搜索框外观：模式态、占位文案与清空按钮的显隐。 */
export function syncSearchChrome(): void {
  const input = app.querySelector<HTMLInputElement>("#search-input");
  const box = app.querySelector<HTMLElement>("#search-box");
  const clear = app.querySelector<HTMLButtonElement>("#search-clear");
  const mode = app.querySelector<HTMLButtonElement>("#search-mode");
  const ai = searchUi.mode === "ai";
  box?.classList.toggle("is-ai", ai);
  if (input) {
    const placeholder = ai ? "描述你要找的照片，如：去年秋天湖边" : "搜索文件名、标签、描述";
    if (input.placeholder !== placeholder) input.placeholder = placeholder;
    input.setAttribute("aria-label", ai ? "AI 搜索：描述你要找的照片" : "搜索文件名、标签与 AI 描述");
  }
  if (clear) clear.hidden = !(input?.value ?? (ai ? searchUi.semantic : searchUi.draft)).length;
  if (mode) {
    mode.classList.toggle("is-active", ai);
    mode.setAttribute("aria-pressed", String(ai));
    const title = ai ? "切换回普通搜索" : "切换到 AI 搜索";
    if (mode.title !== title) mode.title = title;
    mode.setAttribute("aria-label", title);
  }
}

export function titleBlockHtml(): string {
  const label = primaryDateLabel();
  return `<div class="eyebrow">${label ? `筛选 · ${label}` : "媒体总览"}</div><h1>${label || "所有媒体"}</h1><span class="result-count">${formatCount(state.page.total)} 个项目</span>`;
}

/**
 * 顶栏下方的查询状态区：新导入提示 / AI 搜索条件。
 * 备份入口已迁到侧栏、面板迁到 overlay，这里不再随内容流渲染任何备份 DOM。
 */
export function statusRegionHtml(): string {
  const firstSeen = state.firstSeenFrom
    ? `<div class="notice-banner" role="status"><span class="notice-icon">↓</span><div><strong>正在查看新导入</strong><span>按首次入库时间筛选（备份完成后自动扫描的结果）。可用筛选面板的「重置全部」恢复全部媒体。</span></div></div>`
    : "";
  return `${firstSeen}${renderStatusBanner()}`;
}

/**
 * 排序 / 密度控件只建一次，之后原地同步值。
 * 密度滑块正在被拖动时替换节点会断开 pointer drag，所以这里连重建都不做。
 */
export function syncToolbarRight(): void {
  const host = region("toolbar-right");
  if (!host) return;
  if (!host.firstElementChild) host.innerHTML = toolbarRightHtml();
  const sort = host.querySelector<HTMLSelectElement>("#sort-select");
  if (sort && sort.value !== state.sort) sort.value = state.sort;
  const density = host.querySelector<HTMLInputElement>("#density-input");
  if (density && density.value !== String(state.density)) density.value = String(state.density);
}

export function toolbarRightHtml(): string {
  const option = (value: SortMode, label: string) =>
    `<option value="${value}" ${state.sort === value ? "selected" : ""}>${label}</option>`;
  return `<label class="select-wrap"><span>排序</span><select id="sort-select" data-action="sort-change" aria-label="排序">${option("newest", "最新")}${option("oldest", "最早")}${option("name", "文件名")}${option("rating-desc", "评分高→低")}${option("rating-asc", "评分低→高")}${option("size-desc", "文件大→小")}${option("size-asc", "文件小→大")}</select></label><label class="density-control" title="缩略图密度"><span>▦</span><input id="density-input" data-action="density-input" type="range" min="1" max="5" value="${state.density}" aria-label="缩略图密度" /><span>▦</span></label>`;
}
