import {
  type DateFacetDto,
  type DeletePreviewDto,
  type DeleteProgressDto,
  type DeleteResultDto,
  type LibraryDto,
  type MediaItemDto,
  type MediaKind,
  type MediaQueryInput,
  type MediaPageDto,
  type MediaPreviewDto,
  type PreviewMetaDto,
  getMediaPreview,
  getMediaThumbnail,
  listDateFacets,
  listLibraries,
  onDeleteProgress,
  onScanProgress,
  queryMedia,
  setFavorite,
  setFavoritesBatch,
  openMediaFolder,
  previewDelete,
  deleteMediaItems,
  discoverBackupSources,
  previewBackup,
  startBackup,
  cancelBackup,
  onBackupProgress,
  retryFailedBackup,
  listBackupHistory,
  listBackupRunItems,
  startLibraryScan,
  cancelLibraryScan,
  type BackupPreviewDto,
  type BackupVolumeDto,
  type BackupProgressDto,
  type BackupRunDto,
  type BackupItemDto,
  type ConflictPolicy,
} from "./api/media";
import {
  getInfrastructureState,
  setAutoScanOnStartup,
  setBackupConflictPolicy,
  setLibraryRoot,
  setUiPrefs,
  type LibraryAvailability,
  type UiSortMode,
} from "./api/infrastructure";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import type { ScanProgressDto } from "./api/media";

type SortMode = UiSortMode;
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
  burstOnly: boolean;
  datePrefix: string | undefined;
  dateFrom: string | undefined;
  dateTo: string | undefined;
  /** Years whose month list is visible in the sidebar. */
  expandedYears: Set<string>;
  /** Months whose day list is visible in the sidebar. */
  expandedMonths: Set<string>;
  sort: SortMode;
  density: Density;
  loading: boolean;
  scanning: boolean;
  scanProgress: ScanProgressDto | null;
  error: string | null;
  previewIndex: number | null;
  selectedIds: Set<string>;
  favorites: Set<string>;
  favoritePendingIds: Set<string>;
  favoritesBusy: boolean;
  lastSelectIndex: number | null;
  deleting: boolean;
  deleteConfirm: { preview: DeletePreviewDto; ids: string[] } | null;
  deleteProgress: DeleteProgressDto | null;
  deleteResult: DeleteResultDto | null;
  deleteNotice: string | null;
  backupOpen: boolean;
  backupSources: BackupVolumeDto[];
  backupPreview: BackupPreviewDto | null;
  backupLoading: boolean;
  backupConflictPolicy: ConflictPolicy;
  backupProgress: BackupProgressDto | null;
  backupJobId: string | null;
  backupSourceId: string | null;
  backupTargetId: string | null;
  backupIgnoreExtensions: string;
  backupHistory: BackupRunDto[];
  backupFailedItems: BackupItemDto[];
  backupHistoryItems: BackupItemDto[];
  backupExpandedRunId: string | null;
  backupLastRunId: string | null;
  backupRetrying: boolean;
  firstSeenFrom: string | null;
  libraryFormOpen: boolean;
  autoScanOnStartup: boolean;
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
  burstOnly: false,
  datePrefix: undefined,
  dateFrom: undefined,
  dateTo: undefined,
  expandedYears: new Set(),
  expandedMonths: new Set(),
  sort: "newest",
  density: 3,
  loading: true,
  scanning: false,
  scanProgress: null,
  error: null,
  previewIndex: null,
  selectedIds: new Set(),
  favorites: new Set(),
  favoritePendingIds: new Set(),
  favoritesBusy: false,
  lastSelectIndex: null,
  deleting: false,
  deleteConfirm: null,
  deleteProgress: null,
  deleteResult: null,
  deleteNotice: null,
  backupOpen: false,
  backupSources: [],
  backupPreview: null,
  backupLoading: false,
  backupConflictPolicy: "skip_same",
  backupProgress: null,
  backupJobId: null,
  backupSourceId: null,
  backupTargetId: null,
  backupIgnoreExtensions: ".dng, .lrv",
  backupHistory: [],
  backupFailedItems: [],
  backupHistoryItems: [],
  backupExpandedRunId: null,
  backupLastRunId: null,
  backupRetrying: false,
  firstSeenFrom: null,
  libraryFormOpen: false,
  autoScanOnStartup: true,
};

const appRoot = document.querySelector<HTMLElement>("#app");
if (!appRoot) throw new Error("找不到应用容器");
const app: HTMLElement = appRoot;
// Keep the text being composed separate from the submitted query so typing
// never refreshes the media grid. This also preserves unsent text on redraws.
let searchDraft = "";
// Bootstrap re-runs after every scan terminal event. Auto-scan must only fire
// for the first successful launch of this session so completion cannot loop.
let startupAutoScanStarted = false;
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
// Neighbor preview prefetch: cache the IPC response and warm only a couple of
// futures so rapid arrow navigation never piles up unbounded work.
const previewAssetCache = new Map<string, Promise<MediaPreviewDto>>();
const previewPrefetchQueue: string[] = [];
const previewPrefetchLimit = 2;
let activePreviewPrefetches = 0;
let previewRequest = 0;
// Modal UI flags that must survive partial DOM updates (not full re-renders).
let previewInfoOpen = false;
let livePlaying = false;
// Bumps on every full refresh so in-flight load-more/select-all pages from a
// previous filter cannot append into the new result set.
let mediaQueryToken = 0;

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

function requestPreview(id: string): Promise<MediaPreviewDto> {
  const pending = previewAssetCache.get(id);
  if (pending) return pending;
  const request = getMediaPreview(id);
  previewAssetCache.set(id, request);
  void request.catch(() => previewAssetCache.delete(id));
  return request;
}

function pumpPreviewPrefetch(): void {
  while (activePreviewPrefetches < previewPrefetchLimit && previewPrefetchQueue.length) {
    const id = previewPrefetchQueue.shift();
    if (!id || previewAssetCache.has(id)) continue;
    activePreviewPrefetches += 1;
    const request = getMediaPreview(id);
    previewAssetCache.set(id, request);
    void request
      .catch(() => previewAssetCache.delete(id))
      .finally(() => {
        activePreviewPrefetches -= 1;
        pumpPreviewPrefetch();
      });
  }
}

function neighborIds(index: number): string[] {
  const items = state.page.items;
  if (!items.length || index < 0 || index >= items.length) return [];
  const total = items.length;
  const candidates = [index - 1, index + 1, index - 2, index + 2].map(
    (offset) => (offset + total * 2) % total,
  );
  const seen = new Set<number>();
  const ids: string[] = [];
  for (const neighbor of candidates) {
    if (neighbor === index || seen.has(neighbor)) continue;
    seen.add(neighbor);
    const id = items[neighbor]?.id;
    if (id) ids.push(id);
  }
  return ids;
}

function prefetchPreviewNeighbors(index: number): void {
  for (const id of neighborIds(index)) {
    if (previewAssetCache.has(id) || previewPrefetchQueue.includes(id)) continue;
    previewPrefetchQueue.push(id);
    // Warm the large modal still in parallel so photo previews pop instantly.
    void loadModalThumbnail(id).catch(() => undefined);
  }
  pumpPreviewPrefetch();
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes ? `${minutes}:${String(seconds).padStart(2, "0")}` : `${seconds}秒`;
}

function formatCaptureAt(value: string | null): string | null {
  if (!value) return null;
  if (value.startsWith("unix-ms:")) {
    const ms = Number(value.slice("unix-ms:".length));
    if (Number.isFinite(ms)) {
      const date = new Date(ms);
      if (!Number.isNaN(date.getTime())) return date.toLocaleString("zh-CN");
    }
  }
  return value;
}

function formatDimensions(meta: PreviewMetaDto): string {
  if (meta.width && meta.height) return `${meta.width} × ${meta.height}`;
  return "尺寸未知";
}

function fileRoleLabel(role: string): string {
  if (role === "live_photo") return "实况照片";
  if (role === "live_video") return "实况视频";
  return "主文件";
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
function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "未知";
  if (bytes < 1024) return `${Math.max(0, Math.round(bytes))} B`;
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes < 1024 ** 4) return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  return `${(bytes / 1024 ** 4).toFixed(2)} TB`;
}
function formatSpeed(bytesPerSec: number): string {
  if (!Number.isFinite(bytesPerSec) || bytesPerSec <= 0) return "估算中";
  return `${formatSize(bytesPerSec)}/秒`;
}
function formatEtaSeconds(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return "估算中";
  if (seconds < 60) return `约 ${Math.ceil(seconds)} 秒`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  if (minutes < 60) return `约 ${minutes} 分 ${rest} 秒`;
  const hours = Math.floor(minutes / 60);
  return `约 ${hours} 小时 ${minutes % 60} 分`;
}
function conflictPolicyLabel(policy: ConflictPolicy): string {
  return policy === "rename" ? "自动重命名" : policy === "overwrite" ? "覆盖目标" : "跳过冲突";
}
function backupStatusLabel(status: BackupRunDto["status"]): string {
  if (status === "completed") return "成功";
  if (status === "failed") return "失败";
  if (status === "cancelled") return "已取消";
  if (status === "running") return "进行中";
  return "预览";
}
function willCopyCount(preview: BackupPreviewDto): number {
  return preview.readyFiles + (preview.conflictPolicy === "skip_same" ? 0 : preview.conflictFiles);
}
function kindLabel(kind: MediaKind): string { return kind === "photo" ? "照片" : kind === "video" ? "视频" : "实况"; }
function selectedPrefix(prefix: string | undefined, value: string): string { return prefix === value ? "is-selected" : ""; }
function facetTotal(): number { return state.facets.reduce((total, facet) => total + facet.count, 0); }

function hasDateFilter(): boolean {
  return Boolean(state.datePrefix || state.dateFrom || state.dateTo);
}

function hasAnyFilter(): boolean {
  return Boolean(state.search || state.kind || state.datePrefix || state.dateFrom || state.dateTo || state.favoriteOnly || state.burstOnly || state.firstSeenFrom);
}

function formatRangeLabel(): string {
  if (state.dateFrom && state.dateTo) return `${state.dateFrom} ~ ${state.dateTo}`;
  if (state.dateFrom) return `自 ${state.dateFrom}`;
  if (state.dateTo) return `至 ${state.dateTo}`;
  return "";
}

function primaryDateLabel(): string {
  if (state.firstSeenFrom) return "新导入";
  if (state.datePrefix) return formatDate(state.datePrefix);
  if (state.dateFrom || state.dateTo) return formatRangeLabel();
  return "";
}

function currentQueryFields(): Pick<
  MediaQueryInput,
  "libraryId" | "kind" | "favoriteOnly" | "burstOnly" | "search" | "datePrefix" | "dateFrom" | "dateTo" | "firstSeenFrom" | "sort"
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
    sort: state.sort,
  };
}

function resetSidebarExpansionForSelection(): void {
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

function scrollToContentTop(): void {
  const content = app.querySelector<HTMLElement>(".content");
  if (content) content.scrollTop = 0;
  window.scrollTo?.(0, 0);
}

function bindSelectionToolbarEvents(): void {
  app.querySelector<HTMLButtonElement>("#select-current")?.addEventListener("click", () => void selectCurrentResults());
  app.querySelector<HTMLButtonElement>("#clear-selection")?.addEventListener("click", () => {
    state.selectedIds.clear();
    state.lastSelectIndex = null;
    applySelectionChrome();
  });
  app.querySelector<HTMLButtonElement>("#delete-selected")?.addEventListener("click", () => void requestDeleteSelected());
  app.querySelector<HTMLButtonElement>("#favorite-selected")?.addEventListener("click", () => void applyBatchFavorite(true));
  app.querySelector<HTMLButtonElement>("#unfavorite-selected")?.addEventListener("click", () => void applyBatchFavorite(false));
}

/** Patch selection UI without rebuilding the grid (avoids thumbnail flicker). */
function applySelectionChrome(): void {
  app.querySelectorAll<HTMLElement>(".media-card").forEach((card) => {
    const id = card.dataset.id;
    if (!id) return;
    const selected = state.selectedIds.has(id);
    card.classList.toggle("is-selected", selected);
    const button = card.querySelector<HTMLButtonElement>(".card-select");
    if (!button) return;
    button.classList.toggle("is-checked", selected);
    button.setAttribute("aria-pressed", String(selected));
    button.setAttribute("aria-label", selected ? "取消选择" : "选择");
  });
  const sticky = app.querySelector<HTMLElement>(".sticky-controls");
  if (!sticky) return;
  const nextHtml = renderSelectionToolbar();
  const existing = sticky.querySelector<HTMLElement>(".selection-toolbar");
  if (!nextHtml) {
    existing?.remove();
    return;
  }
  if (existing) existing.outerHTML = nextHtml;
  else sticky.insertAdjacentHTML("beforeend", nextHtml);
  bindSelectionToolbarEvents();
}

function updateFavoriteButton(id: string): void {
  const favorite = state.favorites.has(id);
  const pending = state.favoritePendingIds.has(id);
  const button = [...app.querySelectorAll<HTMLButtonElement>("[data-favorite]")]
    .find((entry) => entry.dataset.favorite === id);
  if (!button) return;
  button.classList.toggle("is-favorite", favorite);
  button.classList.toggle("is-pending", pending);
  button.disabled = pending;
  button.setAttribute("aria-pressed", String(favorite));
  button.setAttribute("aria-busy", String(pending));
}

function toggleSelection(id: string, index: number, range = false): void {
  if (range && state.lastSelectIndex !== null) {
    const start = Math.min(state.lastSelectIndex, index);
    const end = Math.max(state.lastSelectIndex, index);
    for (let i = start; i <= end; i += 1) {
      const item = state.page.items[i];
      if (item) state.selectedIds.add(item.id);
    }
    // The range end becomes the next anchor so chained Shift+clicks extend.
    state.lastSelectIndex = index;
    applySelectionChrome();
    return;
  }
  if (state.selectedIds.has(id)) state.selectedIds.delete(id); else state.selectedIds.add(id);
  state.lastSelectIndex = index;
  applySelectionChrome();
}

async function toggleFavorite(id: string): Promise<void> {
  if (state.favoritePendingIds.has(id)) return;
  const wasFavorite = state.favorites.has(id);
  state.favoritePendingIds.add(id);
  updateFavoriteButton(id);
  try {
    await setFavorite(id, !wasFavorite);
    if (wasFavorite) {
      state.favorites.delete(id);
      // An item removed from the current "favorites" result should disappear
      // immediately instead of leaving a stale card until the next refresh.
      if (state.favoriteOnly) {
        state.page.items = state.page.items.filter((item) => item.id !== id);
        state.page.total = Math.max(0, state.page.total - 1);
        state.selectedIds.delete(id);
        render();
        return;
      }
    } else {
      state.favorites.add(id);
    }
    updateFavoriteButton(id);
  } catch (error) {
    state.error = error instanceof Error ? error.message : "更新收藏失败";
    render();
  } finally {
    state.favoritePendingIds.delete(id);
    updateFavoriteButton(id);
  }
}

async function applyBatchFavorite(favorite: boolean): Promise<void> {
  if (!state.selectedIds.size || state.favoritesBusy) return;
  const ids = [...state.selectedIds];
  state.favoritesBusy = true;
  state.error = null;
  applySelectionChrome();
  try {
    await setFavoritesBatch(ids, favorite);
    for (const id of ids) {
      if (favorite) state.favorites.add(id);
      else {
        state.favorites.delete(id);
        if (state.favoriteOnly) state.selectedIds.delete(id);
      }
      updateFavoriteButton(id);
    }
    if (!favorite && state.favoriteOnly) {
      const removed = new Set(ids);
      state.page.items = state.page.items.filter((item) => !removed.has(item.id));
      state.page.total = Math.max(0, state.page.total - removed.size);
    }
    state.deleteNotice = favorite
      ? `已收藏 ${formatCount(ids.length)} 项`
      : `已取消收藏 ${formatCount(ids.length)} 项`;
  } catch (error) {
    state.error = error instanceof Error ? error.message : "批量更新收藏失败";
  } finally {
    state.favoritesBusy = false;
    if ((!favorite && state.favoriteOnly) || state.error) {
      render();
      return;
    }
    applySelectionChrome();
    showTransientNotice(state.deleteNotice ?? "");
    state.deleteNotice = null;
  }
}

/** Lightweight success toast that does not rebuild the media grid. */
function showTransientNotice(message: string): void {
  if (!message) return;
  app.querySelector("#batch-notice")?.remove();
  const sticky = app.querySelector(".sticky-controls");
  if (!sticky) return;
  sticky.insertAdjacentHTML(
    "afterend",
    `<div class="notice-banner is-success" id="batch-notice" role="status"><span class="notice-icon">✓</span><span>${escapeHtml(message)}</span><button class="text-button" id="dismiss-batch-notice" type="button">关闭</button></div>`,
  );
  app.querySelector<HTMLButtonElement>("#dismiss-batch-notice")?.addEventListener("click", () => {
    app.querySelector("#batch-notice")?.remove();
  });
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
    <button class="date-link all-link ${!hasDateFilter() ? "is-selected" : ""}" data-prefix="" type="button"><span>全部媒体</span><span>${formatCount(facetTotal())}</span></button>
    ${groupedFacets().map((yearGroup) => {
      const yearExpanded = state.expandedYears.has(yearGroup.year);
      return `<section class="year-group ${yearExpanded ? "is-expanded" : ""}">
      <div class="year-row">
        <button class="icon-button tree-toggle" type="button" data-year-toggle="${yearGroup.year}" aria-label="${yearExpanded ? "折叠" : "展开"} ${yearGroup.year} 年" aria-expanded="${yearExpanded}">${yearExpanded ? "▾" : "▸"}</button>
        <button class="date-link year-link ${selectedPrefix(state.datePrefix, yearGroup.year)}" data-prefix="${yearGroup.year}" type="button"><span>${yearGroup.year} 年</span><span>${formatCount(yearGroup.count)}</span></button>
      </div>
      ${yearExpanded ? `<div class="month-list">${yearGroup.months.map((monthGroup) => {
        const monthPrefix = `${yearGroup.year}-${monthGroup.month}`;
        const monthExpanded = state.expandedMonths.has(monthPrefix);
        return `<div class="month-group ${monthExpanded ? "is-expanded" : ""}">
          <div class="month-row">
            <button class="icon-button tree-toggle" type="button" data-month-toggle="${monthPrefix}" aria-label="${monthExpanded ? "折叠" : "展开"} ${Number(monthGroup.month)} 月" aria-expanded="${monthExpanded}">${monthExpanded ? "▾" : "▸"}</button>
            <button class="date-link month-link ${selectedPrefix(state.datePrefix, monthPrefix)}" data-prefix="${monthPrefix}" type="button"><span>${Number(monthGroup.month)} 月</span><span>${formatCount(monthGroup.count)}</span></button>
          </div>
          ${monthExpanded ? `<div class="day-list">${monthGroup.dates.map((facet) => `<button class="day-link ${selectedPrefix(state.datePrefix, facet.date)}" data-prefix="${facet.date}" type="button"><span>${Number(facet.date.slice(-2))} 日</span><span>${facet.count}</span></button>`).join("")}</div>` : ""}
        </div>`;
      }).join("")}</div>` : ""}
    </section>`;
    }).join("")}
  </div>`;
}

function renderCard(item: MediaItemDto, index: number): string {
  const isVideo = item.kind === "video";
  const selected = state.selectedIds.has(item.id);
  // `state.favorites` is seeded from the list query's `favorite` projection and
  // updated optimistically on toggle — no per-card detail fetch.
  const favorite = state.favorites.has(item.id);
  const favoritePending = state.favoritePendingIds.has(item.id);
  return `<article class="media-card ${selected ? "is-selected" : ""}" data-id="${escapeHtml(item.id)}" data-index="${index}" tabindex="0" role="group" aria-label="${escapeHtml(item.displayName)}">
    <div class="card-preview ${isVideo ? "is-video" : ""}" data-preview="${escapeHtml(item.id)}">${isVideo ? `<span class="video-placeholder"><span class="play-mark">▶</span><span>视频</span></span>` : `<span class="preview-loading">加载预览</span>`}<button class="card-select ${selected ? "is-checked" : ""}" data-select="${escapeHtml(item.id)}" type="button" aria-label="${selected ? "取消选择" : "选择"}${escapeHtml(item.displayName)}" aria-pressed="${selected}"><span aria-hidden="true">✓</span></button><button class="card-favorite ${favorite ? "is-favorite" : ""} ${favoritePending ? "is-pending" : ""}" data-favorite="${escapeHtml(item.id)}" type="button" aria-label="${favorite ? "取消收藏" : "收藏"}${escapeHtml(item.displayName)}" aria-pressed="${favorite}" aria-busy="${favoritePending}" ${favoritePending ? "disabled" : ""}><span aria-hidden="true">★</span></button><button class="card-folder" data-open-folder="${escapeHtml(item.id)}" type="button" aria-label="打开${escapeHtml(item.displayName)}所在文件夹" title="打开所在文件夹"><span aria-hidden="true">▣</span></button><span class="kind-badge kind-${item.kind}">${kindLabel(item.kind)}</span>${item.scanState !== "present" ? `<span class="state-badge">${item.scanState === "missing" ? "离线" : "需检查"}</span>` : ""}${item.burstGroup ? `<span class="burst-badge">连拍</span>` : ""}</div>
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
  // Type tabs are exclusive with 收藏/连拍 secondary filters, matching the
  // original 收藏 rule so switching tabs always replaces the whole filter set.
  const secondaryActive = state.favoriteOnly || state.burstOnly;
  const kinds = ([{ value: undefined, label: "全部" }, { value: "photo" as MediaKind, label: "照片" }, { value: "video" as MediaKind, label: "视频" }, { value: "live" as MediaKind, label: "实况" }]).map((filter) => `<button class="filter-chip ${state.kind === filter.value && !secondaryActive ? "is-active" : ""}" type="button" data-kind="${filter.value ?? ""}">${filter.label}</button>`).join("");
  return `${kinds}<button class="filter-chip ${state.favoriteOnly ? "is-active" : ""}" type="button" id="favorite-filter">收藏</button><button class="filter-chip ${state.burstOnly ? "is-active" : ""}" type="button" id="burst-filter">连拍</button>`;
}

function renderDateRangeControls(): string {
  const presets = [
    { id: "month", label: "本月" },
    { id: "year", label: "今年" },
    { id: "days30", label: "最近30天" },
  ];
  return `<div class="date-range" aria-label="日期区间">
    <label><span>从</span><input type="date" id="date-from" value="${escapeHtml(state.dateFrom ?? "")}" aria-label="开始日期" /></label>
    <label><span>到</span><input type="date" id="date-to" value="${escapeHtml(state.dateTo ?? "")}" aria-label="结束日期" /></label>
    ${presets.map((preset) => `<button class="filter-chip range-preset" type="button" data-range-preset="${preset.id}">${preset.label}</button>`).join("")}
    ${(state.dateFrom || state.dateTo) ? `<button class="filter-chip" type="button" id="clear-date-range">清除区间</button>` : ""}
  </div>`;
}

function scanStatusLabel(progress: ScanProgressDto): string {
  if (progress.total > 0) {
    const phase = progress.phase === "discovering" ? "发现文件" : progress.phase === "indexing" ? "建立索引" : "整理结果";
    return `正在扫描媒体库 · ${phase}`;
  }
  if (progress.processed > 0) return `正在扫描媒体库 · 已发现 ${formatCount(progress.processed)} 个文件`;
  return "正在扫描媒体库 · 发现文件";
}

function scanPercentLabel(progress: ScanProgressDto): string {
  return progress.total > 0 ? `${Math.round((progress.processed / progress.total) * 100)}%` : "发现中";
}

function renderStatusBannerBase(): string {
  if (state.scanning && state.scanProgress) {
    const progress = state.scanProgress.total > 0 ? Math.round((state.scanProgress.processed / state.scanProgress.total) * 100) : 0;
    const status = scanStatusLabel(state.scanProgress);
    const progressLabel = scanPercentLabel(state.scanProgress);
    const trackClass = state.scanProgress.total > 0 ? "" : " is-indeterminate";
    const trackWidth = state.scanProgress.total > 0 ? `${progress}%` : "35%";
    return `<div class="scan-banner" id="scan-progress-banner" role="status"><div class="scan-copy"><span class="spinner"></span><span data-scan-phase>${status}</span><strong data-scan-percent>${progressLabel}</strong><button class="text-button" id="scan-cancel-button" type="button">取消</button></div><div class="progress-track${trackClass}"><span data-scan-track style="width:${trackWidth}"></span></div><div class="scan-current" data-scan-current>${state.scanProgress.current ? escapeHtml(state.scanProgress.current) : ""}</div></div>`;
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
  banner.querySelector<HTMLElement>("[data-scan-phase]")!.textContent = scanStatusLabel(progress);
  banner.querySelector<HTMLElement>("[data-scan-percent]")!.textContent = scanPercentLabel(progress);
  const track = banner.querySelector<HTMLElement>("[data-scan-track]")!;
  track.style.width = progress.total > 0 ? `${Math.round((progress.processed / progress.total) * 100)}%` : "35%";
  track.parentElement!.classList.toggle("is-indeterminate", progress.total <= 0);
  banner.querySelector<HTMLElement>("[data-scan-current]")!.textContent = progress.current ?? "";
}

function renderBackupPanel(): string {
  if (!state.backupOpen) return "";
  const preview = state.backupPreview;
  const progress = state.backupProgress;
  const running = Boolean(state.backupJobId) || progress?.state === "running";
  // Keep step 3 visible while running or after a terminal event so the result
  // card and retry actions stay next to the progress they describe.
  const activeStep = running || (progress && progress.state !== "running") ? 3 : preview ? 2 : 1;
  const progressPercent = progress && progress.bytesTotal > 0
    ? Math.min(100, Math.max(0, Math.round(progress.bytesProcessed / progress.bytesTotal * 100)))
    : 0;
  const stepChip = (index: number, label: string): string =>
    `<span class="backup-step${activeStep === index ? " is-active" : activeStep > index ? " is-done" : ""}">${index}. ${label}</span>`;

  const sourceOptions = state.backupSources.length
    ? state.backupSources.map((source) => {
        const selected = (state.backupSourceId ?? state.backupSources[0]?.id) === source.id;
        return `<option value="${escapeHtml(source.id)}" ${selected ? "selected" : ""}>${escapeHtml(source.volumeLabel || source.rootPath)} · ${escapeHtml(source.rootPath)}</option>`;
      }).join("")
    : "<option value=\"\">未发现包含 DCIM 的可移动盘</option>";
  const targetOptions = state.libraries.map((library) => {
    const selected = (state.backupTargetId ?? state.library?.id ?? state.libraries[0]?.id) === library.id;
    return `<option value="${escapeHtml(library.id)}" ${selected ? "selected" : ""}>${escapeHtml(library.volumeLabel || library.rootPath)}</option>`;
  }).join("");

  const formDisabled = running || state.backupLoading;
  const canPreview = !formDisabled && state.backupSources.length > 0 && state.libraries.length > 0;

  let previewBlock = "";
  if (preview) {
    const willCopy = willCopyCount(preview);
    const spaceOk = preview.spaceSufficient !== false;
    const conflictNote = preview.conflictFiles > 0
      ? preview.conflictPolicy === "skip_same"
        ? `${formatCount(preview.conflictFiles)} 个同名冲突文件将按「跳过冲突」忽略`
        : preview.conflictPolicy === "rename"
          ? `${formatCount(preview.conflictFiles)} 个同名冲突文件将自动重命名后复制`
          : `${formatCount(preview.conflictFiles)} 个同名冲突文件将覆盖目标中的旧文件`
      : "无同名冲突";
    previewBlock = `
      <div class="backup-step-block">
        <div class="backup-step-title">第 2 步 · 确认摘要</div>
        <div class="backup-summary">
          <span>将复制 <strong>${formatCount(willCopy)}</strong> 个文件</span>
          <span>所需空间 <strong>${formatSize(preview.requiredBytes)}</strong></span>
          <span class="${spaceOk ? "" : "is-danger"}">目标剩余 <strong>${preview.freeBytes === null ? "不可用" : formatSize(preview.freeBytes)}</strong></span>
          <span>已存在跳过 ${formatCount(preview.alreadyExistsFiles)}</span>
          <span>冲突 ${formatCount(preview.conflictFiles)}</span>
          <span>忽略 ${formatCount(preview.ignoredFiles)}</span>
          <span>素材总量 ${formatCount(preview.totalFiles)} · ${formatSize(preview.totalBytes)}</span>
        </div>
        <div class="backup-note${spaceOk ? "" : " is-danger"}">${!spaceOk
          ? `目标盘空间不足：还需约 ${formatSize(Math.max(0, preview.requiredBytes - (preview.freeBytes ?? 0)))}。请更换目标盘或释放空间后再开始；预览已保存但不会执行复制。`
          : `冲突策略「${conflictPolicyLabel(preview.conflictPolicy)}」：${conflictNote}。相机源盘始终只读，复制完成后会自动扫描入库。`}</div>
        <div class="backup-actions">
          <button class="primary-button" id="backup-start-button" type="button" ${running || state.backupLoading || !spaceOk || willCopy === 0 ? "disabled" : ""}>${willCopy === 0 ? "没有需要复制的文件" : spaceOk ? "确认并开始备份" : "空间不足，无法开始"}</button>
        </div>
      </div>`;
  }

  let progressBlock = "";
  if (progress) {
    const done = progress.state === "completed";
    const failed = progress.state === "failed";
    const cancelled = progress.state === "cancelled";
    const title = done ? "备份完成" : failed ? "备份失败" : cancelled ? "备份已取消" : "正在备份";
    const filesLabel = `${formatCount(progress.fileProcessed)} / ${formatCount(progress.fileTotal)} 个文件`;
    const bytesLabel = `${formatSize(progress.bytesProcessed)} / ${formatSize(progress.bytesTotal)}`;
    const liveMeta = progress.state === "running"
      ? `${formatSpeed(progress.speedBytesPerSec)} · ${formatEtaSeconds(progress.etaSeconds)}`
      : "";
    const safePoint = progress.state === "running"
      ? "取消会在安全点停止：当前临时文件不会提交；已复制完成的文件会保留。"
      : cancelled
        ? `已取消。已复制 ${formatCount(progress.fileProcessed)} 个文件保留在目标盘；可继续重试未完成项，或重新预览。`
        : done
          ? `已复制 ${formatCount(progress.fileProcessed)} 个文件（${formatSize(progress.bytesProcessed)}）。后台将自动扫描入库。`
          : "可只重试失败文件，已成功的文件不会重复复制。";
    progressBlock = `
      <div class="scan-banner" role="status" aria-live="polite">
        <div class="scan-copy">
          ${progress.state === "running" ? `<span class="spinner"></span>` : ""}
          <span>${title}</span>
          <strong>${progress.state === "running" ? `${progressPercent}%` : filesLabel}</strong>
          ${progress.state === "running" ? `<button class="text-button" id="backup-cancel-button" type="button">取消</button>` : ""}
        </div>
        <div class="progress-track${progress.state === "running" && progress.bytesTotal <= 0 ? " is-indeterminate" : ""}">
          <span style="width:${progress.state === "running" && progress.bytesTotal <= 0 ? "35%" : `${progressPercent}%`}"></span>
        </div>
        <div class="scan-current">${escapeHtml(progress.currentFile || (progress.state === "running" ? "准备中" : ""))}${liveMeta ? ` · ${liveMeta}` : ""} · ${bytesLabel}</div>
        <div class="backup-note">${safePoint}</div>
        ${progress.error || failed ? `<div class="backup-note is-danger">${escapeHtml(progress.error || "备份过程中出现错误")}</div>` : ""}
        ${(failed || cancelled) && state.backupLastRunId && state.backupFailedItems.length ? `
          <div class="backup-actions">
            <button class="primary-button" id="backup-retry-button" type="button" ${state.backupRetrying || running ? "disabled" : ""}>${state.backupRetrying ? "重试中…" : failed ? "重试失败文件" : "继续未完成文件"}</button>
          </div>
          <div class="backup-failed-list">${state.backupFailedItems.slice(0, 8).map((item) => `<div class="backup-failed-item"><span>${escapeHtml(item.sourceRelative)}</span><span>${escapeHtml(item.errorMessage || "未完成")}</span></div>`).join("")}${state.backupFailedItems.length > 8 ? `<div class="backup-failed-item"><span>…</span><span>共 ${formatCount(state.backupFailedItems.length)} 项</span></div>` : ""}</div>
        ` : (failed || cancelled) && state.backupLastRunId ? `<div class="backup-note">没有可重试的文件项。可重新生成预览后再备份。</div>` : ""}
        ${done && state.backupLastRunId ? `
          <div class="backup-actions">
            <button class="primary-button" id="backup-view-new" type="button">查看新导入</button>
            <button class="text-button" id="backup-view-new-later" type="button">稍后再看</button>
          </div>
        ` : ""}
      </div>`;
  }

  const historyRows = state.backupHistory.length
    ? state.backupHistory.map((run) => {
        const expanded = state.backupExpandedRunId === run.id;
        const detail = expanded ? state.backupHistoryItems : [];
        return `<div class="backup-history-item${expanded ? " is-expanded" : ""}">
          <button type="button" class="backup-history-row" data-backup-run="${escapeHtml(run.id)}">
            <span class="status">${backupStatusLabel(run.status)}</span>
            <span class="time">${escapeHtml(formatCaptureAt(run.startedAt) || run.startedAt)}</span>
            <span class="src">${escapeHtml(run.sourceRootPath)}</span>
            <span class="nums">成功 ${formatCount(run.copiedFiles)} · 跳过 ${formatCount(run.skippedFiles)} · 失败 ${formatCount(run.failedFiles)} · ${formatSize(run.copiedBytes)}</span>
          </button>
          ${expanded ? `
            ${run.errorSummary ? `<div class="backup-note is-danger">${escapeHtml(run.errorSummary)}</div>` : ""}
            ${detail.length ? `<div class="backup-failed-list">${detail.slice(0, 10).map((item) => `<div class="backup-failed-item"><span>${escapeHtml(item.sourceRelative)}</span><span>${escapeHtml(item.errorMessage || "未完成")}</span></div>`).join("")}</div>` : `<div class="backup-note">该次没有失败/未完成文件。</div>`}
          ` : ""}
        </div>`;
      }).join("")
    : `<div class="backup-note">还没有备份记录。完成一次备份后会出现在这里。</div>`;

  return `<section class="backup-panel" aria-label="相机备份">
    <div class="backup-heading">
      <div><strong>相机备份</strong><span>源盘只读 · 临时文件校验后提交</span></div>
      <button class="icon-button" id="close-backup" type="button" aria-label="关闭备份面板">×</button>
    </div>
    <div class="backup-steps" aria-label="备份步骤">${stepChip(1, "选择")}${stepChip(2, "确认")}${stepChip(3, "执行")}</div>
    <div class="backup-step-block">
      <div class="backup-step-title">第 1 步 · 选择源盘与目标</div>
      <div class="backup-form">
        <label><span>源相机盘</span><select id="backup-source" ${formDisabled || !state.backupSources.length ? "disabled" : ""}>${sourceOptions}</select></label>
        <label><span>目标媒体库</span><select id="backup-target" ${formDisabled || !state.libraries.length ? "disabled" : ""}>${targetOptions}</select></label>
        <label><span>冲突策略</span><select id="backup-conflict" ${formDisabled ? "disabled" : ""}><option value="skip_same" ${state.backupConflictPolicy === "skip_same" ? "selected" : ""}>跳过冲突</option><option value="rename" ${state.backupConflictPolicy === "rename" ? "selected" : ""}>自动重命名</option><option value="overwrite" ${state.backupConflictPolicy === "overwrite" ? "selected" : ""}>覆盖目标</option></select></label>
        <label><span>忽略扩展名</span><input id="backup-ignore" value="${escapeHtml(state.backupIgnoreExtensions)}" aria-label="忽略扩展名" ${formDisabled ? "disabled" : ""} /></label>
        <button class="primary-button" id="backup-preview-button" type="button" ${canPreview ? "" : "disabled"}>${state.backupLoading ? "生成预览中…" : preview ? "刷新预览" : "生成预览"}</button>
      </div>
      ${!state.backupSources.length ? `<div class="backup-note">未检测到包含 DCIM 的可移动盘。请插入相机存储卡或 U 盘后重新打开。</div>` : ""}
    </div>
    ${previewBlock}
    ${progressBlock}
    <div class="backup-step-block">
      <div class="backup-step-title">最近备份</div>
      <div class="backup-history">${historyRows}</div>
    </div>
  </section>`;
}

function renderStatusBanner(): string {
  return `${renderStatusBannerBase()}${state.backupOpen ? "" : `<div class="backup-launcher-row"><button class="outline-button" id="backup-open-button" type="button">相机备份预览</button></div>`}${renderBackupPanel()}`;
}

function renderSelectionToolbar(): string {
  if (!state.page.total) return "";
  const allSelected = state.selectedIds.size >= state.page.total;
  return `<div class="selection-toolbar" aria-label="批量选择工具"><button class="selection-button" id="select-current" type="button">${allSelected ? "取消全选" : "全选当前结果"}</button><span class="selection-summary">${state.selectedIds.size ? `已选 ${formatCount(state.selectedIds.size)} 项 · Shift+点击可范围选择` : "选择媒体后可批量管理 · Shift+点击可范围选择"}</span>${state.selectedIds.size ? `<button class="clear-selection-button" id="clear-selection" type="button">清除选择</button><button class="selection-button" id="favorite-selected" type="button" ${state.favoritesBusy || state.deleting ? "disabled" : ""}>${state.favoritesBusy ? "收藏中…" : "批量收藏"}</button><button class="selection-button" id="unfavorite-selected" type="button" ${state.favoritesBusy || state.deleting ? "disabled" : ""}>${state.favoritesBusy ? "处理中…" : "取消收藏"}</button><button class="danger-button" id="delete-selected" type="button" ${state.deleting || state.favoritesBusy ? "disabled" : ""}>${state.deleting ? "处理中…" : "移入回收站"}</button>` : ""}</div>`;
}

function renderDeleteFeedback(): string {
  if (state.deleteProgress && state.deleting) {
    const progress = state.deleteProgress;
    const percent = progress.totalFiles > 0
      ? Math.round((progress.processedFiles / progress.totalFiles) * 100)
      : 0;
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
      ? `<ul class="delete-error-list">${result.errors.slice(0, 12).map((error) => `<li>${escapeHtml(error)}</li>`).join("")}${result.errors.length > 12 ? `<li>…以及另外 ${formatCount(result.errors.length - 12)} 条错误</li>` : ""}</ul>`
      : "";
    return `<div class="notice-banner ${hasFailures ? "is-warning" : "is-success"}" role="status" aria-live="polite"><span class="notice-icon">${hasFailures ? "!" : "✓"}</span><div><strong>${title}</strong><span>${summary}</span>${errors}<span class="delete-recover-hint">文件在 Windows 回收站中，可随时恢复。</span></div><button class="text-button" id="dismiss-delete-result" type="button">知道了</button></div>`;
  }
  if (state.deleteNotice) {
    return `<div class="notice-banner is-success" role="status" aria-live="polite"><span class="notice-icon">✓</span><span>${escapeHtml(state.deleteNotice)}</span><button class="text-button" id="dismiss-delete-notice" type="button">关闭</button></div>`;
  }
  return "";
}

function renderDeleteConfirm(): string {
  const confirm = state.deleteConfirm;
  if (!confirm) return "";
  const { preview } = confirm;
  const summaryLines = preview.summary.slice(0, 8);
  const more = preview.summary.length > 8;
  return `<div class="modal-backdrop confirm-backdrop" id="delete-confirm-modal" role="presentation"><div class="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="delete-confirm-title">
    <header class="confirm-header"><h2 id="delete-confirm-title">移入 Windows 回收站</h2><button class="icon-button" id="cancel-delete-confirm" type="button" aria-label="取消">×</button></header>
    <div class="confirm-body">
      <p class="confirm-lead">将把 <strong>${formatCount(preview.mediaCount)}</strong> 个媒体项（<strong>${formatCount(preview.fileCount)}</strong> 个文件，约 <strong>${formatSize(preview.totalSizeBytes)}</strong>）移入 <strong>Windows 回收站</strong>。</p>
      <p class="confirm-recycle">文件不会被永久粉碎。你可以从系统回收站恢复原文件；Camlib 只从索引中标记为已删除。</p>
      <div class="confirm-summary"><div class="confirm-summary-label">将处理的文件</div><ul>${summaryLines.map((line) => `<li>${escapeHtml(line)}</li>`).join("")}${more ? `<li class="confirm-more">…以及另外 ${formatCount(preview.summary.length - 8)} 个文件</li>` : ""}</ul></div>
    </div>
    <footer class="confirm-actions"><button class="outline-button" id="cancel-delete-confirm-footer" type="button">取消</button><button class="danger-button confirm-danger" id="confirm-delete" type="button">移入回收站</button></footer>
  </div></div>`;
}

function renderLibraryEmpty(): string {
  if (state.loading) return `<div class="empty-state"><span class="empty-icon spinner large"></span><h2>正在读取媒体库</h2><p>正在从 Tauri 后端加载索引。</p></div>`;
  if (state.availability === "unconfigured") return `<div class="empty-state setup-state"><span class="empty-icon">⌂</span><h2>还没有媒体库</h2><p>选择一个本地媒体目录，Camlib 会建立可搜索的索引。</p><div class="library-form"><button class="primary-button" id="choose-folder-button" type="button">选择文件夹…</button><details class="manual-path"><summary>手动输入路径</summary><form id="library-form"><input id="library-path" required placeholder="例如：D:\\照片" aria-label="媒体库路径" /><button class="outline-button" type="submit">连接媒体库</button></form></details></div></div>`;
  if (!state.library) return `<div class="empty-state"><span class="empty-icon">◎</span><h2>找不到媒体库记录</h2><p>请重新连接媒体库。</p></div>`;
  if (!state.page.total) return `<div class="empty-state"><span class="empty-icon">✦</span><h2>${hasAnyFilter() ? "没有匹配的媒体" : "媒体库还是空的"}</h2><p>${hasAnyFilter() ? "试试调整搜索或筛选条件。" : "点击右上角“扫描媒体库”开始建立索引。"}</p></div>`;
  return "";
}

function renderLibrarySwitcher(): string {
  if (!state.libraryFormOpen || !state.library) return "";
  return `<div class="library-form library-change-form"><div class="library-form-actions"><button class="primary-button" id="choose-folder-button" type="button">选择文件夹…</button><button class="text-button" id="library-cancel-button" type="button">取消</button></div><details class="manual-path"><summary>手动输入路径</summary><form id="library-form"><input id="library-path" required value="${escapeHtml(state.rootPath ?? state.library.rootPath)}" placeholder="例如：D:\\照片" aria-label="媒体库路径" /><button class="outline-button" type="submit">确认更换</button></form></details></div>`;
}

function render(): void {
  // Full innerHTML rebuild resets the scroller. Keep the user's place unless a
  // caller explicitly scrolls away (refreshMedia → scrollToContentTop).
  const previousContent = app.querySelector<HTMLElement>(".content");
  const previousScrollTop = previousContent?.scrollTop ?? 0;
  const previousScrollLeft = previousContent?.scrollLeft ?? 0;
  const hasItems = state.page.items.length > 0;
  app.style.setProperty("--tile-min", `${[150, 185, 220, 260, 310][state.density - 1]}px`);
  app.innerHTML = `<div class="shell"><aside class="sidebar" aria-label="媒体库导航">
    <div class="brand"><span class="brand-mark">C</span><div><strong>Camlib</strong><span>媒体库</span></div></div>
    <div class="sidebar-section library-section"><div class="section-label"><span>媒体库</span>${state.library ? `<span class="section-actions"><button class="icon-button" id="change-library-button" title="更换媒体库" aria-label="更换媒体库">⇄</button><button class="icon-button" id="refresh-button" title="刷新状态" aria-label="刷新状态">↻</button></span>` : ""}</div>${state.library ? `<div class="library-entry ${state.availability !== "available" ? "is-offline" : ""}"><span class="drive-icon">▣</span><div><strong>${escapeHtml(state.library.volumeLabel || state.library.driveLetter ? `${state.library.volumeLabel ?? "本地磁盘"} ${state.library.driveLetter ? `(${state.library.driveLetter}:)` : ""}` : "已连接媒体库")}</strong><span>${state.availability === "available" ? `${formatCount(facetTotal())} 个媒体` : "暂时不可用"}</span></div><span class="status-dot"></span></div>${renderLibrarySwitcher()}` : `<div class="library-entry is-empty"><span class="drive-icon">＋</span><div><strong>添加媒体库</strong><span>选择一个目录开始</span></div></div>`}</div>
    <nav class="sidebar-section date-section" aria-label="按日期浏览"><div class="section-label"><span>按日期浏览</span></div>${renderDateNavigation()}</nav>
    <div class="sidebar-footer"><span class="footer-dot"></span><span>${state.availability === "available" ? "索引已连接" : state.availability === "unconfigured" ? "等待连接" : "等待设备"}</span><label class="auto-scan-toggle" title="启动时自动增量扫描"><input id="auto-scan-toggle" type="checkbox" ${state.autoScanOnStartup ? "checked" : ""} aria-label="启动时自动扫描" /><span>启动扫描</span></label><button class="icon-button" title="扫描媒体库" id="scan-button" aria-label="扫描媒体库">⟳</button></div>
  </aside><main class="content">
    <header class="topbar"><div class="title-block"><div class="eyebrow">${primaryDateLabel() ? `筛选 · ${primaryDateLabel()}` : "媒体总览"}</div><h1>${primaryDateLabel() || "所有媒体"}</h1><span class="result-count">${formatCount(state.page.total)} 个项目</span>${hasAnyFilter() ? `<button class="text-button clear-all-filters" id="clear-all-filters" type="button">清除筛选</button>` : ""}</div><div class="top-actions"><div class="search-box"><span aria-hidden="true">⌕</span><input id="search-input" value="${escapeHtml(searchDraft)}" placeholder="搜索文件名" aria-label="搜索文件名" /><kbd>/</kbd><button class="search-button" id="search-button" type="button">搜索</button></div><button class="outline-button" id="scan-top-button" type="button">${state.scanning ? "扫描中…" : "扫描媒体库"}</button></div></header>
    ${state.firstSeenFrom ? `<div class="notice-banner" role="status"><span class="notice-icon">↓</span><div><strong>正在查看新导入</strong><span>按首次入库时间筛选（备份完成后自动扫描的结果）。可用「清除筛选」恢复全部媒体。</span></div></div>` : ""}
    ${renderStatusBanner()}${renderDeleteFeedback()}<div class="sticky-controls"><div class="toolbar"><div class="filter-column"><div class="filter-row">${renderKindFilters()}</div>${renderDateRangeControls()}</div><div class="toolbar-right"><label class="select-wrap"><span>排序</span><select id="sort-select" aria-label="排序"><option value="newest" ${state.sort === "newest" ? "selected" : ""}>最新</option><option value="oldest" ${state.sort === "oldest" ? "selected" : ""}>最早</option><option value="name" ${state.sort === "name" ? "selected" : ""}>文件名</option></select></label><label class="density-control" title="缩略图密度"><span>▦</span><input id="density-input" type="range" min="1" max="5" value="${state.density}" aria-label="缩略图密度" /><span>▦</span></label></div></div>${renderSelectionToolbar()}</div>
    <section class="media-area" aria-live="polite">${hasItems ? `${renderMediaGrid()}${state.page.total > state.page.items.length ? `<button class="load-more" id="load-more" type="button">加载更多 · 已显示 ${state.page.items.length} / ${state.page.total}</button>` : ""}` : renderLibraryEmpty()}</section></main></div>${state.previewIndex !== null ? renderPreview() : ""}${renderDeleteConfirm()}`;
  bindEvents();
  if (hasItems) observePreviews();
  const nextContent = app.querySelector<HTMLElement>(".content");
  if (nextContent) {
    nextContent.scrollTop = previousScrollTop;
    nextContent.scrollLeft = previousScrollLeft;
  }
}

function renderPreview(): string {
  const item = state.page.items[state.previewIndex ?? 0];
  if (!item) return "";
  const position = (state.previewIndex ?? 0) + 1;
  return `<div class="modal-backdrop" id="preview-modal"><div class="preview-modal" role="dialog" aria-modal="true" aria-label="${escapeHtml(item.displayName)}">
    <header class="modal-header"><div class="modal-header-copy"><span class="modal-kind-pill">${kindLabel(item.kind)}</span><span class="modal-position">${position} / ${state.page.items.length}</span></div><button class="modal-close" id="close-preview" type="button" aria-label="关闭">×</button></header>
    <div class="modal-body">
      <div class="modal-stage"><button class="modal-nav prev" id="preview-prev" type="button" aria-label="上一个">‹</button><div class="modal-media" id="modal-media"><span class="spinner large"></span></div><button class="modal-nav next" id="preview-next" type="button" aria-label="下一个">›</button></div>
      <aside class="modal-meta ${previewInfoOpen ? "" : "is-hidden"}" id="modal-meta" aria-label="媒体信息" aria-hidden="${previewInfoOpen ? "false" : "true"}"><div class="meta-placeholder">加载中…</div></aside>
    </div>
    <footer class="modal-caption"><div><strong>${escapeHtml(item.displayName)}</strong><span>${formatDate(item.captureDate)} · ${formatSize(item.totalSizeBytes)}${item.burstGroup ? " · 连拍" : ""}</span></div><div class="modal-actions"><button class="outline-button modal-tool-button" id="preview-info-toggle" type="button" aria-pressed="${previewInfoOpen}">信息</button><button class="outline-button modal-folder-button" id="preview-open-folder" type="button" data-open-folder="${escapeHtml(item.id)}">打开文件夹</button><span class="modal-hint">← → 切换 · Space 播放 · F 全屏 · I 信息 · L 实况</span></div></footer>
  </div></div>`;
}

function bindEvents(): void {
  app.querySelectorAll<HTMLButtonElement>("[data-prefix]").forEach((button) => button.addEventListener("click", () => {
    const prefix = button.dataset.prefix || undefined;
    state.datePrefix = prefix;
    // Prefix and range are exclusive in the UI so the title stays unambiguous.
    state.dateFrom = undefined;
    state.dateTo = undefined;
    if (prefix) {
      const year = prefix.slice(0, 4);
      state.expandedYears.add(year);
      if (prefix.length >= 7) state.expandedMonths.add(prefix.slice(0, 7));
    } else {
      resetSidebarExpansionForSelection();
    }
    void refreshMedia();
  }));
  app.querySelectorAll<HTMLButtonElement>("[data-year-toggle]").forEach((button) => button.addEventListener("click", () => {
    const year = button.dataset.yearToggle!;
    if (state.expandedYears.has(year)) state.expandedYears.delete(year);
    else state.expandedYears.add(year);
    render();
  }));
  app.querySelectorAll<HTMLButtonElement>("[data-month-toggle]").forEach((button) => button.addEventListener("click", () => {
    const month = button.dataset.monthToggle!;
    if (state.expandedMonths.has(month)) state.expandedMonths.delete(month);
    else state.expandedMonths.add(month);
    render();
  }));
  app.querySelectorAll<HTMLButtonElement>("[data-kind]").forEach((button) => button.addEventListener("click", () => {
    // Type tabs replace the whole filter set rather than stacking with 收藏/连拍.
    // Without resetting these flags, switching away kept querying only the
    // secondary subset and made the other tabs appear unresponsive.
    state.kind = (button.dataset.kind || undefined) as MediaKind | undefined;
    state.favoriteOnly = false;
    state.burstOnly = false;
    void refreshMedia();
  }));
  app.querySelector<HTMLButtonElement>("#favorite-filter")?.addEventListener("click", () => {
    // 收藏 / 连拍 are exclusive secondary tabs: selecting one clears the other.
    if (state.favoriteOnly) state.favoriteOnly = false;
    else { state.favoriteOnly = true; state.burstOnly = false; }
    void refreshMedia();
  });
  app.querySelector<HTMLButtonElement>("#burst-filter")?.addEventListener("click", () => {
    if (state.burstOnly) state.burstOnly = false;
    else { state.burstOnly = true; state.favoriteOnly = false; }
    void refreshMedia();
  });
  const applyDateInputs = () => {
    const from = app.querySelector<HTMLInputElement>("#date-from")?.value.trim();
    const to = app.querySelector<HTMLInputElement>("#date-to")?.value.trim();
    state.dateFrom = from || undefined;
    state.dateTo = to || undefined;
    if (state.dateFrom || state.dateTo) {
      // Range wins over sidebar prefix so the two cannot fight in the title.
      state.datePrefix = undefined;
    }
    void refreshMedia();
  };
  app.querySelector<HTMLInputElement>("#date-from")?.addEventListener("change", applyDateInputs);
  app.querySelector<HTMLInputElement>("#date-to")?.addEventListener("change", applyDateInputs);
  app.querySelector<HTMLButtonElement>("#clear-date-range")?.addEventListener("click", () => {
    state.dateFrom = undefined;
    state.dateTo = undefined;
    void refreshMedia();
  });
  app.querySelectorAll<HTMLButtonElement>("[data-range-preset]").forEach((button) => button.addEventListener("click", () => {
    const preset = button.dataset.rangePreset;
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
  }));
  app.querySelector<HTMLButtonElement>("#clear-all-filters")?.addEventListener("click", () => {
    state.search = "";
    searchDraft = "";
    state.kind = undefined;
    state.favoriteOnly = false;
    state.burstOnly = false;
    state.datePrefix = undefined;
    state.dateFrom = undefined;
    state.dateTo = undefined;
    state.firstSeenFrom = null;
    resetSidebarExpansionForSelection();
    void refreshMedia();
  });
  const searchInput = app.querySelector<HTMLInputElement>("#search-input");
  searchInput?.addEventListener("input", () => { searchDraft = searchInput.value; });
  searchInput?.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    state.search = searchDraft.trim();
    void refreshMedia();
  });
  app.querySelector<HTMLButtonElement>("#search-button")?.addEventListener("click", () => {
    state.search = searchDraft.trim();
    void refreshMedia();
  });
  app.querySelector<HTMLSelectElement>("#sort-select")?.addEventListener("change", (event) => {
    state.sort = (event.target as HTMLSelectElement).value as SortMode;
    void persistUiPrefs({ uiSort: state.sort });
    void refreshMedia();
  });
  // Keep density live while dragging; persist only on release so the settings
  // file is not rewritten on every slider tick.
  app.querySelector<HTMLInputElement>("#density-input")?.addEventListener("input", (event) => {
    state.density = Number((event.target as HTMLInputElement).value) as Density;
    app.style.setProperty("--tile-min", `${[150, 185, 220, 260, 310][state.density - 1]}px`);
  });
  app.querySelector<HTMLInputElement>("#density-input")?.addEventListener("change", (event) => {
    state.density = Number((event.target as HTMLInputElement).value) as Density;
    void persistUiPrefs({ uiDensity: state.density });
  });
  app.querySelector<HTMLButtonElement>("#scan-button")?.addEventListener("click", () => void scanLibrary());
  app.querySelector<HTMLButtonElement>("#scan-top-button")?.addEventListener("click", () => void scanLibrary());
  app.querySelector<HTMLInputElement>("#auto-scan-toggle")?.addEventListener("change", (event) => {
    const enabled = (event.target as HTMLInputElement).checked;
    void (async () => {
      try {
        const settings = await setAutoScanOnStartup(enabled);
        state.autoScanOnStartup = settings.auto_scan_on_startup;
      } catch (error) {
        state.error = error instanceof Error ? error.message : "保存启动扫描设置失败";
        render();
      }
    })();
  });
  app.querySelector<HTMLButtonElement>("#scan-cancel-button")?.addEventListener("click", () => void cancelCurrentScan());
  app.querySelector<HTMLButtonElement>("#backup-open-button")?.addEventListener("click", () => void openBackupPanel());
  app.querySelector<HTMLButtonElement>("#close-backup")?.addEventListener("click", () => { state.backupOpen = false; render(); });
  app.querySelector<HTMLButtonElement>("#backup-preview-button")?.addEventListener("click", () => void createBackupPreview());
  app.querySelector<HTMLSelectElement>("#backup-source")?.addEventListener("change", (event) => {
    state.backupSourceId = (event.target as HTMLSelectElement).value || null;
  });
  app.querySelector<HTMLSelectElement>("#backup-target")?.addEventListener("change", (event) => {
    state.backupTargetId = (event.target as HTMLSelectElement).value || null;
  });
  app.querySelector<HTMLInputElement>("#backup-ignore")?.addEventListener("change", (event) => {
    state.backupIgnoreExtensions = (event.target as HTMLInputElement).value;
  });
  app.querySelector<HTMLSelectElement>("#backup-conflict")?.addEventListener("change", (event) => void saveBackupConflict((event.target as HTMLSelectElement).value as ConflictPolicy));
  app.querySelector<HTMLButtonElement>("#backup-start-button")?.addEventListener("click", () => void startConfirmedBackup());
  app.querySelector<HTMLButtonElement>("#backup-cancel-button")?.addEventListener("click", () => void cancelCurrentBackup());
  app.querySelector<HTMLButtonElement>("#backup-retry-button")?.addEventListener("click", () => void retryCurrentBackup());
  app.querySelector<HTMLButtonElement>("#backup-view-new")?.addEventListener("click", () => void viewNewImports());
  app.querySelector<HTMLButtonElement>("#backup-view-new-later")?.addEventListener("click", () => {
    state.backupProgress = state.backupProgress ? { ...state.backupProgress, state: "completed" } : null;
    render();
  });
  app.querySelectorAll<HTMLButtonElement>("[data-backup-run]").forEach((button) => {
    button.addEventListener("click", () => {
      const runId = button.dataset.backupRun;
      if (!runId) return;
      state.backupExpandedRunId = state.backupExpandedRunId === runId ? null : runId;
      if (state.backupExpandedRunId) {
        void listBackupRunItems(runId, true).then((items) => {
          state.backupHistoryItems = items;
          render();
        }).catch((error) => {
          state.error = error instanceof Error ? error.message : "读取备份明细失败";
          render();
        });
      } else {
        state.backupHistoryItems = [];
      }
      render();
    });
  });
  app.querySelector<HTMLButtonElement>("#refresh-button")?.addEventListener("click", () => void bootstrap());
  app.querySelector<HTMLButtonElement>("#change-library-button")?.addEventListener("click", () => { state.libraryFormOpen = !state.libraryFormOpen; render(); });
  app.querySelector<HTMLButtonElement>("#choose-folder-button")?.addEventListener("click", () => void chooseLibraryFolder());
  app.querySelector<HTMLButtonElement>("#library-cancel-button")?.addEventListener("click", () => { state.libraryFormOpen = false; render(); });
  app.querySelector<HTMLButtonElement>("#rescan-button")?.addEventListener("click", () => void scanLibrary());
  app.querySelector<HTMLButtonElement>("#load-more")?.addEventListener("click", () => void loadMore());
  bindSelectionToolbarEvents();
  app.querySelector<HTMLButtonElement>("#cancel-delete-confirm")?.addEventListener("click", cancelDeleteConfirm);
  app.querySelector<HTMLButtonElement>("#cancel-delete-confirm-footer")?.addEventListener("click", cancelDeleteConfirm);
  app.querySelector<HTMLButtonElement>("#confirm-delete")?.addEventListener("click", () => void runConfirmedDelete());
  app.querySelector<HTMLElement>("#delete-confirm-modal")?.addEventListener("click", (event) => {
    if (event.target === event.currentTarget) cancelDeleteConfirm();
  });
  app.querySelector<HTMLButtonElement>("#dismiss-delete-result")?.addEventListener("click", () => {
    state.deleteResult = null;
    render();
  });
  app.querySelector<HTMLButtonElement>("#dismiss-delete-notice")?.addEventListener("click", () => {
    state.deleteNotice = null;
    render();
  });
  app.querySelector<HTMLFormElement>("#library-form")?.addEventListener("submit", (event) => { event.preventDefault(); const input = app.querySelector<HTMLInputElement>("#library-path"); if (input?.value.trim()) void connectLibrary(input.value.trim()); });
  app.querySelectorAll<HTMLElement>(".media-card").forEach((card) => {
    const open = () => { state.previewIndex = Number(card.dataset.index); render(); void loadModalAsset(); };
    card.addEventListener("click", open);
    card.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); open(); } });
  });
  app.querySelectorAll<HTMLButtonElement>("[data-select]").forEach((button) => button.addEventListener("click", (event) => {
    event.stopPropagation();
    const card = button.closest<HTMLElement>(".media-card");
    const index = Number(card?.dataset.index ?? 0);
    toggleSelection(button.dataset.select!, index, event.shiftKey);
  }));
  app.querySelectorAll<HTMLButtonElement>("[data-favorite]").forEach((button) => button.addEventListener("click", (event) => { event.stopPropagation(); void toggleFavorite(button.dataset.favorite!); }));
  app.querySelectorAll<HTMLButtonElement>("[data-open-folder]").forEach((button) => button.addEventListener("click", (event) => {
    event.stopPropagation();
    void openFolderForItem(button.dataset.openFolder!);
  }));
  app.querySelector<HTMLButtonElement>("#close-preview")?.addEventListener("click", closePreview);
  app.querySelector<HTMLElement>("#preview-modal")?.addEventListener("click", (event) => { if (event.target === event.currentTarget) closePreview(); });
  app.querySelector<HTMLButtonElement>("#preview-prev")?.addEventListener("click", () => movePreview(-1));
  app.querySelector<HTMLButtonElement>("#preview-next")?.addEventListener("click", () => movePreview(1));
  app.querySelector<HTMLButtonElement>("#preview-info-toggle")?.addEventListener("click", () => togglePreviewInfo());
}

async function openFolderForItem(mediaItemId: string): Promise<void> {
  try {
    await openMediaFolder(mediaItemId);
    state.error = null;
  } catch (error) {
    state.error = error instanceof Error ? error.message : "打开所在文件夹失败";
    render();
  }
}

function applyThumbnailToCard(id: string, asset: Awaited<ReturnType<typeof getMediaThumbnail>>): void {
  const target = [...app.querySelectorAll<HTMLElement>("[data-preview]")].find((element) => element.dataset.preview === id);
  const item = state.page.items.find((entry) => entry.id === id);
  if (!target || !item) return;
  target.classList.add("has-preview");
  target.querySelector(".preview-loading, .video-placeholder, .preview-fallback-row, .preview-fallback")?.remove();
  const existing = target.querySelector("img");
  if (existing) {
    existing.src = asset.url;
  } else {
    const image = document.createElement("img");
    image.src = asset.url;
    image.alt = "";
    image.decoding = "async";
    target.prepend(image);
  }
  if (item.kind === "video" && !target.querySelector(".video-overlay")) {
    const overlay = document.createElement("span");
    overlay.className = "video-overlay";
    overlay.textContent = "▶";
    target.append(overlay);
  }
}

function markThumbnailRetryable(id: string): void {
  const target = app.querySelector<HTMLElement>(`[data-preview="${CSS.escape(id)}"]`);
  if (!target) return;
  delete target.dataset.loaded;
  target.querySelector(".preview-loading, .video-placeholder, .preview-fallback-row, .preview-fallback")?.remove();
  if (!target.querySelector(".preview-fallback-row")) {
    target.insertAdjacentHTML(
      "afterbegin",
      `<div class="preview-fallback-row"><span class="preview-fallback">预览失败</span><button class="preview-retry" type="button" data-retry-thumbnail="${escapeHtml(id)}">重试</button></div>`,
    );
  }
}

function observePreviews(): void {
  const cards = [...app.querySelectorAll<HTMLElement>("[data-preview]")];
  const load = (card: HTMLElement, highPriority = false) => {
    if (card.dataset.loaded === "true") return;
    card.dataset.loaded = "true";
    const id = card.dataset.preview;
    if (!id) return;
    void loadThumbnail(id, highPriority)
      .then((asset) => applyThumbnailToCard(id, asset))
      .catch(() => markThumbnailRetryable(id));
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

function renderMetaPanel(meta: PreviewMetaDto | null, item: MediaItemDto): string {
  if (!meta) return `<div class="meta-placeholder">元数据加载中…</div>`;
  const rows: Array<[string, string]> = [
    ["类型", kindLabel(item.kind)],
    ["尺寸", formatDimensions(meta)],
    ["大小", formatSize(meta.totalSizeBytes)],
  ];
  if (meta.durationMs != null && meta.durationMs > 0) rows.push(["时长", formatDuration(meta.durationMs)]);
  const captureAt = formatCaptureAt(meta.captureAt);
  if (captureAt) rows.push(["拍摄时间", captureAt]);
  if (meta.captureDate) rows.push(["拍摄日期", formatDate(meta.captureDate)]);
  rows.push(["状态", meta.scanState === "present" ? "在库" : meta.scanState === "missing" ? "离线" : meta.scanState === "ambiguous" ? "待确认" : "错误"]);
  if (meta.burstGroup) rows.push(["连拍组", meta.burstGroup]);
  if (meta.favorite) rows.push(["收藏", "是"]);
  if (meta.tags.length) rows.push(["标签", meta.tags.join("、")]);
  const files = meta.files.map((file) => `<li class="meta-file ${file.existsNow ? "" : "is-missing"}"><span class="meta-file-role">${fileRoleLabel(file.role)}</span><span class="meta-file-name" title="${escapeHtml(file.relativePath)}">${escapeHtml(file.fileName)}</span><span class="meta-file-size">${formatSize(file.sizeBytes)}</span>${file.existsNow ? "" : `<span class="meta-file-state">缺失</span>`}</li>`).join("");
  return `<div class="meta-panel-body">
    <h3>媒体信息</h3>
    <dl class="meta-list">${rows.map(([label, value]) => `<div class="meta-row"><dt>${label}</dt><dd>${escapeHtml(String(value))}</dd></div>`).join("")}</dl>
    <h4>关联文件</h4>
    <ul class="meta-files">${files}</ul>
  </div>`;
}

function renderVideoStatusOverlay(): string {
  return `<div class="video-status is-buffering" id="video-buffer" hidden><span class="spinner"></span><span>缓冲中…</span></div>
  <div class="video-status is-error" id="video-error" hidden><strong>视频无法播放</strong><span>文件可能损坏，或当前磁盘暂时不可读</span><button type="button" class="outline-button" id="video-retry">重试</button></div>`;
}

function bindVideoElement(video: HTMLVideoElement): void {
  const buffer = app.querySelector<HTMLElement>("#video-buffer");
  const errorBox = app.querySelector<HTMLElement>("#video-error");
  const hideOverlays = () => {
    if (buffer) buffer.hidden = true;
    if (errorBox) errorBox.hidden = true;
  };
  video.addEventListener("waiting", () => { if (buffer) buffer.hidden = false; });
  video.addEventListener("playing", hideOverlays);
  video.addEventListener("canplay", () => { if (buffer) buffer.hidden = true; });
  video.addEventListener("error", () => {
    if (buffer) buffer.hidden = true;
    if (errorBox) errorBox.hidden = false;
  });
}

async function loadModalAsset(): Promise<void> {
  const index = state.previewIndex;
  const item = index === null ? undefined : state.page.items[index];
  if (!item) return;
  const request = ++previewRequest;
  livePlaying = false;
  if (index !== null) prefetchPreviewNeighbors(index);
  try {
    const preview = await requestPreview(item.id);
    if (request !== previewRequest || state.previewIndex === null) return;
    const media = app.querySelector<HTMLElement>("#modal-media");
    const metaPanel = app.querySelector<HTMLElement>("#modal-meta");
    if (!media) return;
    if (metaPanel) metaPanel.innerHTML = renderMetaPanel(preview.meta, item);
    const photo = preview.sources.find((source) => source.role === "photo" || (source.role === "single" && !source.mimeType.startsWith("video/")));
    const video = preview.sources.find((source) => source.role === "video" || (source.role === "single" && source.mimeType.startsWith("video/")));
    const photoPreview = photo ? await loadModalThumbnail(item.id).catch(() => undefined) : undefined;
    if (request !== previewRequest || state.previewIndex === null) return;
    if (item.kind === "live" && photo && video) {
      media.innerHTML = `<div class="live-preview" data-live-playing="false">
        <img class="live-still" src="${photoPreview?.url ?? photo.url}" alt="${escapeHtml(item.displayName)}" />
        <video class="live-motion" src="${video.url}" muted loop playsinline preload="metadata" hidden></video>
        <div class="live-controls">
          <button type="button" class="live-toggle" id="live-toggle" aria-pressed="false">实况</button>
          <span class="live-caption">默认显示静帧 · 点击「实况」或按 L / 长按画面播放短片</span>
        </div>
      </div>`;
      const liveVideo = media.querySelector<HTMLVideoElement>("video.live-motion");
      if (liveVideo) {
        bindVideoElement(liveVideo);
        liveVideo.addEventListener("ended", () => setLivePlaying(false));
      }
    } else if (video) {
      media.innerHTML = `<div class="video-stage"><video src="${video.url}" controls playsinline preload="metadata"></video>${renderVideoStatusOverlay()}</div>`;
      const el = media.querySelector<HTMLVideoElement>("video");
      if (el) {
        bindVideoElement(el);
        void el.play().catch(() => undefined);
      }
    } else if (photoPreview) {
      media.innerHTML = `<img src="${photoPreview.url}" alt="${escapeHtml(item.displayName)}" />`;
    } else {
      media.innerHTML = `<div class="preview-error"><span>当前文件不可用</span><button type="button" class="outline-button" id="preview-retry-media">重试</button></div>`;
    }
  } catch {
    if (request !== previewRequest) return;
    const media = app.querySelector<HTMLElement>("#modal-media");
    if (media) {
      media.innerHTML = `<div class="preview-error"><span>当前文件不可用</span><button type="button" class="outline-button" id="preview-retry-media">重试</button></div>`;
    }
  }
}

function setLivePlaying(playing: boolean): void {
  livePlaying = playing;
  const root = app.querySelector<HTMLElement>("#modal-media .live-preview");
  if (!root) return;
  const video = root.querySelector<HTMLVideoElement>("video.live-motion");
  const still = root.querySelector<HTMLImageElement>("img.live-still");
  const toggle = root.querySelector<HTMLButtonElement>("#live-toggle");
  root.dataset.livePlaying = playing ? "true" : "false";
  toggle?.setAttribute("aria-pressed", String(playing));
  toggle?.classList.toggle("is-active", playing);
  if (!video) return;
  if (playing) {
    video.hidden = false;
    if (still) still.classList.add("is-under");
    if (video.ended || video.currentTime === 0) video.currentTime = 0;
    void video.play().catch(() => setLivePlaying(false));
  } else {
    video.pause();
    video.hidden = true;
    still?.classList.remove("is-under");
  }
}

function toggleLivePreview(): void {
  const root = app.querySelector<HTMLElement>("#modal-media .live-preview");
  if (!root) return;
  setLivePlaying(!livePlaying);
}

function activePreviewVideo(): HTMLVideoElement | null {
  const live = app.querySelector<HTMLVideoElement>("#modal-media video.live-motion");
  if (live && livePlaying) return live;
  return app.querySelector<HTMLVideoElement>("#modal-media .video-stage video");
}

function togglePreviewPlayback(): void {
  const video = activePreviewVideo();
  if (video) {
    if (video.paused) void video.play().catch(() => undefined);
    else video.pause();
    return;
  }
  // Live Photo still: Space starts the motion clip.
  if (app.querySelector("#modal-media .live-preview")) toggleLivePreview();
}

function togglePreviewMute(): void {
  const video = activePreviewVideo() ?? app.querySelector<HTMLVideoElement>("#modal-media video");
  if (!video) return;
  video.muted = !video.muted;
}

function togglePreviewFullscreen(): void {
  const video = activePreviewVideo() ?? app.querySelector<HTMLVideoElement>("#modal-media video");
  if (!video) return;
  if (document.fullscreenElement) {
    void document.exitFullscreen().catch(() => undefined);
    return;
  }
  void video.requestFullscreen().catch(() => undefined);
}

function togglePreviewInfo(): void {
  previewInfoOpen = !previewInfoOpen;
  const panel = app.querySelector<HTMLElement>("#modal-meta");
  const button = app.querySelector<HTMLButtonElement>("#preview-info-toggle");
  if (panel) {
    panel.classList.toggle("is-hidden", !previewInfoOpen);
    panel.setAttribute("aria-hidden", previewInfoOpen ? "false" : "true");
  }
  button?.setAttribute("aria-pressed", String(previewInfoOpen));
}

function closePreview(): void {
  state.previewIndex = null;
  livePlaying = false;
  liveHoldActive = false;
  if (liveHoldTimer !== null) {
    window.clearTimeout(liveHoldTimer);
    liveHoldTimer = null;
  }
  render();
}

function movePreview(delta: number): void {
  if (state.previewIndex === null || !state.page.items.length) return;
  state.previewIndex = (state.previewIndex + delta + state.page.items.length) % state.page.items.length;
  livePlaying = false;
  liveHoldActive = false;
  if (liveHoldTimer !== null) {
    window.clearTimeout(liveHoldTimer);
    liveHoldTimer = null;
  }
  render();
  void loadModalAsset();
}

async function refreshMedia(): Promise<void> {
  if (!state.library) { render(); return; }
  const token = ++mediaQueryToken;
  state.loading = true; state.error = null; render();
  try {
    const page = await queryMedia({ ...currentQueryFields(), limit: 120 });
    if (token !== mediaQueryToken) return;
    state.page = page;
    state.selectedIds.clear();
    state.lastSelectIndex = null;
    state.favorites = new Set(state.page.items.filter((item) => item.favorite).map((item) => item.id));
  }
  catch (error) {
    if (token !== mediaQueryToken) return;
    state.error = error instanceof Error ? error.message : "读取媒体索引失败";
  }
  finally {
    if (token === mediaQueryToken) {
      state.loading = false;
      render();
      // A filter change starts a new result list; keep the viewport at the top
      // so the user does not land mid-page on unrelated items.
      scrollToContentTop();
    }
  }
}

async function loadMore(): Promise<void> {
  if (!state.library || state.page.items.length >= state.page.total) return;
  const token = mediaQueryToken;
  try {
    const next = await queryMedia({ ...currentQueryFields(), offset: state.page.items.length, limit: 120 });
    // Discard pages that finished after a filter switch.
    if (token !== mediaQueryToken) return;
    state.page.items.push(...next.items);
    next.items.forEach((item) => { if (item.favorite) state.favorites.add(item.id); });
    render();
  }
  catch (error) {
    if (token !== mediaQueryToken) return;
    state.error = error instanceof Error ? error.message : "加载更多媒体失败"; render();
  }
}

async function selectCurrentResults(): Promise<void> {
  if (!state.library) return;
  if (state.selectedIds.size >= state.page.total) {
    state.selectedIds.clear();
    state.lastSelectIndex = null;
    applySelectionChrome();
    return;
  }
  const token = mediaQueryToken;
  try {
    const ids = new Set<string>();
    for (let offset = 0; offset < state.page.total; offset += 500) {
      const page = await queryMedia({ ...currentQueryFields(), offset, limit: 500 });
      if (token !== mediaQueryToken) return;
      page.items.forEach((item) => ids.add(item.id));
      if (!page.items.length) break;
    }
    if (token !== mediaQueryToken) return;
    state.selectedIds = ids;
    state.lastSelectIndex = null;
    applySelectionChrome();
  } catch (error) {
    if (token !== mediaQueryToken) return;
    state.error = error instanceof Error ? error.message : "选择当前结果失败"; render();
  }
}

function cancelDeleteConfirm(): void {
  if (state.deleting) return;
  state.deleteConfirm = null;
  render();
}

function applyDeleteToGrid(result: DeleteResultDto, requestedIds: string[]): void {
  const deleted = new Set(result.deletedItemIds);
  const failed = new Set(result.failedItemIds);
  // Drop fully recycled items from the grid immediately; keep partial failures
  // visible so the user can inspect what is still on disk.
  state.page.items = state.page.items.filter((item) => !deleted.has(item.id));
  state.page.total = Math.max(0, state.page.total - deleted.size);
  for (const id of requestedIds) {
    state.selectedIds.delete(id);
    state.favorites.delete(id);
    if (deleted.has(id)) {
      thumbnailRequests.delete(id);
      modalThumbnailRequests.delete(id);
      previewAssetCache.delete(id);
    }
  }
  // Failed items remain selected so the user can retry after fixing the file.
  for (const id of failed) {
    if (requestedIds.includes(id)) state.selectedIds.add(id);
  }
  if (state.previewIndex !== null) {
    const current = state.page.items[state.previewIndex];
    if (!current) state.previewIndex = null;
  }
}

async function requestDeleteSelected(): Promise<void> {
  if (!state.library || !state.selectedIds.size || state.deleting || state.deleteConfirm) return;
  const ids = [...state.selectedIds];
  state.deleting = true;
  state.deleteResult = null;
  state.deleteNotice = null;
  state.error = null;
  render();
  try {
    const preview = await previewDelete(state.library.id, ids);
    state.deleteConfirm = { preview, ids };
  } catch (error) {
    state.error = error instanceof Error ? error.message : "无法生成删除预览";
    state.selectedIds.clear();
  } finally {
    state.deleting = false;
    render();
  }
}

async function runConfirmedDelete(): Promise<void> {
  const confirm = state.deleteConfirm;
  if (!state.library || !confirm || state.deleting) return;
  state.deleting = true;
  state.deleteConfirm = null;
  state.deleteProgress = {
    processedFiles: 0,
    totalFiles: confirm.preview.fileCount,
    current: "",
    state: "running",
  };
  state.error = null;
  render();
  try {
    const result = await deleteMediaItems(state.library.id, confirm.ids);
    state.deleteResult = result;
    state.deleteProgress = null;
    applyDeleteToGrid(result, confirm.ids);
    // Partial failures are explained by the result panel; do not stack a second error banner.
    state.error = null;
  } catch (error) {
    state.deleteProgress = null;
    state.error = error instanceof Error ? error.message : "删除媒体失败";
  } finally {
    state.deleting = false;
    state.lastSelectIndex = null;
    render();
  }
}

async function connectLibrary(path: string): Promise<void> {
  state.loading = true; state.error = null; render();
  try {
    await setLibraryRoot(path);
    state.libraryFormOpen = false;
    // A newly registered root should get one automatic incremental scan.
    startupAutoScanStarted = false;
    await bootstrap();
  }
  catch (error) { state.error = error instanceof Error ? error.message : "连接媒体库失败"; state.loading = false; render(); }
}

async function chooseLibraryFolder(): Promise<void> {
  try {
    const selected = await openFileDialog({
      directory: true,
      multiple: false,
      title: "选择媒体库文件夹",
    });
    if (typeof selected === "string" && selected.trim()) {
      await connectLibrary(selected);
    }
  } catch (error) {
    state.error = error instanceof Error ? error.message : "打开文件夹选择器失败";
    render();
  }
}

async function persistUiPrefs(input: { uiDensity?: number; uiSort?: SortMode }): Promise<void> {
  try {
    const settings = await setUiPrefs(input);
    state.density = clampDensity(settings.ui_density);
    state.sort = settings.ui_sort;
  } catch (error) {
    state.error = error instanceof Error ? error.message : "保存界面偏好失败";
  }
}

async function maybeAutoScan(): Promise<void> {
  if (startupAutoScanStarted) return;
  if (!state.library || state.availability !== "available") return;
  if (!state.autoScanOnStartup || state.scanning) return;
  startupAutoScanStarted = true;
  await scanLibrary();
}

function clampDensity(value: number): Density {
  const clamped = Math.min(5, Math.max(1, Math.round(value || 3)));
  return clamped as Density;
}

async function loadBackupHistory(): Promise<void> {
  try {
    state.backupHistory = await listBackupHistory(8);
  } catch {
    // History is optional chrome; do not surface a hard error on open.
    state.backupHistory = [];
  }
}

async function openBackupPanel(): Promise<void> {
  state.backupOpen = true;
  state.backupPreview = null;
  state.backupLoading = true;
  render();
  try {
    const [sources] = await Promise.all([discoverBackupSources(), loadBackupHistory()]);
    state.backupSources = sources;
    if (!state.backupSourceId || !sources.some((source) => source.id === state.backupSourceId)) {
      state.backupSourceId = sources[0]?.id ?? null;
    }
    if (!state.backupTargetId || !state.libraries.some((library) => library.id === state.backupTargetId)) {
      state.backupTargetId = state.library?.id ?? state.libraries[0]?.id ?? null;
    }
  } catch (error) {
    state.error = error instanceof Error ? error.message : "发现相机盘失败";
  } finally {
    state.backupLoading = false;
    render();
  }
}

async function createBackupPreview(): Promise<void> {
  const sourceSelect = app.querySelector<HTMLSelectElement>("#backup-source");
  const targetSelect = app.querySelector<HTMLSelectElement>("#backup-target");
  const ignoreInput = app.querySelector<HTMLInputElement>("#backup-ignore");
  if (sourceSelect?.value) state.backupSourceId = sourceSelect.value;
  if (targetSelect?.value) state.backupTargetId = targetSelect.value;
  if (ignoreInput) state.backupIgnoreExtensions = ignoreInput.value;
  const source = state.backupSourceId;
  const target = state.backupTargetId;
  if (!source || !target) return;
  const ignore = state.backupIgnoreExtensions
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
  if (preview.spaceSufficient === false) {
    state.error = "目标盘空间不足，无法开始备份";
    render();
    return;
  }
  const confirmed = window.confirm(`将按预览复制 ${formatCount(willCopyCount(preview))} 个文件（${formatSize(preview.requiredBytes)}）。\n\n相机源文件不会被删除、移动或修改。是否开始备份？`);
  if (!confirmed) return;
  state.backupLoading = true; state.error = null;
  state.backupLastRunId = preview.backupRunId;
  state.backupProgress = null;
  state.backupFailedItems = [];
  render();
  try {
    const start = await startBackup(preview.backupRunId, preview.id);
    state.backupJobId = start.jobId;
    state.backupLastRunId = start.backupRunId;
  } catch (error) {
    state.error = error instanceof Error ? error.message : "无法开始备份";
  } finally { state.backupLoading = false; render(); }
}

async function cancelCurrentBackup(): Promise<void> {
  if (!state.backupJobId) return;
  try { await cancelBackup(state.backupJobId); } catch (error) { state.error = error instanceof Error ? error.message : "无法取消备份"; render(); }
}

async function retryCurrentBackup(): Promise<void> {
  const runId = state.backupLastRunId;
  if (!runId || state.backupJobId || state.backupRetrying) return;
  state.backupRetrying = true;
  state.error = null;
  render();
  try {
    const start = await retryFailedBackup(runId);
    state.backupJobId = start.jobId;
    state.backupLastRunId = start.backupRunId;
    state.backupProgress = null;
    state.backupFailedItems = [];
  } catch (error) {
    state.error = error instanceof Error ? error.message : "重试备份失败";
  } finally {
    state.backupRetrying = false;
    render();
  }
}

async function viewNewImports(): Promise<void> {
  // Prefer the finished backup's start time so items indexed before the run
  // are not listed as "new".
  const runId = state.backupLastRunId;
  const startedAt = runId ? state.backupHistory.find((run) => run.id === runId)?.startedAt : undefined;
  state.firstSeenFrom = startedAt && startedAt.startsWith("unix-ms:")
    ? startedAt
    : `unix-ms:${Date.now() - 15 * 60 * 1000}`;
  state.datePrefix = undefined;
  state.dateFrom = undefined;
  state.dateTo = undefined;
  state.kind = undefined;
  state.favoriteOnly = false;
  state.burstOnly = false;
  state.search = "";
  searchDraft = "";
  state.backupOpen = false;
  if (state.library && state.availability === "available") {
    await refreshMedia();
  } else {
    render();
  }
}

async function scanLibrary(): Promise<void> {
  if (!state.library || state.scanning) return;
  state.error = null; state.scanning = true; state.scanProgress = null; render();
  try {
    const start = await startLibraryScan(state.library.id);
    // Incremental rescans can emit running/completed before this response is
    // stored. Never rewind a job that already reported, and never resurrect a
    // job that already finished.
    if (!state.scanning) return;
    // Read through the state object so TypeScript does not keep the earlier
    // `scanProgress = null` narrowing across the await.
    const reported = state.scanProgress as ScanProgressDto | null;
    if (reported && reported.jobId === start.jobId) return;
    state.scanProgress = { jobId: start.jobId, kind: "scan", seq: 0, phase: "discovering", state: "running", current: null, processed: 0, total: 0, errors: [], error: null };
    render();
  }
  catch (error) { state.scanning = false; state.error = error instanceof Error ? error.message : "无法开始扫描"; render(); }
}

async function cancelCurrentScan(): Promise<void> {
  if (!state.scanProgress || state.scanProgress.state !== "running") return;
  try { await cancelLibraryScan(state.scanProgress.jobId); }
  catch (error) { state.error = error instanceof Error ? error.message : "无法取消扫描"; render(); }
}

async function bootstrap(): Promise<void> {
  state.loading = true; state.error = null; render();
  try {
    const [infra, libraries] = await Promise.all([getInfrastructureState(), listLibraries()]);
    state.backupConflictPolicy = infra.settings.backup_conflict_policy;
    state.density = clampDensity(infra.settings.ui_density);
    state.sort = infra.settings.ui_sort;
    state.autoScanOnStartup = infra.settings.auto_scan_on_startup;
    state.libraries = libraries; state.availability = infra.library_status.availability; state.rootPath = infra.library_status.root_path; state.library = libraries.find((library) => library.rootPath === infra.library_status.root_path) ?? libraries[0] ?? null;
    if (state.library && state.availability === "available") {
      state.facets = await listDateFacets(state.library.id);
      resetSidebarExpansionForSelection();
      await refreshMedia();
      void maybeAutoScan();
    }
    else { state.page = { items: [], total: 0, offset: 0, limit: 120 }; state.facets = []; state.loading = false; render(); }
  } catch (error) { state.loading = false; state.error = error instanceof Error ? error.message : "初始化媒体库失败"; render(); }
}

window.addEventListener("keydown", (event) => {
  if (state.deleteConfirm && !state.deleting) {
    if (event.key === "Escape") {
      event.preventDefault();
      cancelDeleteConfirm();
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      void runConfirmedDelete();
      return;
    }
  }
  if (state.previewIndex === null) {
    if (event.key === "/" && document.activeElement?.tagName !== "INPUT") {
      event.preventDefault();
      app.querySelector<HTMLInputElement>("#search-input")?.focus();
    }
    return;
  }
  const target = event.target as HTMLElement | null;
  const typing = target?.tagName === "INPUT" || target?.tagName === "TEXTAREA" || target?.isContentEditable === true;
  if (typing) return;
  if (event.key === "Escape") {
    // Fullscreen Escape should only leave fullscreen, not close the modal.
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => undefined);
      return;
    }
    closePreview();
    return;
  }
  if (event.key === "ArrowLeft" || event.key === "ArrowUp") { event.preventDefault(); movePreview(-1); return; }
  if (event.key === "ArrowRight" || event.key === "ArrowDown") { event.preventDefault(); movePreview(1); return; }
  if (event.key === " " || event.key === "Spacebar") {
    const tag = target?.tagName;
    // Let focused controls keep their native Space activation; the video
    // element already toggles playback when it has focus.
    if (tag === "BUTTON" || tag === "A" || tag === "INPUT" || tag === "SELECT" || tag === "VIDEO" || tag === "SUMMARY" || tag === "LABEL") {
      return;
    }
    event.preventDefault();
    togglePreviewPlayback();
    return;
  }
  if (event.key === "f" || event.key === "F") { event.preventDefault(); togglePreviewFullscreen(); return; }
  if (event.key === "i" || event.key === "I") { event.preventDefault(); togglePreviewInfo(); return; }
  if (event.key === "l" || event.key === "L") { event.preventDefault(); toggleLivePreview(); return; }
  if (event.key === "m" || event.key === "M") { event.preventDefault(); togglePreviewMute(); return; }
  if (event.key === "/" && document.activeElement?.tagName !== "INPUT") {
    event.preventDefault();
    app.querySelector<HTMLInputElement>("#search-input")?.focus();
  }
});

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
      if (!card.querySelector(".preview-loading")) {
        card.insertAdjacentHTML("afterbegin", `<span class="preview-loading">加载预览</span>`);
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

// Long-press (or press-and-hold) on the Live Photo still plays motion while held.
let liveHoldTimer: number | null = null;
let liveHoldActive = false;
app.addEventListener("pointerdown", (event) => {
  const still = (event.target as HTMLElement | null)?.closest?.("#modal-media .live-still");
  if (!still || livePlaying) return;
  liveHoldTimer = window.setTimeout(() => {
    liveHoldTimer = null;
    liveHoldActive = true;
    setLivePlaying(true);
  }, 180);
});
app.addEventListener("pointerup", () => {
  if (liveHoldTimer !== null) {
    window.clearTimeout(liveHoldTimer);
    liveHoldTimer = null;
  }
  if (liveHoldActive) {
    liveHoldActive = false;
    setLivePlaying(false);
  }
});
app.addEventListener("pointercancel", () => {
  if (liveHoldTimer !== null) {
    window.clearTimeout(liveHoldTimer);
    liveHoldTimer = null;
  }
  if (liveHoldActive) {
    liveHoldActive = false;
    setLivePlaying(false);
  }
});

void onScanProgress((progress) => {
  const terminal = progress.state === "completed" || progress.state === "cancelled" || progress.state === "failed";
  if (terminal) {
    // Fast scans finish before library_scan_start returns, so scanProgress may
    // still be null. Accept that terminal event; drop only a different known job.
    if (state.scanProgress && progress.jobId !== state.scanProgress.jobId) return;
    if (!state.scanProgress && !state.scanning) return;
    state.scanning = false;
    state.scanProgress = progress;
    if (progress.state === "failed") state.error = progress.error ?? "扫描失败";
    render();
    void bootstrap();
    return;
  }
  if (!state.scanProgress || progress.jobId !== state.scanProgress.jobId) { state.scanning = true; state.scanProgress = progress; render(); return; }
  state.scanProgress = progress;
  updateScanProgressView();
});
void onDeleteProgress((progress) => {
  if (!state.deleting) return;
  state.deleteProgress = progress;
  if (progress.state === "completed") return;
  render();
});
void onBackupProgress((progress) => {
  // Accept a terminal event that raced with startBackup's response, but never
  // adopt a different job's progress.
  if (state.backupJobId && progress.jobId !== state.backupJobId) return;
  if (!state.backupJobId && progress.state === "running") return;
  state.backupProgress = progress;
  if (progress.state === "running") {
    render();
    return;
  }
  state.backupJobId = null;
  if (progress.state === "failed") state.error = progress.error ?? "备份失败";
  void loadBackupHistory().then(() => render());
  if (state.backupLastRunId) {
    void listBackupRunItems(state.backupLastRunId, true)
      .then((items) => { state.backupFailedItems = items; render(); })
      .catch(() => { state.backupFailedItems = []; render(); });
  }
  render();
});
void bootstrap();
