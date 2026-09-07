import {
  type DateFacetDto,
  type LibraryDto,
  type MediaItemDto,
  type MediaKind,
  type MediaPageDto,
  getMediaPreview,
  getMediaItem,
  getMediaThumbnail,
  listDateFacets,
  listLibraries,
  onScanProgress,
  queryMedia,
  setFavorite,
  previewDelete,
  deleteMediaItems,
  discoverBackupSources,
  previewBackup,
  startBackup,
  cancelBackup,
  onBackupProgress,
  startLibraryScan,
  type BackupPreviewDto,
  type BackupVolumeDto,
  type BackupProgressDto,
  type ConflictPolicy,
} from "./api/media";
import { getInfrastructureState, setBackupConflictPolicy, setLibraryRoot, type LibraryAvailability } from "./api/infrastructure";
import type { ScanProgressDto } from "./api/media";

type SortMode = "newest" | "oldest" | "name";
type Density = 1 | 2 | 3 | 4 | 5;

interface AppState {
  availability: LibraryAvailability;
  rootPath: string | null;
  library: LibraryDto | null;
  libraries: LibraryDto[];
  facets: DateFacetDto[];
  page: MediaPageDto;
  search: string;
  kind: MediaKind | undefined;
  favoriteOnly: boolean;
  datePrefix: string | undefined;
  sort: SortMode;
  density: Density;
  loading: boolean;
  scanning: boolean;
  scanProgress: ScanProgressDto | null;
  error: string | null;
  previewIndex: number | null;
  selectedIds: Set<string>;
  favorites: Set<string>;
  deleting: boolean;
  backupOpen: boolean;
  backupSources: BackupVolumeDto[];
  backupPreview: BackupPreviewDto | null;
  backupLoading: boolean;
  backupConflictPolicy: ConflictPolicy;
  backupProgress: BackupProgressDto | null;
  backupJobId: string | null;
  libraryFormOpen: boolean;
}

const state: AppState = {
  availability: "unconfigured",
  rootPath: null,
  library: null,
  libraries: [],
  facets: [],
  page: { items: [], total: 0, offset: 0, limit: 120 },
  search: "",
  kind: undefined,
  favoriteOnly: false,
  datePrefix: undefined,
  sort: "newest",
  density: 3,
  loading: true,
  scanning: false,
  scanProgress: null,
  error: null,
  previewIndex: null,
  selectedIds: new Set(),
  favorites: new Set(),
  deleting: false,
  backupOpen: false,
  backupSources: [],
  backupPreview: null,
  backupLoading: false,
  backupConflictPolicy: "skip_same",
  backupProgress: null,
  backupJobId: null,
  libraryFormOpen: false,
};

const appRoot = document.querySelector<HTMLElement>("#app");
if (!appRoot) throw new Error("找不到应用容器");
const app: HTMLElement = appRoot;
let searchTimer: number | undefined;
let previewRequest = 0;
// Image decoding is intentionally serialized in the backend to cap memory, but
// cache hits are cheap. A wider queue makes warm-cache grids populate in one
// short burst while the visible-first ordering protects cold-cache latency.
const thumbnailConcurrency = 8;
let activeThumbnailRequests = 0;
const thumbnailQueue: Array<{
  id: string;
  resolve: (asset: Awaited<ReturnType<typeof getMediaThumbnail>>) => void;
  reject: (error: unknown) => void;
}> = [];
// Keep successful URL promises for the lifetime of the page. Camlib redraws the
// grid for selection/favorite changes; dropping these used to repeat one IPC +
// Base64 transfer per card after every redraw.
const thumbnailRequests = new Map<string, Promise<Awaited<ReturnType<typeof getMediaThumbnail>>>>();
// The modal must not hand a camera original directly to WebView2. A bounded
// cached preview is large enough for the modal while avoiding failures caused
// by decoding very large textures at their native dimensions.
const modalThumbnailWidth = 1600;
const modalThumbnailRequests = new Map<string, Promise<Awaited<ReturnType<typeof getMediaThumbnail>>>>();

function pumpThumbnailQueue(): void {
  while (activeThumbnailRequests < thumbnailConcurrency && thumbnailQueue.length) {
    const request = thumbnailQueue.shift()!;
    activeThumbnailRequests += 1;
    void getMediaThumbnail(request.id)
      .then(request.resolve, request.reject)
      .finally(() => {
        activeThumbnailRequests -= 1;
        pumpThumbnailQueue();
      })
      .catch(() => undefined);
  }
}

function loadThumbnail(id: string, highPriority = false): Promise<Awaited<ReturnType<typeof getMediaThumbnail>>> {
  const pending = thumbnailRequests.get(id);
  if (pending) {
    if (highPriority) {
      const queuedIndex = thumbnailQueue.findIndex((entry) => entry.id === id);
      if (queuedIndex > 0) thumbnailQueue.unshift(thumbnailQueue.splice(queuedIndex, 1)[0]);
    }
    return pending;
  }
  const request = new Promise<Awaited<ReturnType<typeof getMediaThumbnail>>>((resolve, reject) => {
    const queued = { id, resolve, reject };
    if (highPriority) thumbnailQueue.unshift(queued); else thumbnailQueue.push(queued);
    pumpThumbnailQueue();
  });
  thumbnailRequests.set(id, request);
  void request.catch(() => thumbnailRequests.delete(id));
  return request;
}

function loadModalThumbnail(id: string): Promise<Awaited<ReturnType<typeof getMediaThumbnail>>> {
  const pending = modalThumbnailRequests.get(id);
  if (pending) return pending;
  const request = getMediaThumbnail(id, modalThumbnailWidth);
  modalThumbnailRequests.set(id, request);
  void request.catch(() => modalThumbnailRequests.delete(id));
  return request;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character] ?? character);
}

function formatDate(date: string | null): string {
  if (!date) return "日期未知";
  const parts = date.split("-");
  return parts.length === 3 ? `${parts[0]}年${Number(parts[1])}月${Number(parts[2])}日` : date;
}

function formatCount(value: number): string { return new Intl.NumberFormat("zh-CN").format(value); }
function formatSize(bytes: number): string { return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`; }
function kindLabel(kind: MediaKind): string { return kind === "photo" ? "照片" : kind === "video" ? "视频" : "实况"; }
function selectedPrefix(prefix: string | undefined, value: string): string { return prefix === value ? "is-selected" : ""; }
function facetTotal(): number { return state.facets.reduce((total, facet) => total + facet.count, 0); }

function toggleSelection(id: string): void {
  if (state.selectedIds.has(id)) state.selectedIds.delete(id); else state.selectedIds.add(id);
  render();
}

async function toggleFavorite(id: string): Promise<void> {
  try {
    const details = await getMediaItem(id);
    await setFavorite(id, !details.favorite);
    if (details.favorite) state.favorites.delete(id); else state.favorites.add(id);
    render();
  } catch (error) {
    state.error = error instanceof Error ? error.message : "更新收藏失败";
    render();
  }
}

function groupedFacets(): Array<{ year: string; count: number; months: Array<{ month: string; count: number; dates: DateFacetDto[] }> }> {
  const years = new Map<string, { count: number; months: Map<string, { count: number; dates: DateFacetDto[] }> }>();
  for (const facet of state.facets) {
    const [year, month] = facet.date.split("-");
    if (!year || !month) continue;
    const yearGroup = years.get(year) ?? { count: 0, months: new Map() };
    const monthGroup = yearGroup.months.get(month) ?? { count: 0, dates: [] };
    yearGroup.count += facet.count;
    monthGroup.count += facet.count;
    monthGroup.dates.push(facet);
    yearGroup.months.set(month, monthGroup);
    years.set(year, yearGroup);
  }
  return [...years.entries()]
    .sort(([left], [right]) => right.localeCompare(left))
    .map(([year, value]) => ({
      year,
      count: value.count,
      months: [...value.months.entries()]
        .sort(([left], [right]) => right.localeCompare(left))
        .map(([month, monthValue]) => ({
          month,
          count: monthValue.count,
          dates: [...monthValue.dates].sort((left, right) => right.date.localeCompare(left.date)),
        })),
    }));
}

function renderDateNavigation(): string {
  if (!state.facets.length) return `<div class="nav-empty">扫描后会在这里显示年月</div>`;
  return `<div class="date-tree">
    <button class="date-link all-link ${state.datePrefix ? "" : "is-selected"}" data-prefix="" type="button"><span>全部媒体</span><span>${formatCount(facetTotal())}</span></button>
    ${groupedFacets().map((yearGroup) => `<section class="year-group">
      <button class="date-link year-link ${selectedPrefix(state.datePrefix, yearGroup.year)}" data-prefix="${yearGroup.year}" type="button"><span>${yearGroup.year} 年</span><span>${formatCount(yearGroup.count)}</span></button>
      <div class="month-list">${yearGroup.months.map((monthGroup) => {
        const monthPrefix = `${yearGroup.year}-${monthGroup.month}`;
        return `<div class="month-group"><button class="date-link month-link ${selectedPrefix(state.datePrefix, monthPrefix)}" data-prefix="${monthPrefix}" type="button"><span>${Number(monthGroup.month)} 月</span><span>${formatCount(monthGroup.count)}</span></button><div class="day-list">${monthGroup.dates.map((facet) => `<button class="day-link ${selectedPrefix(state.datePrefix, facet.date)}" data-prefix="${facet.date}" type="button"><span>${Number(facet.date.slice(-2))} 日</span><span>${facet.count}</span></button>`).join("")}</div></div>`;
      }).join("")}</div>
    </section>`).join("")}
  </div>`;
}

function renderCard(item: MediaItemDto, index: number): string {
  const isVideo = item.kind === "video";
  return `<article class="media-card ${state.selectedIds.has(item.id) ? "is-selected" : ""}" data-id="${escapeHtml(item.id)}" data-index="${index}" tabindex="0" role="button" aria-label="打开${escapeHtml(item.displayName)}">
    <div class="card-preview ${isVideo ? "is-video" : ""}" data-preview="${escapeHtml(item.id)}">${isVideo ? `<span class="video-placeholder"><span class="play-mark">▶</span><span>视频</span></span>` : `<span class="preview-loading">加载预览</span>`}<button class="card-select ${state.selectedIds.has(item.id) ? "is-checked" : ""}" data-select="${escapeHtml(item.id)}" type="button" aria-label="选择${escapeHtml(item.displayName)}">${state.selectedIds.has(item.id) ? "✓" : ""}</button><button class="card-favorite ${state.favorites.has(item.id) ? "is-favorite" : ""}" data-favorite="${escapeHtml(item.id)}" type="button" aria-label="收藏${escapeHtml(item.displayName)}">★</button><span class="kind-badge kind-${item.kind}">${kindLabel(item.kind)}</span>${item.scanState !== "present" ? `<span class="state-badge">${item.scanState === "missing" ? "离线" : "需检查"}</span>` : ""}</div>
    <div class="card-info"><div class="card-title" title="${escapeHtml(item.displayName)}">${escapeHtml(item.displayName)}</div><div class="card-meta"><span>${formatDate(item.captureDate)}</span><span>${formatSize(item.totalSizeBytes)}</span></div></div>
  </article>`;
}

function renderMediaGrid(): string {
  const groups = new Map<string, MediaItemDto[]>();
  for (const item of state.page.items) {
    const key = item.captureDate ?? "unknown";
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  let index = 0;
  return [...groups.entries()].map(([date, items]) => `<section class="media-day-group"><header class="day-heading"><h2>${date === "unknown" ? "日期未知" : formatDate(date)}</h2><span>${items.length} 个项目</span></header><div class="media-grid">${items.map((item) => renderCard(item, index++)).join("")}</div></section>`).join("");
}

function renderKindFilters(): string {
  const kinds = ([{ value: undefined, label: "全部" }, { value: "photo" as MediaKind, label: "照片" }, { value: "video" as MediaKind, label: "视频" }, { value: "live" as MediaKind, label: "实况" }]).map((filter) => `<button class="filter-chip ${state.kind === filter.value && !state.favoriteOnly ? "is-active" : ""}" type="button" data-kind="${filter.value ?? ""}">${filter.label}</button>`).join("");
  return `${kinds}<button class="filter-chip ${state.favoriteOnly ? "is-active" : ""}" type="button" id="favorite-filter">收藏</button>`;
}

function renderStatusBannerBase(): string {
  if (state.scanning && state.scanProgress) {
    const progress = state.scanProgress.total > 0 ? Math.round((state.scanProgress.processed / state.scanProgress.total) * 100) : 0;
    const phase = state.scanProgress.phase === "discovering" ? "发现文件" : state.scanProgress.phase === "indexing" ? "建立索引" : "整理结果";
    const status = state.scanProgress.total > 0 ? `正在扫描媒体库 · ${phase}` : `正在扫描媒体库 · 已发现 ${formatCount(state.scanProgress.processed)} 个文件`;
    const progressLabel = state.scanProgress.total > 0 ? `${progress}%` : "发现中";
    const trackClass = state.scanProgress.total > 0 ? "" : " is-indeterminate";
    const trackWidth = state.scanProgress.total > 0 ? `${progress}%` : "35%";
    return `<div class="scan-banner" id="scan-progress-banner" role="status"><div class="scan-copy"><span class="spinner"></span><span data-scan-phase>${status}</span><strong data-scan-percent>${progressLabel}</strong></div><div class="progress-track${trackClass}"><span data-scan-track style="width:${trackWidth}"></span></div><div class="scan-current" data-scan-current>${state.scanProgress.current ? escapeHtml(state.scanProgress.current) : ""}</div></div>`;
  }
  if (state.availability === "disconnected") return `<div class="notice-banner is-warning"><span class="notice-icon">!</span><div><strong>媒体库已断开</strong><span>${escapeHtml(state.rootPath ?? "原媒体库")} 不可用。连接设备后点击重新扫描。</span></div><button class="text-button" id="rescan-button" type="button">重新扫描</button></div>`;
  if (state.availability === "invalid") return `<div class="notice-banner is-warning"><span class="notice-icon">!</span><div><strong>媒体库路径无效</strong><span>请重新设置一个可访问的媒体库目录。</span></div></div>`;
  if (state.error) return `<div class="notice-banner is-error"><span class="notice-icon">!</span><span>${escapeHtml(state.error)}</span></div>`;
  return "";
}

function updateScanProgressView(): void {
  const progress = state.scanProgress;
  const banner = app.querySelector<HTMLElement>("#scan-progress-banner");
  if (!progress || !banner) {
    render();
    return;
  }
  const percent = progress.total > 0 ? Math.round((progress.processed / progress.total) * 100) : 0;
  const phase = progress.phase === "discovering" ? "发现文件" : progress.phase === "indexing" ? "建立索引" : "整理结果";
  banner.querySelector<HTMLElement>("[data-scan-phase]")!.textContent = progress.total > 0 ? `正在扫描媒体库 · ${phase}` : `正在扫描媒体库 · 已发现 ${formatCount(progress.processed)} 个文件`;
  banner.querySelector<HTMLElement>("[data-scan-percent]")!.textContent = progress.total > 0 ? `${percent}%` : "发现中";
  const track = banner.querySelector<HTMLElement>("[data-scan-track]")!;
  track.style.width = progress.total > 0 ? `${percent}%` : "35%";
  track.parentElement!.classList.toggle("is-indeterminate", progress.total <= 0);
  banner.querySelector<HTMLElement>("[data-scan-current]")!.textContent = progress.current ?? "";
}

function renderBackupPanel(): string {
  if (!state.backupOpen) return "";
  const preview = state.backupPreview;
  const progress = state.backupProgress;
  const progressPercent = progress && progress.bytesTotal > 0 ? Math.round(progress.bytesProcessed / progress.bytesTotal * 100) : 0;
  return `<section class="backup-panel" aria-label="相机备份预览"><div class="backup-heading"><div><strong>相机备份</strong><span>确认预览后才复制；相机源盘始终只读</span></div><button class="icon-button" id="close-backup" type="button" aria-label="关闭备份预览">×</button></div><div class="backup-form"><label><span>源相机盘</span><select id="backup-source" ${state.backupLoading || state.backupJobId ? "disabled" : ""}>${state.backupSources.length ? state.backupSources.map((source) => `<option value="${escapeHtml(source.id)}">${escapeHtml(source.volumeLabel || source.rootPath)} · ${escapeHtml(source.rootPath)}</option>`).join("") : "<option>未发现包含 DCIM 的可移动盘</option>"}</select></label><label><span>目标媒体库</span><select id="backup-target" ${state.backupJobId ? "disabled" : ""}>${state.libraries.map((library) => `<option value="${escapeHtml(library.id)}" ${library.id === state.library?.id ? "selected" : ""}>${escapeHtml(library.volumeLabel || library.rootPath)}</option>`).join("")}</select></label><label><span>冲突策略（设置）</span><select id="backup-conflict" ${state.backupLoading || state.backupJobId ? "disabled" : ""}><option value="skip_same" ${state.backupConflictPolicy === "skip_same" ? "selected" : ""}>跳过冲突</option><option value="rename" ${state.backupConflictPolicy === "rename" ? "selected" : ""}>自动重命名</option><option value="overwrite" ${state.backupConflictPolicy === "overwrite" ? "selected" : ""}>覆盖目标</option></select></label><label><span>忽略扩展名</span><input id="backup-ignore" value=".dng, .lrv" aria-label="忽略扩展名" ${state.backupJobId ? "disabled" : ""} /></label><button class="primary-button" id="backup-preview-button" type="button" ${state.backupLoading || state.backupJobId || !state.backupSources.length || !state.libraries.length ? "disabled" : ""}>${state.backupLoading ? "处理中…" : "生成预览"}</button></div>${preview ? `<div class="backup-summary"><span>素材 ${formatCount(preview.totalFiles)}</span><span>总大小 ${formatSize(preview.totalBytes)}</span><span>可导入 ${formatCount(preview.readyFiles)}</span><span>已存在 ${formatCount(preview.alreadyExistsFiles)}</span><span>冲突 ${formatCount(preview.conflictFiles)}</span><span>忽略 ${formatCount(preview.ignoredFiles)}</span><span class="${preview.spaceSufficient === false ? "is-danger" : ""}">空间 ${preview.freeBytes === null ? "不可用" : preview.spaceSufficient ? "充足" : "不足"}</span></div><div class="backup-note">${preview.spaceSufficient === false ? "目标盘剩余空间不足，预览已记录但不会执行复制。" : `预览记录 ${escapeHtml(preview.backupRunId)}；请确认后开始复制。`}</div><div class="backup-actions"><button class="primary-button" id="backup-start-button" type="button" ${state.backupJobId || state.backupLoading || preview.spaceSufficient === false ? "disabled" : ""}>确认预览并开始备份</button></div>` : ""}${progress ? `<div class="scan-banner" role="status"><div class="scan-copy"><span class="spinner"></span><span>备份${progress.state === "completed" ? "完成" : progress.state === "cancelled" ? "已取消" : progress.state === "failed" ? "失败" : "中"}</span><strong>${progressPercent}%</strong></div><div class="progress-track"><span style="width:${progressPercent}%"></span></div><div class="scan-current">${escapeHtml(progress.currentFile || "准备中")} · ${progress.speedBytesPerSec} B/秒${progress.etaSeconds === null ? "" : ` · 剩余约 ${progress.etaSeconds} 秒`}</div>${progress.state === "running" ? `<button class="text-button" id="backup-cancel-button" type="button">取消备份</button>` : ""}${progress.error ? `<div class="backup-note is-danger">${escapeHtml(progress.error)}</div>` : ""}</div>` : ""}</section>`;
}

function renderStatusBanner(): string {
  return `${renderStatusBannerBase()}${state.backupOpen ? "" : `<div class="backup-launcher-row"><button class="outline-button" id="backup-open-button" type="button">相机备份预览</button></div>`}${renderBackupPanel()}`;
}

function renderSelectionToolbar(): string {
  if (!state.page.total) return "";
  return `<div class="selection-toolbar"><button class="text-button" id="select-current" type="button">${state.selectedIds.size >= state.page.total ? "取消全选" : "当前结果全选"}</button><span>${state.selectedIds.size ? `已选 ${formatCount(state.selectedIds.size)} 项` : "可选择媒体进行管理"}</span>${state.selectedIds.size ? `<button class="danger-button" id="delete-selected" type="button">${state.deleting ? "处理中…" : "移入回收站"}</button>` : ""}</div>`;
}

function renderLibraryEmpty(): string {
  if (state.loading) return `<div class="empty-state"><span class="empty-icon spinner large"></span><h2>正在读取媒体库</h2><p>正在从 Tauri 后端加载索引。</p></div>`;
  if (state.availability === "unconfigured") return `<div class="empty-state setup-state"><span class="empty-icon">⌂</span><h2>还没有媒体库</h2><p>输入一个本地媒体目录，Camlib 会建立可搜索的索引。</p><form id="library-form" class="library-form"><input id="library-path" required placeholder="例如：D:\\照片" aria-label="媒体库路径" /><button class="primary-button" type="submit">连接媒体库</button></form></div>`;
  if (!state.library) return `<div class="empty-state"><span class="empty-icon">◎</span><h2>找不到媒体库记录</h2><p>请重新连接媒体库。</p></div>`;
  if (!state.page.total) return `<div class="empty-state"><span class="empty-icon">✦</span><h2>${state.search || state.kind || state.datePrefix || state.favoriteOnly ? "没有匹配的媒体" : "媒体库还是空的"}</h2><p>${state.search || state.kind || state.datePrefix || state.favoriteOnly ? "试试调整搜索或筛选条件。" : "点击右上角“扫描媒体库”开始建立索引。"}</p></div>`;
  return "";
}

function renderLibrarySwitcher(): string {
  if (!state.libraryFormOpen || !state.library) return "";
  return `<form id="library-form" class="library-form library-change-form"><label for="library-path">媒体库目录</label><input id="library-path" required value="${escapeHtml(state.rootPath ?? state.library.rootPath)}" placeholder="例如：D:\\照片" aria-label="媒体库路径" /><div class="library-form-actions"><button class="text-button" id="library-cancel-button" type="button">取消</button><button class="primary-button" type="submit">确认更换</button></div></form>`;
}

function render(): void {
  const hasItems = state.page.items.length > 0;
  app.style.setProperty("--tile-min", `${[150, 185, 220, 260, 310][state.density - 1]}px`);
  app.innerHTML = `<div class="shell"><aside class="sidebar" aria-label="媒体库导航">
    <div class="brand"><span class="brand-mark">C</span><div><strong>Camlib</strong><span>媒体库</span></div></div>
    <div class="sidebar-section library-section"><div class="section-label"><span>媒体库</span>${state.library ? `<span class="section-actions"><button class="icon-button" id="change-library-button" title="更换媒体库" aria-label="更换媒体库">⇄</button><button class="icon-button" id="refresh-button" title="刷新状态" aria-label="刷新状态">↻</button></span>` : ""}</div>${state.library ? `<div class="library-entry ${state.availability !== "available" ? "is-offline" : ""}"><span class="drive-icon">▣</span><div><strong>${escapeHtml(state.library.volumeLabel || state.library.driveLetter ? `${state.library.volumeLabel ?? "本地磁盘"} ${state.library.driveLetter ? `(${state.library.driveLetter}:)` : ""}` : "已连接媒体库")}</strong><span>${state.availability === "available" ? `${formatCount(facetTotal())} 个媒体` : "暂时不可用"}</span></div><span class="status-dot"></span></div>${renderLibrarySwitcher()}` : `<div class="library-entry is-empty"><span class="drive-icon">＋</span><div><strong>添加媒体库</strong><span>选择一个目录开始</span></div></div>`}</div>
    <nav class="sidebar-section date-section" aria-label="按日期浏览"><div class="section-label"><span>按日期浏览</span></div>${renderDateNavigation()}</nav>
    <div class="sidebar-footer"><span class="footer-dot"></span><span>${state.availability === "available" ? "索引已连接" : state.availability === "unconfigured" ? "等待连接" : "等待设备"}</span><button class="icon-button" title="扫描媒体库" id="scan-button" aria-label="扫描媒体库">⟳</button></div>
  </aside><main class="content">
    <header class="topbar"><div class="title-block"><div class="eyebrow">${state.datePrefix ? `筛选 · ${formatDate(state.datePrefix)}` : "媒体总览"}</div><h1>${state.datePrefix ? formatDate(state.datePrefix) : "所有媒体"}</h1><span class="result-count">${formatCount(state.page.total)} 个项目</span></div><div class="top-actions"><label class="search-box"><span>⌕</span><input id="search-input" value="${escapeHtml(state.search)}" placeholder="搜索文件名" aria-label="搜索文件名" /><kbd>/</kbd></label><button class="outline-button" id="scan-top-button" type="button">${state.scanning ? "扫描中…" : "扫描媒体库"}</button></div></header>
    ${renderStatusBanner()}<div class="toolbar"><div class="filter-row">${renderKindFilters()}</div><div class="toolbar-right"><label class="select-wrap"><span>排序</span><select id="sort-select" aria-label="排序"><option value="newest" ${state.sort === "newest" ? "selected" : ""}>最新</option><option value="oldest" ${state.sort === "oldest" ? "selected" : ""}>最早</option><option value="name" ${state.sort === "name" ? "selected" : ""}>文件名</option></select></label><label class="density-control" title="缩略图密度"><span>▦</span><input id="density-input" type="range" min="1" max="5" value="${state.density}" aria-label="缩略图密度" /><span>▦</span></label></div></div>${renderSelectionToolbar()}
    <section class="media-area" aria-live="polite">${hasItems ? `${renderMediaGrid()}${state.page.total > state.page.items.length ? `<button class="load-more" id="load-more" type="button">加载更多 · 已显示 ${state.page.items.length} / ${state.page.total}</button>` : ""}` : renderLibraryEmpty()}</section></main></div>${state.previewIndex !== null ? renderPreview() : ""}`;
  bindEvents();
  if (hasItems) observePreviews();
}

function renderPreview(): string {
  const item = state.page.items[state.previewIndex ?? 0];
  if (!item) return "";
  return `<div class="modal-backdrop" id="preview-modal"><div class="preview-modal" role="dialog" aria-modal="true" aria-label="${escapeHtml(item.displayName)}"><button class="modal-close" id="close-preview" type="button" aria-label="关闭">×</button><button class="modal-nav prev" id="preview-prev" type="button" aria-label="上一个">‹</button><div class="modal-media" id="modal-media"><span class="spinner large"></span></div><button class="modal-nav next" id="preview-next" type="button" aria-label="下一个">›</button><div class="modal-caption"><div><strong>${escapeHtml(item.displayName)}</strong><span>${kindLabel(item.kind)} · ${formatDate(item.captureDate)} · ${formatSize(item.totalSizeBytes)}</span></div></div></div></div>`;
}

function bindEvents(): void {
  app.querySelectorAll<HTMLButtonElement>("[data-prefix]").forEach((button) => button.addEventListener("click", () => { state.datePrefix = button.dataset.prefix || undefined; void refreshMedia(); }));
  app.querySelectorAll<HTMLButtonElement>("[data-kind]").forEach((button) => button.addEventListener("click", () => { state.kind = (button.dataset.kind || undefined) as MediaKind | undefined; void refreshMedia(); }));
  app.querySelector<HTMLButtonElement>("#favorite-filter")?.addEventListener("click", () => { state.favoriteOnly = !state.favoriteOnly; void refreshMedia(); });
  const searchInput = app.querySelector<HTMLInputElement>("#search-input");
  searchInput?.addEventListener("input", () => { state.search = searchInput.value; window.clearTimeout(searchTimer); searchTimer = window.setTimeout(() => void refreshMedia(), 250); });
  app.querySelector<HTMLSelectElement>("#sort-select")?.addEventListener("change", (event) => { state.sort = (event.target as HTMLSelectElement).value as SortMode; void refreshMedia(); });
  app.querySelector<HTMLInputElement>("#density-input")?.addEventListener("input", (event) => { state.density = Number((event.target as HTMLInputElement).value) as Density; render(); });
  app.querySelector<HTMLButtonElement>("#scan-button")?.addEventListener("click", () => void scanLibrary());
  app.querySelector<HTMLButtonElement>("#scan-top-button")?.addEventListener("click", () => void scanLibrary());
  app.querySelector<HTMLButtonElement>("#backup-open-button")?.addEventListener("click", () => void openBackupPanel());
  app.querySelector<HTMLButtonElement>("#close-backup")?.addEventListener("click", () => { state.backupOpen = false; render(); });
  app.querySelector<HTMLButtonElement>("#backup-preview-button")?.addEventListener("click", () => void createBackupPreview());
  app.querySelector<HTMLSelectElement>("#backup-conflict")?.addEventListener("change", (event) => void saveBackupConflict((event.target as HTMLSelectElement).value as ConflictPolicy));
  app.querySelector<HTMLButtonElement>("#backup-start-button")?.addEventListener("click", () => void startConfirmedBackup());
  app.querySelector<HTMLButtonElement>("#backup-cancel-button")?.addEventListener("click", () => void cancelCurrentBackup());
  app.querySelector<HTMLButtonElement>("#refresh-button")?.addEventListener("click", () => void bootstrap());
  app.querySelector<HTMLButtonElement>("#change-library-button")?.addEventListener("click", () => { state.libraryFormOpen = !state.libraryFormOpen; render(); app.querySelector<HTMLInputElement>("#library-path")?.focus(); });
  app.querySelector<HTMLButtonElement>("#library-cancel-button")?.addEventListener("click", () => { state.libraryFormOpen = false; render(); });
  app.querySelector<HTMLButtonElement>("#rescan-button")?.addEventListener("click", () => void scanLibrary());
  app.querySelector<HTMLButtonElement>("#load-more")?.addEventListener("click", () => void loadMore());
  app.querySelector<HTMLButtonElement>("#select-current")?.addEventListener("click", () => void selectCurrentResults());
  app.querySelector<HTMLButtonElement>("#delete-selected")?.addEventListener("click", () => void deleteSelected());
  app.querySelector<HTMLFormElement>("#library-form")?.addEventListener("submit", (event) => { event.preventDefault(); const input = app.querySelector<HTMLInputElement>("#library-path"); if (input?.value.trim()) void connectLibrary(input.value.trim()); });
  app.querySelectorAll<HTMLElement>(".media-card").forEach((card) => {
    const open = () => { state.previewIndex = Number(card.dataset.index); render(); void loadModalAsset(); };
    card.addEventListener("click", open);
    card.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); open(); } });
  });
  app.querySelectorAll<HTMLButtonElement>("[data-select]").forEach((button) => button.addEventListener("click", (event) => { event.stopPropagation(); toggleSelection(button.dataset.select!); }));
  app.querySelectorAll<HTMLButtonElement>("[data-favorite]").forEach((button) => button.addEventListener("click", (event) => { event.stopPropagation(); void toggleFavorite(button.dataset.favorite!); }));
  app.querySelector<HTMLButtonElement>("#close-preview")?.addEventListener("click", closePreview);
  app.querySelector<HTMLElement>("#preview-modal")?.addEventListener("click", (event) => { if (event.target === event.currentTarget) closePreview(); });
  app.querySelector<HTMLButtonElement>("#preview-prev")?.addEventListener("click", () => movePreview(-1));
  app.querySelector<HTMLButtonElement>("#preview-next")?.addEventListener("click", () => movePreview(1));
}

function observePreviews(): void {
  const cards = [...app.querySelectorAll<HTMLElement>("[data-preview]")];
  const load = (card: HTMLElement, highPriority = false) => {
    if (card.dataset.loaded === "true") return;
    card.dataset.loaded = "true";
    const id = card.dataset.preview;
    if (!id) return;
    void loadThumbnail(id, highPriority).then((asset) => {
      const target = [...app.querySelectorAll<HTMLElement>("[data-preview]")].find((element) => element.dataset.preview === id);
      const item = state.page.items.find((entry) => entry.id === id);
      if (!target || !item) return;
      target.classList.add("has-preview");
      target.querySelector(".preview-loading, .video-placeholder")?.remove();
      const image = document.createElement("img");
      image.src = asset.url;
      image.alt = "";
      image.decoding = "async";
      target.prepend(image);
      if (item.kind === "video" && !target.querySelector(".video-overlay")) {
        const overlay = document.createElement("span");
        overlay.className = "video-overlay";
        overlay.textContent = "▶";
        target.append(overlay);
      }
    }).catch(() => {
      const target = app.querySelector<HTMLElement>(`[data-preview="${CSS.escape(id)}"]`);
      target?.querySelector(".preview-loading, .video-placeholder")?.remove();
      target?.insertAdjacentHTML("afterbegin", `<span class="preview-fallback">预览不可用</span>`);
    });
  };
  // Start the actual viewport synchronously and put it ahead of work left over
  // from a previous filter/page. The observer then prefetches the next rows.
  cards.filter((card) => {
    const rect = card.getBoundingClientRect();
    return rect.bottom >= 0 && rect.top <= window.innerHeight;
  }).reverse().forEach((card) => load(card, true));
  if ("IntersectionObserver" in window) {
    const observer = new IntersectionObserver((entries) => entries.forEach((entry) => { if (entry.isIntersecting) { load(entry.target as HTMLElement, entry.intersectionRatio > 0); observer.unobserve(entry.target); } }), { rootMargin: "320px" });
    cards.forEach((card) => observer.observe(card));
  } else cards.slice(0, 24).forEach((card) => load(card));
}

async function loadModalAsset(): Promise<void> {
  const item = state.previewIndex === null ? undefined : state.page.items[state.previewIndex];
  if (!item) return;
  const request = ++previewRequest;
  try {
    const preview = await getMediaPreview(item.id);
    if (request !== previewRequest || state.previewIndex === null) return;
    const media = app.querySelector<HTMLElement>("#modal-media");
    if (!media) return;
    const photo = preview.sources.find((source) => source.role === "photo" || (source.role === "single" && !source.mimeType.startsWith("video/")));
    const video = preview.sources.find((source) => source.role === "video" || (source.role === "single" && source.mimeType.startsWith("video/")));
    const photoPreview = photo ? await loadModalThumbnail(item.id) : undefined;
    if (request !== previewRequest || state.previewIndex === null) return;
    if (item.kind === "live" && photo && video) {
      media.innerHTML = `<div class="live-preview"><img src="${photoPreview?.url ?? photo.url}" alt="${escapeHtml(item.displayName)}" /><video src="${video.url}" controls autoplay muted loop playsinline></video></div>`;
    } else if (video) {
      media.innerHTML = `<video src="${video.url}" controls autoplay playsinline></video>`;
    } else if (photoPreview) {
      media.innerHTML = `<img src="${photoPreview.url}" alt="${escapeHtml(item.displayName)}" />`;
    } else {
      media.innerHTML = `<span class="preview-fallback">当前文件不可用</span>`;
    }
  } catch { const media = app.querySelector<HTMLElement>("#modal-media"); if (request === previewRequest && media) media.innerHTML = `<span class="preview-fallback">当前文件不可用</span>`; }
}

function closePreview(): void { state.previewIndex = null; render(); }
function movePreview(delta: number): void { if (state.previewIndex === null || !state.page.items.length) return; state.previewIndex = (state.previewIndex + delta + state.page.items.length) % state.page.items.length; render(); void loadModalAsset(); }

async function refreshMedia(): Promise<void> {
  if (!state.library) { render(); return; }
  state.loading = true; state.error = null; render();
  try { state.page = await queryMedia({ libraryId: state.library.id, kind: state.kind, favoriteOnly: state.favoriteOnly, search: state.search, datePrefix: state.datePrefix, limit: 120, sort: state.sort }); state.selectedIds.clear(); const favoriteEntries = await Promise.all(state.page.items.map(async (item) => [item.id, (await getMediaItem(item.id)).favorite] as const)); state.favorites = new Set(favoriteEntries.filter(([, favorite]) => favorite).map(([id]) => id)); }
  catch (error) { state.error = error instanceof Error ? error.message : "读取媒体索引失败"; }
  finally { state.loading = false; render(); }
}

async function loadMore(): Promise<void> {
  if (!state.library || state.page.items.length >= state.page.total) return;
  try { const next = await queryMedia({ libraryId: state.library.id, kind: state.kind, favoriteOnly: state.favoriteOnly, search: state.search, datePrefix: state.datePrefix, offset: state.page.items.length, limit: 120, sort: state.sort }); state.page.items.push(...next.items); const favoriteEntries = await Promise.all(next.items.map(async (item) => [item.id, (await getMediaItem(item.id)).favorite] as const)); favoriteEntries.filter(([, favorite]) => favorite).forEach(([id]) => state.favorites.add(id)); render(); }
  catch (error) { state.error = error instanceof Error ? error.message : "加载更多媒体失败"; render(); }
}

async function selectCurrentResults(): Promise<void> {
  if (!state.library) return;
  if (state.selectedIds.size >= state.page.total) { state.selectedIds.clear(); render(); return; }
  try {
    const ids = new Set<string>();
    for (let offset = 0; offset < state.page.total; offset += 500) {
      const page = await queryMedia({ libraryId: state.library.id, kind: state.kind, favoriteOnly: state.favoriteOnly, search: state.search, datePrefix: state.datePrefix, offset, limit: 500, sort: state.sort });
      page.items.forEach((item) => ids.add(item.id));
      if (!page.items.length) break;
    }
    state.selectedIds = ids;
    render();
  } catch (error) { state.error = error instanceof Error ? error.message : "选择当前结果失败"; render(); }
}

async function deleteSelected(): Promise<void> {
  if (!state.library || !state.selectedIds.size || state.deleting) return;
  const ids = [...state.selectedIds];
  state.deleting = true; render();
  try {
    const preview = await previewDelete(state.library.id, ids);
    const summary = preview.summary.slice(0, 8).join("\n") + (preview.summary.length > 8 ? "\n…" : "");
    const confirmed = window.confirm(`将 ${preview.mediaCount} 个媒体项（${preview.fileCount} 个文件，${formatSize(preview.totalSizeBytes)}）移入 Windows 回收站。\n\n文件摘要：\n${summary}\n\n此操作可从回收站恢复，是否继续？`);
    if (!confirmed) return;
    const result = await deleteMediaItems(state.library.id, ids);
    if (result.errors.length) state.error = `已处理 ${result.filesRecycled} 个文件，但 ${result.failedFiles} 个文件失败：${result.errors.join("；")}`;
    else state.error = null;
    state.selectedIds.clear();
    await refreshMedia();
  } catch (error) { state.error = error instanceof Error ? error.message : "删除媒体失败"; }
  finally { state.deleting = false; render(); }
}

async function connectLibrary(path: string): Promise<void> {
  state.loading = true; state.error = null; render();
  try { await setLibraryRoot(path); state.libraryFormOpen = false; await bootstrap(); }
  catch (error) { state.error = error instanceof Error ? error.message : "连接媒体库失败"; state.loading = false; render(); }
}

async function openBackupPanel(): Promise<void> {
  state.backupOpen = true;
  state.backupPreview = null;
  state.backupLoading = true;
  render();
  try {
    state.backupSources = await discoverBackupSources();
  } catch (error) {
    state.error = error instanceof Error ? error.message : "发现相机盘失败";
  } finally {
    state.backupLoading = false;
    render();
  }
}

async function createBackupPreview(): Promise<void> {
  const source = app.querySelector<HTMLSelectElement>("#backup-source")?.value;
  const target = app.querySelector<HTMLSelectElement>("#backup-target")?.value;
  if (!source || !target) return;
  const ignore = app.querySelector<HTMLInputElement>("#backup-ignore")?.value
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  state.backupLoading = true;
  state.error = null;
  render();
  try {
    state.backupPreview = await previewBackup({ sourceVolumeId: source, targetLibraryId: target, conflictPolicy: state.backupConflictPolicy, ignoreExtensions: ignore });
  } catch (error) {
    state.error = error instanceof Error ? error.message : "生成备份预览失败";
  } finally {
    state.backupLoading = false;
    render();
  }
}

async function saveBackupConflict(policy: ConflictPolicy): Promise<void> {
  try {
    const settings = await setBackupConflictPolicy(policy);
    state.backupConflictPolicy = settings.backup_conflict_policy;
    render();
  } catch (error) {
    state.error = error instanceof Error ? error.message : "保存冲突策略失败";
    render();
  }
}

async function startConfirmedBackup(): Promise<void> {
  const preview = state.backupPreview;
  if (!preview || state.backupJobId) return;
  const confirmed = window.confirm(`将按预览复制 ${formatCount(preview.readyFiles + (preview.conflictFiles && preview.conflictPolicy !== "skip_same" ? preview.conflictFiles : 0))} 个文件（${formatSize(preview.requiredBytes)}）。\n\n相机源文件不会被删除、移动或修改。是否开始备份？`);
  if (!confirmed) return;
  state.backupLoading = true; state.error = null; render();
  try {
    const start = await startBackup(preview.backupRunId, preview.id);
    state.backupJobId = start.jobId;
    state.backupProgress = null;
  } catch (error) {
    state.error = error instanceof Error ? error.message : "无法开始备份";
  } finally { state.backupLoading = false; render(); }
}

async function cancelCurrentBackup(): Promise<void> {
  if (!state.backupJobId) return;
  try { await cancelBackup(state.backupJobId); } catch (error) { state.error = error instanceof Error ? error.message : "无法取消备份"; render(); }
}

async function scanLibrary(): Promise<void> {
  if (!state.library || state.scanning) return;
  state.error = null; state.scanning = true; state.scanProgress = null; render();
  try { const start = await startLibraryScan(state.library.id); state.scanProgress = { jobId: start.jobId, kind: "scan", seq: 0, phase: "discovering", state: "running", current: null, processed: 0, total: 0, errors: [], error: null }; render(); }
  catch (error) { state.scanning = false; state.error = error instanceof Error ? error.message : "无法开始扫描"; render(); }
}

async function bootstrap(): Promise<void> {
  state.loading = true; state.error = null; render();
  try {
    const [infra, libraries] = await Promise.all([getInfrastructureState(), listLibraries()]);
    state.backupConflictPolicy = infra.settings.backup_conflict_policy;
    state.libraries = libraries; state.availability = infra.library_status.availability; state.rootPath = infra.library_status.root_path; state.library = libraries.find((library) => library.rootPath === infra.library_status.root_path) ?? libraries[0] ?? null;
    if (state.library && state.availability === "available") { state.facets = await listDateFacets(state.library.id); await refreshMedia(); }
    else { state.page = { items: [], total: 0, offset: 0, limit: 120 }; state.facets = []; state.loading = false; render(); }
  } catch (error) { state.loading = false; state.error = error instanceof Error ? error.message : "初始化媒体库失败"; render(); }
}

window.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && state.previewIndex !== null) { closePreview(); return; }
  if (state.previewIndex !== null && (event.key === "ArrowLeft" || event.key === "ArrowUp")) { event.preventDefault(); movePreview(-1); return; }
  if (state.previewIndex !== null && (event.key === "ArrowRight" || event.key === "ArrowDown")) { event.preventDefault(); movePreview(1); return; }
  if (event.key === "/" && document.activeElement?.tagName !== "INPUT") { event.preventDefault(); app.querySelector<HTMLInputElement>("#search-input")?.focus(); }
});

void onScanProgress((progress) => {
  if (progress.state === "running" && (!state.scanProgress || progress.jobId !== state.scanProgress.jobId)) { state.scanning = true; state.scanProgress = progress; render(); return; }
  if (!state.scanProgress || progress.jobId !== state.scanProgress.jobId) return;
  state.scanProgress = progress;
  if (progress.state === "completed" || progress.state === "cancelled" || progress.state === "failed") { state.scanning = false; if (progress.state === "failed") state.error = progress.error ?? "扫描失败"; render(); void bootstrap(); } else updateScanProgressView();
});
void onBackupProgress((progress) => {
  if (!state.backupJobId || progress.jobId !== state.backupJobId) return;
  state.backupProgress = progress;
  if (progress.state !== "running") { state.backupJobId = null; if (progress.state === "failed") state.error = progress.error ?? "备份失败"; }
  render();
});
void bootstrap();
