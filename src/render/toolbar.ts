// 由 main.ts 拆分而来：仅做搬移，未改动逻辑。
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
  // Type tabs are exclusive with 收藏/连拍 secondary filters, matching the
  // original 收藏 rule so switching tabs always replaces the whole filter set.
  const secondaryActive = state.favoriteOnly || state.burstOnly;
  const kinds = [
    { value: undefined, label: "全部" },
    { value: "photo" as MediaKind, label: "照片" },
    { value: "video" as MediaKind, label: "视频" },
    { value: "live" as MediaKind, label: "实况" },
  ]
    .map(
      (filter) =>
        `<button class="filter-chip ${state.kind === filter.value && !secondaryActive ? "is-active" : ""}" type="button" data-action="filter-kind" data-kind="${filter.value ?? ""}">${filter.label}</button>`,
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
  return `<div class="filter-group filter-group-semantic"><span class="filter-group-label">语义</span><div class="search-box semantic-search"><span aria-hidden="true">✦</span><input id="semantic-search-input" value="${escapeHtml(searchUi.semantic)}" placeholder="自然语言找照片，如：去年秋天湖边" aria-label="语义搜索" /><button class="search-button" id="semantic-search-button" type="button">搜索</button></div></div><span class="filter-divider" aria-hidden="true"></span>${tagBlock}<span class="filter-divider" aria-hidden="true"></span>${renderDateRangeControls()}<span class="filter-divider" aria-hidden="true"></span>${renderRatingFilter()}${hasSecondaryFilter() ? `<button class="text-button advanced-clear" data-action="clear-filters" type="button">清除筛选</button>` : ""}`;
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

export function renderStatusBannerBase(): string {
  if (state.semanticSearch) {
    const meta = state.semanticMeta;
    const modeLabel =
      state.semanticMode === "vector"
        ? "向量检索"
        : state.semanticMode === "text"
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
    if (meta?.keywords) conditions.push(`语义「${meta.keywords}」`);
    return `<div class="notice-banner is-info" role="status"><span class="notice-icon">✦</span><div><strong>语义搜索：${escapeHtml(state.semanticSearch)}</strong><span>${escapeHtml(`模式：${modeLabel}${conditions.length ? ` · 解析条件：${conditions.join("，")}` : ""}。结果由 AI 检索决定，不叠加其他筛选。`)}</span></div><button class="text-button" id="exit-semantic-search" type="button">退出语义搜索</button></div>`;
  }
  if (state.scanning && state.scanProgress) {
    const progress =
      state.scanProgress.total > 0 ? Math.round((state.scanProgress.processed / state.scanProgress.total) * 100) : 0;
    const status = scanStatusLabel(state.scanProgress);
    const progressLabel = scanPercentLabel(state.scanProgress);
    const trackClass = state.scanProgress.total > 0 ? "" : " is-indeterminate";
    const trackWidth = state.scanProgress.total > 0 ? `${progress}%` : "35%";
    return `<div class="scan-banner" id="scan-progress-banner" role="status"><div class="scan-copy"><span class="spinner"></span><span data-scan-phase>${status}</span><strong data-scan-percent>${progressLabel}</strong><button class="text-button" id="scan-cancel-button" type="button">取消</button></div><div class="progress-track${trackClass}"><span data-scan-track style="width:${trackWidth}"></span></div><div class="scan-current" data-scan-current>${state.scanProgress.current ? escapeHtml(state.scanProgress.current) : ""}</div></div>`;
  }
  if (state.availability === "disconnected")
    return `<div class="notice-banner is-warning"><span class="notice-icon">!</span><div><strong>媒体库已断开</strong><span>${escapeHtml(state.rootPath ?? "原媒体库")} 不可用。已禁用扫描、删除、缩略图重建与备份目标写入。请重新连接磁盘，或在设置中更换媒体库路径。</span></div><button class="text-button" id="rescan-button" type="button">重新检测</button></div>`;
  if (state.availability === "invalid")
    return `<div class="notice-banner is-warning"><span class="notice-icon">!</span><div><strong>媒体库路径无效</strong><span>当前卷与记录的媒体库不一致。请在设置中重新选择可访问的媒体库目录。</span></div><button class="text-button" id="open-settings-from-banner" type="button">打开设置</button></div>`;
  if (state.error)
    return `<div class="notice-banner is-error" role="alert"><span class="notice-icon">!</span><span>${escapeHtml(state.error)}</span><button class="text-button" id="dismiss-state-error" type="button">关闭</button></div>`;
  if (state.recentTaskNotice)
    return `<div class="notice-banner is-info"><span class="notice-icon">i</span><div><strong>最近任务</strong><span>${escapeHtml(state.recentTaskNotice)}</span></div><button class="text-button" id="dismiss-recent-task" type="button">知道了</button></div>`;
  if (state.ffmpegMissing && !state.ffmpegHintDismissed)
    return `<div class="notice-banner is-info" id="ffmpeg-hint" role="status"><span class="notice-icon">i</span><div><strong>缺少 ffmpeg</strong><span>视频缩略图与部分预览需要 ffmpeg：在终端运行 winget install ffmpeg 即可，装完重启 Camlib 生效。已安装则忽略这行提示。</span></div><button class="text-button" id="dismiss-ffmpeg-hint" type="button">知道了</button></div>`;
  return "";
}

export function updateScanProgressView(): void {
  const progress = state.scanProgress;
  const banner = app.querySelector<HTMLElement>("#scan-progress-banner");
  if (!progress || !banner) {
    // 横幅还没渲染出来（例如刚进入扫描态），补一次横幅区即可。
    patchToolbar();
    return;
  }
  banner.querySelector<HTMLElement>("[data-scan-phase]")!.textContent = scanStatusLabel(progress);
  banner.querySelector<HTMLElement>("[data-scan-percent]")!.textContent = scanPercentLabel(progress);
  const track = banner.querySelector<HTMLElement>("[data-scan-track]")!;
  track.style.width = progress.total > 0 ? `${Math.round((progress.processed / progress.total) * 100)}%` : "35%";
  track.parentElement!.classList.toggle("is-indeterminate", progress.total <= 0);
  banner.querySelector<HTMLElement>("[data-scan-current]")!.textContent = progress.current ?? "";
}

export function renderStatusBanner(): string {
  return `${renderStatusBannerBase()}${state.backupOpen ? "" : `<div class="backup-launcher-row"><button class="outline-button" id="backup-open-button" type="button">相机备份预览</button></div>`}${renderBackupPanel()}`;
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

export function renderDeleteFeedback(): string {
  if (state.deleteProgress && state.deleting) {
    const progress = state.deleteProgress;
    const percent = progress.totalFiles > 0 ? Math.round((progress.processedFiles / progress.totalFiles) * 100) : 0;
    const trackClass = progress.totalFiles > 0 ? "" : " is-indeterminate";
    const trackWidth = progress.totalFiles > 0 ? `${percent}%` : "35%";
    return `<div class="scan-banner delete-progress-banner" role="status" aria-live="polite"><div class="scan-copy"><span class="spinner"></span><span>正在移入 Windows 回收站</span><strong>${progress.totalFiles > 0 ? `${formatCount(progress.processedFiles)} / ${formatCount(progress.totalFiles)} 个文件` : "处理中…"}</strong></div><div class="progress-track${trackClass}"><span style="width:${trackWidth}"></span></div>${progress.current ? `<div class="scan-current">${escapeHtml(progress.current)}</div>` : ""}</div>`;
  }
  if (state.deleteResult) {
    const result = state.deleteResult;
    const hasFailures = result.failedFiles > 0;
    const title = hasFailures ? "删除部分完成" : "已移入回收站";
    const summary = `媒体 ${formatCount(result.mediaCount)} 项 · 成功回收 ${formatCount(result.filesRecycled)} 个文件 · 本就缺失 ${formatCount(result.filesAlreadyMissing)} · 失败 ${formatCount(result.failedFiles)}`;
    const errors = result.errors.length
      ? `<ul class="delete-error-list">${result.errors
          .slice(0, 12)
          .map((error) => `<li>${escapeHtml(error)}</li>`)
          .join(
            "",
          )}${result.errors.length > 12 ? `<li>…以及另外 ${formatCount(result.errors.length - 12)} 条错误</li>` : ""}</ul>`
      : "";
    return `<div class="notice-banner ${hasFailures ? "is-warning" : "is-success"}" role="status" aria-live="polite"><span class="notice-icon">${hasFailures ? "!" : "✓"}</span><div><strong>${title}</strong><span>${summary}</span>${errors}<span class="delete-recover-hint">文件在 Windows 回收站中，可随时恢复。</span></div><button class="text-button" id="dismiss-delete-result" type="button">知道了</button></div>`;
  }
  if (state.deleteNotice) {
    return `<div class="notice-banner is-success" role="status" aria-live="polite"><span class="notice-icon">✓</span><span>${escapeHtml(state.deleteNotice)}</span><button class="text-button" id="dismiss-delete-notice" type="button">关闭</button></div>`;
  }
  return "";
}

export function patchToolbar(): void {
  setRegionHtml(region("topbar-title"), titleBlockHtml());
  if (setRegionHtml(region("status"), statusRegionHtml())) bindStatusEvents();
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
export function statusRegionHtml(): string {
  const firstSeen = state.firstSeenFrom
    ? `<div class="notice-banner" role="status"><span class="notice-icon">↓</span><div><strong>正在查看新导入</strong><span>按首次入库时间筛选（备份完成后自动扫描的结果）。可用「清除筛选」恢复全部媒体。</span></div></div>`
    : "";
  return `${firstSeen}${renderStatusBanner()}${renderDeleteFeedback()}`;
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
