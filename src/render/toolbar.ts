// 由 main.ts 拆分而来：仅做搬移，未改动逻辑。
import { listNotices, syncStateNotices, type Notice } from "../app/notices";
import { finishTask, listTasks, taskPercent, upsertTask, type Task } from "../app/tasks";
import { MediaKind, MediaQueryInput, ScanProgressDto, TagDto } from "../api/media";
import { hasAnyFilter, secondaryFilterParts } from "../lib/filters";
import { formatCount, formatRangeLabel } from "../lib/format";
import { SortMode, state } from "../state";
import { renderBackupPanel } from "../views/backup";
import { app, region, setRegionHtml, setText } from "./context";
import { bindStatusEvents, bindToolbarEvents, refreshMedia } from "./paint";
import { escapeHtml, formatDate, groupedFacets } from "./text";

// Keep the text being composed separate from the submitted query so typing
// never refreshes the media grid. This also preserves unsent text on redraws.
/** 搜索框草稿：输入不触发刷新，提交才刷新（与 semantic 分开保存）。 */
export const searchUi = {
  draft: "",
  semantic: "",
};
// Same draft discipline for the semantic (natural-language) search box.
export let tagPopoverOpen = false;

export let tagPopoverQuery = "";

export function hasSecondaryFilter(): boolean {
  return secondaryFilterParts(state).length > 0;
}

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

export function renderPrimaryFilters(): string {
  // 类型 chip 是普通 AND 条件，高亮必须严格等于 state.kind。
  // 收藏 / 连拍 不再影响这里：它们可以和类型同时生效，也不会偷偷改查询。
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
  const secondaryParts = secondaryFilterParts(state);
  const hasSecondary = secondaryParts.length > 0;
  const expanded = state.filtersExpanded;
  const toggleLabel = hasSecondary && !expanded ? `筛选 (${secondaryParts.length})` : expanded ? "筛选" : "筛选";
  const summary =
    hasSecondary && !expanded
      ? `<span class="filter-summary">${escapeHtml(secondaryParts.join(" · "))}</span><button class="text-button clear-summary-filters" data-action="clear-filters" type="button">清除</button>`
      : "";
  return `<div class="filter-group">${kindGroup}</div><span class="filter-divider" aria-hidden="true"></span><button class="filter-chip filter-toggle ${hasSecondary ? "has-active" : ""}" type="button" id="toggle-advanced-filters" data-action="toggle-advanced-filters" aria-expanded="${expanded}" aria-controls="advanced-filters">${toggleLabel}<span class="filter-toggle-caret" aria-hidden="true">${expanded ? "▴" : "▾"}</span></button>${summary}`;
}

/** Inline toolbar chips: selected tags first, then hot tags by media count. */
export function toolbarTagChips(): TagDto[] {
  const selected = state.tags.filter((tag) => state.tagIds.has(tag.id));
  const hot = state.tags
    .filter((tag) => !state.tagIds.has(tag.id))
    .sort((a, b) => (b.mediaCount ?? 0) - (a.mediaCount ?? 0) || a.name.localeCompare(b.name, "zh-Hans-CN"));
  return [...selected, ...hot.slice(0, Math.max(0, 8 - selected.length))];
}

/** Tag count-descending view shared by the popover list and the picker. */
export function sortedTagsByUsage(): TagDto[] {
  return state.tags
    .slice()
    .sort((a, b) => (b.mediaCount ?? 0) - (a.mediaCount ?? 0) || a.name.localeCompare(b.name, "zh-Hans-CN"));
}

export function tagPopoverHtml(): string {
  const rows = sortedTagsByUsage()
    .map(
      (tag) =>
        `<button type="button" class="tag-picker-row ${state.tagIds.has(tag.id) ? "is-active" : ""}" data-tag-popover-row="${escapeHtml(tag.id)}" data-tag-name="${escapeHtml(tag.name.toLowerCase())}"><span class="tag-picker-name">${escapeHtml(tag.name)}${tag.hasAi ? `<i class="ai-badge" aria-label="AI 标签">AI</i>` : ""}</span>${tag.mediaCount != null ? `<span class="tag-picker-count">${formatCount(tag.mediaCount)} 项</span>` : ""}<span class="tag-picker-check" aria-hidden="true">✓</span></button>`,
    )
    .join("");
  return `<div class="tag-popover" id="tag-filter-popover"><div class="tag-picker-search"><span aria-hidden="true">⌕</span><input id="tag-popover-input" type="text" placeholder="搜索标签" value="${escapeHtml(tagPopoverQuery)}" aria-label="搜索标签" /></div><div class="tag-picker-list" id="tag-popover-list">${rows}<div class="tag-picker-empty" data-picker-empty hidden>没有匹配的标签</div></div></div>`;
}

/** Wire search filtering + row toggles for a mounted popover. */
export function bindTagPopover(scope: HTMLElement): void {
  const input = scope.querySelector<HTMLInputElement>("#tag-popover-input");
  if (input) {
    const filterRows = () => {
      const query = input.value.trim().toLowerCase();
      tagPopoverQuery = input.value;
      let visible = 0;
      scope.querySelectorAll<HTMLElement>("#tag-popover-list [data-tag-popover-row]").forEach((row) => {
        const match = !query || (row.dataset.tagName ?? "").includes(query);
        row.hidden = !match;
        if (match) visible += 1;
      });
      const empty = scope.querySelector<HTMLElement>("#tag-popover-list [data-picker-empty]");
      if (empty) empty.hidden = visible > 0;
    };
    input.addEventListener("input", filterRows);
    if (tagPopoverQuery) filterRows();
  }
  scope.querySelectorAll<HTMLButtonElement>("#tag-filter-popover [data-tag-popover-row]").forEach((row) => {
    row.addEventListener("click", () => {
      const tagId = row.dataset.tagPopoverRow;
      if (!tagId) return;
      // 弹层不再随整页重建而卸载，列表滚动位置由 DOM 自己保留。
      if (state.tagIds.has(tagId)) state.tagIds.delete(tagId);
      else state.tagIds.add(tagId);
      void refreshMedia();
    });
  });
}

/** Mount the toolbar tag popover inside .sticky-controls, anchored below the
 * toggle button. Mounting outside .advanced-filters dodges its max-height
 * overflow clipping; the sticky host keeps the anchor stable while scrolling. */
export function mountTagPopover(focusSearch: boolean): void {
  const toggle = app.querySelector<HTMLElement>("#toggle-tag-popover");
  const host = app.querySelector<HTMLElement>(".sticky-controls");
  if (!toggle || !host || host.querySelector("#tag-filter-popover")) return;
  host.insertAdjacentHTML("beforeend", tagPopoverHtml());
  const popover = host.querySelector<HTMLElement>("#tag-filter-popover");
  if (popover) {
    const buttonRect = toggle.getBoundingClientRect();
    const hostRect = host.getBoundingClientRect();
    popover.style.left = `${Math.max(0, Math.round(buttonRect.left - hostRect.left))}px`;
    popover.style.top = `${Math.round(buttonRect.bottom - hostRect.top + 6)}px`;
  }
  bindTagPopover(host);
  if (focusSearch) host.querySelector<HTMLInputElement>("#tag-popover-input")?.focus();
}

/** Remove the popover DOM and reset the toggle button chrome. */
/** 关闭标签筛选弹层：Esc、外部点击、区域 patch 共用同一条路径。 */
export function closeTagFilterPopover(): void {
  tagPopoverOpen = false;
  unmountTagPopover();
}

export function unmountTagPopover(): void {
  app.querySelector("#tag-filter-popover")?.remove();
  const toggle = app.querySelector<HTMLButtonElement>("#toggle-tag-popover");
  if (toggle) {
    toggle.setAttribute("aria-expanded", "false");
    toggle.classList.remove("is-active");
  }
}

/** 高级筛选的内容体；外层 #advanced-filters 容器由 patchToolbar 原地维护。 */
export function renderAdvancedFiltersInner(): string {
  let tagBlock: string;
  if (!state.tags.length) {
    tagBlock = `<div class="filter-group filter-group-tags"><button class="filter-chip filter-chip-manage" type="button" id="open-tag-manager" data-action="open-tag-manager">标签管理</button></div>`;
  } else {
    const inline = toolbarTagChips();
    const chips = inline
      .map(
        (tag) =>
          `<button class="filter-chip filter-chip-tag ${tag.hasAi ? "filter-chip-tag-ai" : ""} ${state.tagIds.has(tag.id) ? "is-active" : ""}" type="button" data-action="filter-tag" data-tag-filter="${escapeHtml(tag.id)}" title="${escapeHtml(tag.name)}${tag.hasAi ? " · 含 AI 标签" : ""}${tag.mediaCount != null ? ` · ${tag.mediaCount} 项` : ""}">${escapeHtml(tag.name)}${tag.hasAi ? `<i class="ai-badge" aria-label="AI 标签">AI</i>` : ""}</button>`,
      )
      .join("");
    // Everything beyond the inline chips stays reachable through the
    // searchable popover instead of a flat (truncated) chip row. The popover
    // itself mounts into .sticky-controls (see mountTagPopover), not here —
    // this container clips overflow.
    const moreButton =
      state.tags.length > inline.length
        ? `<button class="filter-chip filter-chip-more ${tagPopoverOpen ? "is-active" : ""}" type="button" id="toggle-tag-popover" data-action="toggle-tag-popover" aria-expanded="${tagPopoverOpen}" aria-haspopup="true">更多标签 <span class="filter-toggle-caret" aria-hidden="true">${tagPopoverOpen ? "▴" : "▾"}</span></button>`
        : "";
    tagBlock = `<div class="filter-group filter-group-tags"><span class="filter-group-label">标签</span>${chips}${moreButton}<button class="filter-chip filter-chip-manage" type="button" id="open-tag-manager" data-action="open-tag-manager">管理</button></div>`;
  }
  return `<div class="filter-group filter-group-semantic"><span class="filter-group-label">AI</span><div class="search-box semantic-search"><span aria-hidden="true">✦</span><input id="semantic-search-input" value="${escapeHtml(searchUi.semantic)}" placeholder="自然语言找照片，如：去年秋天湖边" aria-label="AI 搜索" /><button class="search-button" id="semantic-search-button" type="button">搜索</button></div></div><span class="filter-divider" aria-hidden="true"></span>${tagBlock}<span class="filter-divider" aria-hidden="true"></span>${renderDateRangeControls()}<span class="filter-divider" aria-hidden="true"></span>${renderRatingFilter()}${hasSecondaryFilter() ? `<button class="text-button advanced-clear" data-action="clear-filters" type="button">清除筛选</button>` : ""}`;
}

export function renderRatingFilter(): string {
  const options = [
    { value: "", label: "全部评分" },
    { value: "eq:5", label: "5 星" },
    { value: "eq:4", label: "4 星" },
    { value: "eq:3", label: "3 星" },
    { value: "eq:2", label: "2 星" },
    { value: "eq:1", label: "1 星" },
    { value: "eq:0", label: "未评分" },
    { value: "min:3", label: "3 星以上" },
    { value: "min:4", label: "4 星以上" },
    { value: "min:5", label: "5 星" },
  ];
  let selected = "";
  if (state.ratingEq !== null) selected = `eq:${state.ratingEq}`;
  else if (state.ratingMin !== null) selected = `min:${state.ratingMin}`;
  return `<label class="select-wrap rating-filter${selected ? " is-active" : ""}"><span>评分</span><select id="rating-filter" data-action="filter-rating" aria-label="评分筛选">${options.map((option) => `<option value="${option.value}" ${selected === option.value ? "selected" : ""}>${option.label}</option>`).join("")}</select></label>`;
}

export function renderDateRangeControls(): string {
  const presets = [
    { id: "month", label: "本月" },
    { id: "year", label: "今年" },
    { id: "days30", label: "最近30天" },
  ];
  return `<div class="date-range" aria-label="日期区间">
    <label><span>从</span><input type="date" id="date-from" data-action="apply-date-range" value="${escapeHtml(state.dateFrom ?? "")}" aria-label="开始日期" /></label>
    <label><span>到</span><input type="date" id="date-to" data-action="apply-date-range" value="${escapeHtml(state.dateTo ?? "")}" aria-label="结束日期" /></label>
    ${presets.map((preset) => `<button class="filter-chip range-preset" type="button" data-action="date-preset" data-range-preset="${preset.id}">${preset.label}</button>`).join("")}
    ${state.dateFrom || state.dateTo ? `<button class="filter-chip" type="button" id="clear-date-range" data-action="clear-date-range">清除区间</button>` : ""}
  </div>`;
}

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
  if (setRegionHtml(region("advanced"), renderAdvancedFiltersInner())) bindToolbarEvents();
  syncAdvancedFiltersVisibility();
  syncToolbarRight();
  syncSearchInput();
  setRegionHtml(region("selection"), renderSelectionToolbar());
  const scanTop = app.querySelector<HTMLButtonElement>("#scan-top-button");
  if (scanTop) {
    const disabled = state.availability !== "available";
    if (scanTop.disabled !== disabled) scanTop.disabled = disabled;
    setText(scanTop, state.scanning ? "扫描中…" : "扫描媒体库");
  }
  patchTagPopover();
}

/**
 * 标签弹层：不再随整页重建而卸载重挂，因此列表滚动位置天然保留。
 * 这里只做两件事——该消失时卸载、选中态原地同步。
 */
export function patchTagPopover(): void {
  if (!tagPopoverOpen) return;
  const toggle = app.querySelector<HTMLElement>("#toggle-tag-popover");
  if (!toggle || state.previewIndex !== null || !state.filtersExpanded) {
    tagPopoverOpen = false;
    unmountTagPopover();
    return;
  }
  toggle.classList.add("is-active");
  toggle.setAttribute("aria-expanded", "true");
  app.querySelectorAll<HTMLElement>("#tag-popover-list [data-tag-popover-row]").forEach((row) => {
    const tagId = row.dataset.tagPopoverRow;
    if (tagId) row.classList.toggle("is-active", state.tagIds.has(tagId));
  });
}

// ---------------------------------------------------------------------------
// 分区事件绑定
//
// 骨架只建一次、区域按 patch 重建，所以绑定也按区域拆开。每个 binder 内部用
// bind() 做幂等保护：区域重建出来的新节点没有标记，会正常挂上监听器；没被
// 替换的节点直接跳过，不会重复叠加。卡片区与工具栏的 data-action 仍走文件
// 末尾的委托层，这里不重复绑定。
// ---------------------------------------------------------------------------

/** 搜索框草稿回填：只在没有焦点时写，输入期间绝不覆盖用户正在打的字。 */
export function syncSearchInput(): void {
  const input = app.querySelector<HTMLInputElement>("#search-input");
  if (!input || document.activeElement === input) return;
  if (input.value !== searchUi.draft) input.value = searchUi.draft;
}

// Registered once at module level: clicking anywhere outside the toolbar tag
// popover (or its toggle button) dismisses it without a full re-render.
document.addEventListener("pointerdown", (event) => {
  if (!tagPopoverOpen) return;
  const target = event.target as HTMLElement | null;
  if (target?.closest("#tag-filter-popover") || target?.closest("#toggle-tag-popover")) return;
  tagPopoverOpen = false;
  unmountTagPopover();
});

export function titleBlockHtml(): string {
  const label = primaryDateLabel();
  const clear = hasAnyFilter(state)
    ? `<button class="text-button clear-all-filters" id="clear-all-filters" data-action="clear-filters" type="button">清除筛选</button>`
    : "";
  return `<div class="eyebrow">${label ? `筛选 · ${label}` : "媒体总览"}</div><h1>${label || "所有媒体"}</h1><span class="result-count">${formatCount(state.page.total)} 个项目</span>${clear}`;
}

/** 顶栏下方的横幅区：新导入提示 / 状态横幅 / 删除反馈 / 备份面板。 */
/** 顶栏下方的查询状态区：新导入提示 / AI 搜索条件 / 备份入口与面板（原位置）。 */
export function statusRegionHtml(): string {
  const firstSeen = state.firstSeenFrom
    ? `<div class="notice-banner" role="status"><span class="notice-icon">↓</span><div><strong>正在查看新导入</strong><span>按首次入库时间筛选（备份完成后自动扫描的结果）。可用「清除筛选」恢复全部媒体。</span></div></div>`
    : "";
  // 备份面板暂时留在原位：它不属于三通道中的任何一条，后续步骤再单独安置。
  const backup = `${state.backupOpen ? "" : `<div class="backup-launcher-row"><button class="outline-button" id="backup-open-button" type="button">相机备份预览</button></div>`}${renderBackupPanel()}`;
  return `${firstSeen}${renderStatusBanner()}${backup}`;
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

export function syncAdvancedFiltersVisibility(): void {
  const advanced = region("advanced");
  if (!advanced) return;
  const hidden = !state.filtersExpanded;
  if (advanced.hidden !== hidden) advanced.hidden = hidden;
  advanced.closest(".toolbar")?.classList.toggle("is-filters-expanded", state.filtersExpanded);
}

export function toggleToolbarTagPopover(): void {
  if (tagPopoverOpen) {
    tagPopoverOpen = false;
    unmountTagPopover();
    return;
  }
  tagPopoverOpen = true;
  mountTagPopover(true);
}

export function toggleAdvancedFilters(): void {
  state.filtersExpanded = !state.filtersExpanded;
  // Collapsing the toolbar hides the popover's anchor; dismiss it first so
  // it cannot float orphaned over the grid.
  if (!state.filtersExpanded && tagPopoverOpen) {
    tagPopoverOpen = false;
    unmountTagPopover();
  }
  patchToolbar();
}

export function toolbarRightHtml(): string {
  const option = (value: SortMode, label: string) =>
    `<option value="${value}" ${state.sort === value ? "selected" : ""}>${label}</option>`;
  return `<label class="select-wrap"><span>排序</span><select id="sort-select" data-action="sort-change" aria-label="排序">${option("newest", "最新")}${option("oldest", "最早")}${option("name", "文件名")}${option("rating-desc", "评分高→低")}${option("rating-asc", "评分低→高")}${option("size-desc", "文件大→小")}${option("size-asc", "文件小→大")}</select></label><label class="density-control" title="缩略图密度"><span>▦</span><input id="density-input" data-action="density-input" type="range" min="1" max="5" value="${state.density}" aria-label="缩略图密度" /><span>▦</span></label>`;
}
