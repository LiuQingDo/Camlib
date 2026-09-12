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
  type TagDto,
  getMediaPreview,
  getMediaThumbnail,
  listDateFacets,
  listLibraries,
  listTags,
  createTag,
  updateTag,
  deleteTag,
  attachTag,
  detachTag,
  attachTagsBatch,
  detachTagsBatch,
  setRating,
  setRatingsBatch,
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
  setBackupIgnoreExtensions,
  setLibraryRoot,
  setThumbnailCacheDir,
  setUiPrefs,
  listScanRuns,
  getLibraryIndexSummary,
  getAppAbout,
  getThumbnailCacheStats,
  openAppDirectory,
  type AppAboutDto,
  type LibraryAvailability,
  type LibraryIndexSummaryDto,
  type ScanRunDto,
  type ThumbnailCacheStatsDto,
  type UiSortMode,
} from "./api/infrastructure";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import type { ScanProgressDto, PreviewProgressDto } from "./api/media";
import {
  startThumbnailRebuild,
  cancelPreviewJob,
  onPreviewProgress,
} from "./api/media";

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
  /** Selected tag ids for combined filtering (AND). */
  tagIds: Set<string>;
  /** Exact rating filter; null = any. 0 = unrated only. */
  ratingEq: number | null;
  /** Minimum rating filter; null = any. */
  ratingMin: number | null;
  /** All tags known to the library, for filter chips and preview editing. */
  tags: TagDto[];
  /** Projected ratings from the current page, keyed by media id. */
  ratings: Map<string, number>;
  tagsBusy: boolean;
  tagsManagerOpen: boolean;
  tagsManagerBusy: boolean;
  tagsManagerError: string | null;
  /** Tag id awaiting delete confirmation inside the manager. */
  tagDeleteConfirmId: string | null;
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
  settingsOpen: boolean;
  settingsSection: SettingsSection;
  settingsLoading: boolean;
  settingsError: string | null;
  settingsNotice: string | null;
  indexSummary: LibraryIndexSummaryDto | null;
  scanRuns: ScanRunDto[];
  aboutInfo: AppAboutDto | null;
  thumbnailStats: ThumbnailCacheStatsDto | null;
  thumbnailRebuilding: boolean;
  thumbnailJobId: string | null;
  thumbnailProgress: PreviewProgressDto | null;
  fullRebuildConfirm: boolean;
  settingsBusy: boolean;
  libraryStatusReason: string | null;
  thumbnailCacheDir: string;
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
  tagIds: new Set(),
  ratingEq: null,
  ratingMin: null,
  tags: [],
  ratings: new Map(),
  tagsBusy: false,
  tagsManagerOpen: false,
  tagsManagerBusy: false,
  tagsManagerError: null,
  tagDeleteConfirmId: null,
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
  settingsOpen: false,
  settingsSection: "library",
  settingsLoading: false,
  settingsError: null,
  settingsNotice: null,
  indexSummary: null,
  scanRuns: [],
  aboutInfo: null,
  thumbnailStats: null,
  thumbnailRebuilding: false,
  thumbnailJobId: null,
  thumbnailProgress: null,
  fullRebuildConfirm: false,
  settingsBusy: false,
  libraryStatusReason: null,
  thumbnailCacheDir: "",
};

type SettingsSection = "library" | "index" | "thumbnails" | "backup" | "about";

const SETTINGS_SECTIONS: Array<{ id: SettingsSection; label: string }> = [
  { id: "library", label: "媒体库" },
  { id: "index", label: "扫描与索引" },
  { id: "thumbnails", label: "缩略图" },
  { id: "backup", label: "备份默认" },
  { id: "about", label: "关于" },
];

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
// Last loaded preview meta so tag/rating edits can patch the panel in place.
let previewMetaCache: PreviewMetaDto | null = null;
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

function extensionsToInput(list: string[]): string {
  return list.join(", ");
}

function parseExtensionsInput(value: string): string[] {
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => (part.startsWith(".") ? part.toLowerCase() : `.${part.toLowerCase()}`));
}

function truncatePath(path: string | null | undefined, maxLength = 48): string {
  if (!path) return "—";
  if (path.length <= maxLength) return path;
  return `…${path.slice(-(maxLength - 1))}`;
}

function scanRunStatusLabel(status: ScanRunDto["status"]): string {
  if (status === "completed") return "成功";
  if (status === "cancelled") return "已取消";
  if (status === "failed") return "失败";
  return "进行中";
}

function libraryAvailabilityLabel(availability: LibraryAvailability): string {
  if (availability === "available") return "可用";
  if (availability === "disconnected") return "已断开";
  if (availability === "invalid") return "路径无效";
  return "未配置";
}

function hasDateFilter(): boolean {
  return Boolean(state.datePrefix || state.dateFrom || state.dateTo);
}

function hasAnyFilter(): boolean {
  return Boolean(state.search || state.kind || state.datePrefix || state.dateFrom || state.dateTo || state.favoriteOnly || state.burstOnly || state.firstSeenFrom || state.tagIds.size || state.ratingEq !== null || state.ratingMin !== null);
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
  "libraryId" | "kind" | "favoriteOnly" | "burstOnly" | "search" | "datePrefix" | "dateFrom" | "dateTo" | "firstSeenFrom" | "tagIds" | "ratingEq" | "ratingMin" | "sort"
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
  app.querySelector<HTMLButtonElement>("#batch-tag-attach")?.addEventListener("click", () => void applyBatchTag(true));
  app.querySelector<HTMLButtonElement>("#batch-tag-detach")?.addEventListener("click", () => void applyBatchTag(false));
  app.querySelector<HTMLButtonElement>("#batch-rating-apply")?.addEventListener("click", () => void applyBatchRating());
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

async function applyBatchTag(attach: boolean): Promise<void> {
  if (!state.selectedIds.size || state.tagsBusy) return;
  const select = app.querySelector<HTMLSelectElement>("#batch-tag-select");
  const tagId = select?.value.trim();
  if (!tagId) {
    state.error = "请先选择标签";
    render();
    return;
  }
  const ids = [...state.selectedIds];
  state.tagsBusy = true;
  state.error = null;
  applySelectionChrome();
  try {
    if (attach) await attachTagsBatch(ids, tagId);
    else await detachTagsBatch(ids, tagId);
    await refreshTags();
    const tagName = state.tags.find((tag) => tag.id === tagId)?.name ?? "标签";
    state.deleteNotice = attach
      ? `已为 ${formatCount(ids.length)} 项添加「${tagName}」`
      : `已从 ${formatCount(ids.length)} 项移除「${tagName}」`;
  } catch (error) {
    state.error = error instanceof Error ? error.message : "批量更新标签失败";
  } finally {
    state.tagsBusy = false;
    if (state.error || (state.tagIds.has(tagId) && !attach)) {
      render();
      return;
    }
    applySelectionChrome();
    showTransientNotice(state.deleteNotice ?? "");
    state.deleteNotice = null;
  }
}

async function applyBatchRating(): Promise<void> {
  if (!state.selectedIds.size || state.tagsBusy) return;
  const select = app.querySelector<HTMLSelectElement>("#batch-rating-select");
  const raw = select?.value.trim();
  if (raw === "" || raw === undefined) {
    state.error = "请先选择评分";
    render();
    return;
  }
  const rating = Number(raw);
  if (!Number.isInteger(rating) || rating < 0 || rating > 5) {
    state.error = "评分必须是 0–5";
    render();
    return;
  }
  const ids = [...state.selectedIds];
  state.tagsBusy = true;
  state.error = null;
  applySelectionChrome();
  try {
    await setRatingsBatch(ids, rating);
    for (const id of ids) {
      if (rating > 0) state.ratings.set(id, rating);
      else state.ratings.delete(id);
      const item = state.page.items.find((entry) => entry.id === id);
      if (item) item.rating = rating;
    }
    state.deleteNotice = rating === 0
      ? `已清除 ${formatCount(ids.length)} 项评分`
      : `已为 ${formatCount(ids.length)} 项设为 ${rating} 星`;
  } catch (error) {
    state.error = error instanceof Error ? error.message : "批量设置评分失败";
  } finally {
    state.tagsBusy = false;
    if (state.error || state.ratingEq !== null || state.ratingMin !== null) {
      render();
      return;
    }
    applySelectionChrome();
    showTransientNotice(state.deleteNotice ?? "");
    state.deleteNotice = null;
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
    <div class="card-info"><div class="card-title" title="${escapeHtml(item.displayName)}">${escapeHtml(item.displayName)}</div><div class="card-meta"><span>${formatDate(item.captureDate)}</span><span>${formatSize(item.totalSizeBytes)}</span>${item.rating > 0 ? `<span class="card-rating" title="评分 ${item.rating} 星">${"★".repeat(item.rating)}</span>` : ""}</div></div>
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
  const kindGroup = `${kinds}<button class="filter-chip ${state.favoriteOnly ? "is-active" : ""}" type="button" id="favorite-filter">收藏</button><button class="filter-chip ${state.burstOnly ? "is-active" : ""}" type="button" id="burst-filter">连拍</button>`;
  if (!state.tags.length) {
    return `<div class="filter-group">${kindGroup}</div><span class="filter-divider" aria-hidden="true"></span><div class="filter-group filter-group-tags"><button class="filter-chip filter-chip-manage" type="button" id="open-tag-manager">标签管理</button></div>`;
  }
  const tags = state.tags.slice(0, 12).map((tag) => `<button class="filter-chip filter-chip-tag ${state.tagIds.has(tag.id) ? "is-active" : ""}" type="button" data-tag-filter="${escapeHtml(tag.id)}" title="${escapeHtml(tag.name)}${tag.mediaCount != null ? ` · ${tag.mediaCount} 项` : ""}">${escapeHtml(tag.name)}</button>`).join("");
  return `<div class="filter-group">${kindGroup}</div><span class="filter-divider" aria-hidden="true"></span><div class="filter-group filter-group-tags"><span class="filter-group-label">标签</span>${tags}<button class="filter-chip filter-chip-manage" type="button" id="open-tag-manager">管理</button></div>`;
}

function renderRatingFilter(): string {
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
  return `<label class="select-wrap rating-filter"><span>评分</span><select id="rating-filter" aria-label="评分筛选">${options.map((option) => `<option value="${option.value}" ${selected === option.value ? "selected" : ""}>${option.label}</option>`).join("")}</select></label>`;
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
  const tagOptions = state.tags.map((tag) => `<option value="${escapeHtml(tag.id)}">${escapeHtml(tag.name)}</option>`).join("");
  return `<div class="selection-toolbar" aria-label="批量选择工具"><button class="selection-button" id="select-current" type="button">${allSelected ? "取消全选" : "全选当前结果"}</button><span class="selection-summary">${state.selectedIds.size ? `已选 ${formatCount(state.selectedIds.size)} 项 · Shift+点击可范围选择` : "选择媒体后可批量管理 · Shift+点击可范围选择"}</span>${state.selectedIds.size ? `<button class="clear-selection-button" id="clear-selection" type="button">清除选择</button><button class="selection-button" id="favorite-selected" type="button" ${state.favoritesBusy || state.deleting ? "disabled" : ""}>${state.favoritesBusy ? "收藏中…" : "批量收藏"}</button><button class="selection-button" id="unfavorite-selected" type="button" ${state.favoritesBusy || state.deleting ? "disabled" : ""}>${state.favoritesBusy ? "处理中…" : "取消收藏"}</button><span class="batch-tag-row"><select id="batch-tag-select" aria-label="批量标签" ${state.tagsBusy || state.deleting ? "disabled" : ""}><option value="">选择标签…</option>${tagOptions}</select><button class="selection-button" id="batch-tag-attach" type="button" ${state.tagsBusy || state.deleting ? "disabled" : ""}>${state.tagsBusy ? "处理中…" : "打标"}</button><button class="selection-button" id="batch-tag-detach" type="button" ${state.tagsBusy || state.deleting ? "disabled" : ""}>移除</button><select id="batch-rating-select" aria-label="批量评分" ${state.tagsBusy || state.deleting ? "disabled" : ""}><option value="">评分…</option><option value="1">★</option><option value="2">★★</option><option value="3">★★★</option><option value="4">★★★★</option><option value="5">★★★★★</option><option value="0">清除</option></select><button class="selection-button" id="batch-rating-apply" type="button" ${state.tagsBusy || state.deleting ? "disabled" : ""}>应用</button></span><button class="danger-button" id="delete-selected" type="button" ${state.deleting || state.favoritesBusy || state.tagsBusy ? "disabled" : ""}>${state.deleting ? "处理中…" : "移入回收站"}</button>` : ""}</div>`;
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

function openTagManager(): void {
  state.tagsManagerOpen = true;
  state.tagsManagerError = null;
  state.tagDeleteConfirmId = null;
  void refreshTags().then(() => render());
}

function closeTagManager(): void {
  if (state.tagsManagerBusy) return;
  state.tagsManagerOpen = false;
  state.tagDeleteConfirmId = null;
  state.tagsManagerError = null;
  render();
}

function renderTagManager(): string {
  if (!state.tagsManagerOpen) return "";
  const busy = state.tagsManagerBusy;
  const rows = state.tags.length
    ? state.tags.map((tag) => {
        const confirming = state.tagDeleteConfirmId === tag.id;
        return `<li class="tag-manager-row" data-tag-id="${escapeHtml(tag.id)}">
          <span class="tag-manager-swatch" ${tag.color ? `style="background:${escapeHtml(tag.color)}"` : ""}></span>
          <input class="tag-manager-name" data-rename-tag="${escapeHtml(tag.id)}" value="${escapeHtml(tag.name)}" aria-label="标签名称" ${busy ? "disabled" : ""} />
          <span class="tag-manager-count">${formatCount(tag.mediaCount ?? 0)} 项</span>
          ${confirming
            ? `<span class="tag-manager-confirm"><span>删除后无法恢复</span><button type="button" class="danger-button" data-confirm-delete-tag="${escapeHtml(tag.id)}" ${busy ? "disabled" : ""}>确认删除</button><button type="button" class="text-button" data-cancel-delete-tag>取消</button></span>`
            : `<button type="button" class="text-button" data-start-delete-tag="${escapeHtml(tag.id)}" ${busy ? "disabled" : ""}>删除</button>`}
        </li>`;
      }).join("")
    : `<li class="tag-manager-empty">还没有标签，在上方新建一个吧。</li>`;
  return `<div class="modal-backdrop tag-manager-backdrop" id="tag-manager-backdrop" role="presentation">
    <div class="tag-manager" role="dialog" aria-modal="true" aria-labelledby="tag-manager-title">
      <header class="tag-manager-header">
        <div>
          <h2 id="tag-manager-title">标签管理</h2>
          <span>新建、改名或删除标签。给媒体打标时只能选用已有标签。</span>
        </div>
        <button class="icon-button" type="button" id="close-tag-manager" aria-label="关闭标签管理">×</button>
      </header>
      <form class="tag-manager-create" id="tag-create-form">
        <input id="tag-create-name" placeholder="新标签名称" aria-label="新标签名称" autocomplete="off" ${busy ? "disabled" : ""} />
        <button class="primary-button" type="submit" ${busy ? "disabled" : ""}>${busy ? "处理中…" : "新建"}</button>
      </form>
      ${state.tagsManagerError ? `<div class="notice-banner is-error" role="alert"><span class="notice-icon">!</span><span>${escapeHtml(state.tagsManagerError)}</span></div>` : ""}
      <ul class="tag-manager-list">${rows}</ul>
      <footer class="tag-manager-footer">
        <span>改名请直接编辑后按回车或失焦保存</span>
        <button class="outline-button" type="button" id="close-tag-manager-footer">完成</button>
      </footer>
    </div>
  </div>`;
}

function bindTagManagerEvents(): void {
  if (!state.tagsManagerOpen) return;
  app.querySelector<HTMLButtonElement>("#close-tag-manager")?.addEventListener("click", closeTagManager);
  app.querySelector<HTMLButtonElement>("#close-tag-manager-footer")?.addEventListener("click", closeTagManager);
  app.querySelector<HTMLDivElement>("#tag-manager-backdrop")?.addEventListener("click", (event) => {
    if (event.target === event.currentTarget) closeTagManager();
  });
  app.querySelector<HTMLFormElement>("#tag-create-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const input = app.querySelector<HTMLInputElement>("#tag-create-name");
    const name = input?.value.trim() ?? "";
    if (!name || state.tagsManagerBusy) return;
    if (input) input.value = "";
    void (async () => {
      state.tagsManagerBusy = true;
      state.tagsManagerError = null;
      try {
        await createTag(name);
        await refreshTags();
      } catch (error) {
        state.tagsManagerError = error instanceof Error ? error.message : "新建标签失败";
      } finally {
        state.tagsManagerBusy = false;
        render();
      }
    })();
  });
  app.querySelectorAll<HTMLInputElement>("[data-rename-tag]").forEach((input) => {
    const commit = () => {
      const tagId = input.dataset.renameTag;
      if (!tagId || state.tagsManagerBusy) return;
      const tag = state.tags.find((entry) => entry.id === tagId);
      const name = input.value.trim();
      if (!tag || !name || name === tag.name) {
        if (tag) input.value = tag.name;
        return;
      }
      void (async () => {
        state.tagsManagerBusy = true;
        state.tagsManagerError = null;
        try {
          await updateTag(tagId, { name });
          await refreshTags();
          if (previewMetaCache) {
            previewMetaCache = {
              ...previewMetaCache,
              tags: previewMetaCache.tags.map((entry) => entry.id === tagId ? { ...entry, name } : entry),
            };
          }
        } catch (error) {
          state.tagsManagerError = error instanceof Error ? error.message : "重命名标签失败";
          await refreshTags();
        } finally {
          state.tagsManagerBusy = false;
          render();
        }
      })();
    };
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        commit();
      }
    });
    input.addEventListener("blur", commit);
  });
  app.querySelectorAll<HTMLButtonElement>("[data-start-delete-tag]").forEach((button) => {
    button.addEventListener("click", () => {
      state.tagDeleteConfirmId = button.dataset.startDeleteTag ?? null;
      render();
    });
  });
  app.querySelectorAll<HTMLButtonElement>("[data-cancel-delete-tag]").forEach((button) => {
    button.addEventListener("click", () => {
      state.tagDeleteConfirmId = null;
      render();
    });
  });
  app.querySelectorAll<HTMLButtonElement>("[data-confirm-delete-tag]").forEach((button) => {
    button.addEventListener("click", () => {
      const tagId = button.dataset.confirmDeleteTag;
      if (!tagId || state.tagsManagerBusy) return;
      void (async () => {
        state.tagsManagerBusy = true;
        state.tagsManagerError = null;
        try {
          await deleteTag(tagId);
          state.tagIds.delete(tagId);
          if (previewMetaCache) {
            previewMetaCache = {
              ...previewMetaCache,
              tags: previewMetaCache.tags.filter((entry) => entry.id !== tagId),
            };
          }
          await refreshTags();
          state.tagDeleteConfirmId = null;
          if (state.previewIndex !== null) {
            const panel = app.querySelector<HTMLElement>("#modal-meta");
            const item = state.page.items[state.previewIndex];
            if (panel && item && previewMetaCache) {
              panel.innerHTML = renderMetaPanel(previewMetaCache, item);
              bindPreviewMetaEvents(panel, item);
            }
          }
          void refreshMedia();
        } catch (error) {
          state.tagsManagerError = error instanceof Error ? error.message : "删除标签失败";
        } finally {
          state.tagsManagerBusy = false;
          render();
        }
      })();
    });
  });
}

function renderLibrarySwitcher(): string {
  if (!state.libraryFormOpen || !state.library) return "";
  return `<div class="library-form library-change-form"><div class="library-form-actions"><button class="primary-button" id="choose-folder-button" type="button">选择文件夹…</button><button class="text-button" id="library-cancel-button" type="button">取消</button></div><details class="manual-path"><summary>手动输入路径</summary><form id="library-form"><input id="library-path" required value="${escapeHtml(state.rootPath ?? state.library.rootPath)}" placeholder="例如：D:\\照片" aria-label="媒体库路径" /><button class="outline-button" type="submit">确认更换</button></form></details></div>`;
}

function pathRow(label: string, path: string | null | undefined, openKind?: string): string {
  const full = path ?? "";
  return `<div class="settings-path-row">
    <div class="settings-path-copy">
      <span class="settings-path-label">${escapeHtml(label)}</span>
      <span class="settings-path-value" title="${escapeHtml(full)}">${escapeHtml(truncatePath(full))}</span>
    </div>
    <div class="settings-path-actions">
      ${full ? `<button class="text-button" type="button" data-copy-path="${escapeHtml(full)}" title="复制完整路径">复制</button>` : ""}
      ${full && openKind ? `<button class="text-button" type="button" data-open-dir="${escapeHtml(openKind)}">打开</button>` : ""}
    </div>
  </div>`;
}

function renderSettingsLibrarySection(): string {
  const library = state.library;
  const summary = state.indexSummary;
  return `<div class="settings-section-body">
    <div class="settings-status-card">
      <div class="settings-status-head">
        <div>
          <strong>${escapeHtml(library?.volumeLabel || library?.driveLetter ? `${library?.volumeLabel ?? "本地磁盘"} ${library?.driveLetter ? `(${library.driveLetter}:)` : ""}`.trim() : "媒体库")}</strong>
          <span class="settings-status-pill is-${state.availability}">${libraryAvailabilityLabel(state.availability)}</span>
        </div>
      </div>
      ${state.rootPath ? pathRow("根路径", state.rootPath, "library") : `<div class="settings-note">尚未选择媒体库目录。</div>`}
      ${state.libraryStatusReason ? `<div class="settings-note is-warning">${escapeHtml(state.libraryStatusReason)}</div>` : ""}
      <dl class="settings-kv">
        <div><dt>最后扫描</dt><dd>${escapeHtml(formatCaptureAt(library?.lastScanAt ?? null) || "尚未扫描")}</dd></div>
        <div><dt>扫描代数</dt><dd>${library ? formatCount(library.scanGeneration) : "—"}</dd></div>
        <div><dt>媒体项</dt><dd>${summary ? formatCount(summary.totalItems) : library && state.availability === "available" ? formatCount(facetTotal()) : "—"}</dd></div>
        <div><dt>卷 ID</dt><dd class="mono" title="${escapeHtml(library?.volumeId ?? "")}">${escapeHtml(truncatePath(library?.volumeId ?? null, 28))}</dd></div>
      </dl>
      <div class="settings-actions">
        <button class="primary-button" type="button" id="settings-change-library">更换媒体库</button>
        <button class="outline-button" type="button" id="settings-rescan-library" ${state.scanning || !library ? "disabled" : ""}>${state.scanning ? "扫描中…" : "重新扫描"}</button>
        <button class="outline-button" type="button" id="settings-open-app-data">打开数据目录</button>
        <button class="outline-button" type="button" id="settings-open-thumbnail-cache">打开缓存目录</button>
      </div>
    </div>
  </div>`;
}

function renderSettingsIndexSection(): string {
  const summary = state.indexSummary;
  const runs = state.scanRuns;
  return `<div class="settings-section-body">
    <div class="settings-status-card">
      <h3>索引摘要</h3>
      ${summary ? `<div class="settings-stat-grid">
        <div><span>照片</span><strong>${formatCount(summary.photos)}</strong></div>
        <div><span>视频</span><strong>${formatCount(summary.videos)}</strong></div>
        <div><span>实况</span><strong>${formatCount(summary.live)}</strong></div>
        <div><span>收藏</span><strong>${formatCount(summary.favorites)}</strong></div>
        <div><span>离线</span><strong>${formatCount(summary.missing)}</strong></div>
        <div><span>占用</span><strong>${formatSize(summary.totalSizeBytes)}</strong></div>
      </div>
      <div class="settings-note">最后扫描：${escapeHtml(formatCaptureAt(summary.lastScanAt) || "尚未扫描")} · 代数 ${summary.scanGeneration}</div>`
      : `<div class="settings-note">${state.library ? "加载索引摘要…" : "请先连接媒体库。"}</div>`}
      <div class="settings-actions">
        <button class="outline-button" type="button" id="settings-incremental-scan" ${state.scanning || !state.library ? "disabled" : ""}>${state.scanning ? "扫描中…" : "增量扫描"}</button>
        <button class="danger-button" type="button" id="settings-full-rebuild" ${state.scanning || !state.library ? "disabled" : ""}>全量重建索引</button>
      </div>
      ${state.fullRebuildConfirm ? `<div class="settings-confirm">
        <p>全量重建会重新读取库内全部文件的元数据，比增量扫描更耗时。收藏、标签与评分会保留。是否继续？</p>
        <div class="settings-actions">
          <button class="outline-button" type="button" id="settings-full-rebuild-cancel">取消</button>
          <button class="danger-button confirm-danger" type="button" id="settings-full-rebuild-confirm">确认全量重建</button>
        </div>
      </div>` : ""}
      ${state.scanning && state.scanProgress ? `<div class="settings-note">当前：${escapeHtml(scanStatusLabel(state.scanProgress))} · ${escapeHtml(scanPercentLabel(state.scanProgress))}<button class="text-button" type="button" id="settings-scan-cancel">取消扫描</button></div>` : ""}
    </div>
    <div class="settings-status-card">
      <h3>最近扫描</h3>
      ${runs.length ? `<div class="settings-scan-runs">${runs.map((run) => `<div class="settings-scan-run">
        <span class="run-status is-${run.status}">${scanRunStatusLabel(run.status)}</span>
        <span>${escapeHtml(formatCaptureAt(run.startedAt) || run.startedAt)}</span>
        <span>文件 ${formatCount(run.filesSeen)} · 新增 ${formatCount(run.itemsAdded)} · 更新 ${formatCount(run.itemsUpdated)} · 缺失 ${formatCount(run.itemsMissing)}</span>
        ${run.errorSummary ? `<span class="run-error" title="${escapeHtml(run.errorSummary)}">${escapeHtml(run.errorSummary)}</span>` : ""}
      </div>`).join("")}</div>` : `<div class="settings-note">还没有扫描记录。</div>`}
    </div>
  </div>`;
}

function renderSettingsThumbnailSection(): string {
  const stats = state.thumbnailStats;
  const progress = state.thumbnailProgress;
  return `<div class="settings-section-body">
    <div class="settings-status-card">
      <h3>缩略图缓存</h3>
      {pathRowPlaceholder}
      <dl class="settings-kv">
        <div><dt>缓存文件</dt><dd>${stats ? formatCount(stats.fileCount) : "—"}</dd></div>
        <div><dt>占用空间</dt><dd>${stats ? formatSize(stats.totalBytes) : "—"}</dd></div>
      </dl>
      <form class="settings-form" id="settings-thumbnail-form">
        <label><span>缓存目录</span><input id="settings-thumbnail-path" value="${escapeHtml(state.thumbnailCacheDir)}" spellcheck="false" /></label>
        <div class="settings-actions">
          <button class="outline-button" type="button" id="settings-choose-thumbnail">选择文件夹…</button>
          <button class="primary-button" type="submit">保存目录</button>
          <button class="outline-button" type="button" id="settings-rebuild-thumbnails" ${!state.library || state.thumbnailRebuilding ? "disabled" : ""}>${state.thumbnailRebuilding ? "重建中…" : "重建缩略图"}</button>
        </div>
      </form>
      ${progress ? `<div class="settings-note">${progress.state === "running" ? `重建中：${formatCount(progress.processed)} / ${formatCount(progress.total)}` : progress.state === "completed" ? "缩略图重建完成。" : progress.state === "cancelled" ? "缩略图重建已取消。" : `缩略图重建失败：${escapeHtml(progress.error ?? "未知错误")}`}${progress.state === "running" && state.thumbnailJobId ? `<button class="text-button" type="button" id="settings-thumbnail-cancel">取消</button>` : ""}</div>` : ""}
      <div class="settings-note">修改目录后，旧缓存仍留在原位置；需要时可手动清理。</div>
    </div>
  </div>`.replace("{pathRowPlaceholder}", pathRow("当前缓存路径", state.thumbnailCacheDir, "thumbnail_cache"));
}

function renderSettingsBackupSection(): string {
  return `<div class="settings-section-body">
    <div class="settings-status-card">
      <h3>备份默认项</h3>
      <div class="settings-note">这里保存的默认值会与「相机备份」面板共用，避免两处真相。预览时仍可临时调整。</div>
      <div class="settings-form">
        <label><span>默认忽略扩展名</span><input id="settings-ignore-extensions" value="${escapeHtml(state.backupIgnoreExtensions)}" spellcheck="false" placeholder=".dng, .lrv" /></label>
        <label><span>默认冲突策略</span><select id="settings-conflict-policy">
          <option value="skip_same" ${state.backupConflictPolicy === "skip_same" ? "selected" : ""}>跳过冲突</option>
          <option value="rename" ${state.backupConflictPolicy === "rename" ? "selected" : ""}>自动重命名</option>
          <option value="overwrite" ${state.backupConflictPolicy === "overwrite" ? "selected" : ""}>覆盖目标</option>
        </select></label>
        <div class="settings-actions">
          <button class="primary-button" type="button" id="settings-save-backup-defaults">保存默认项</button>
          <button class="outline-button" type="button" id="settings-open-backup-panel">打开备份面板</button>
        </div>
      </div>
    </div>
  </div>`;
}

function renderSettingsAboutSection(): string {
  const about = state.aboutInfo;
  if (!about) {
    return `<div class="settings-section-body"><div class="settings-status-card"><div class="settings-note">加载关于信息…</div></div></div>`;
  }
  const ffmpegOk = about.ffmpeg.available;
  return `<div class="settings-section-body">
    <div class="settings-status-card">
      <h3>Camlib ${escapeHtml(about.version)}</h3>
      <div class="settings-note">本地媒体库。索引与备份数据保存在应用数据目录；设置写入 settings.json。</div>
      ${pathRow("应用数据目录", about.appDataDir, "app_data")}
      ${pathRow("应用缓存目录", about.appCacheDir, "app_cache")}
      ${pathRow("数据库", about.databasePath)}
      ${pathRow("设置文件", about.settingsPath)}
      ${pathRow("缩略图缓存", about.thumbnailCacheDir, "thumbnail_cache")}
      <div class="settings-ffmpeg ${ffmpegOk ? "is-ok" : "is-missing"}">
        <strong>ffmpeg</strong>
        <span>${ffmpegOk ? "可用" : "不可用"}</span>
        ${about.ffmpeg.path ? `<span class="mono" title="${escapeHtml(about.ffmpeg.path)}">${escapeHtml(truncatePath(about.ffmpeg.path))}</span>` : ""}
        ${about.ffmpeg.message ? `<span class="settings-note">${escapeHtml(about.ffmpeg.message)}</span>` : ""}
      </div>
      <div class="settings-note">缺失 ffmpeg 时，视频缩略图与部分预览会失败。开发环境可安装到 PATH，打包环境请提供 resources/ffmpeg/ffmpeg.exe。</div>
    </div>
  </div>`;
}

function settingsSectionBodyHtml(): string {
  if (state.settingsSection === "library") return renderSettingsLibrarySection();
  if (state.settingsSection === "index") return renderSettingsIndexSection();
  if (state.settingsSection === "thumbnails") return renderSettingsThumbnailSection();
  if (state.settingsSection === "backup") return renderSettingsBackupSection();
  return renderSettingsAboutSection();
}

function settingsContentHtml(): string {
  return `${state.settingsLoading ? `<div class="settings-note">加载中…</div>` : ""}${state.settingsError ? `<div class="settings-note is-danger">${escapeHtml(state.settingsError)}</div>` : ""}${state.settingsNotice ? `<div class="settings-note is-success">${escapeHtml(state.settingsNotice)}</div>` : ""}${settingsSectionBodyHtml()}`;
}

function renderSettingsPanel(): string {
  if (!state.settingsOpen) return "";
  return `<div class="modal-backdrop settings-backdrop" id="settings-backdrop" role="presentation">
    <div class="settings-panel" role="dialog" aria-modal="true" aria-labelledby="settings-title">
      <header class="settings-header">
        <div>
          <h2 id="settings-title">设置</h2>
          <span>库状态 · 索引 · 缩略图 · 备份默认 · 关于</span>
        </div>
        <button class="icon-button" type="button" id="settings-close" aria-label="关闭设置">×</button>
      </header>
      <div class="settings-layout">
        <nav class="settings-nav" aria-label="设置分区">
          ${SETTINGS_SECTIONS.map((section) => `<button type="button" class="settings-nav-item ${state.settingsSection === section.id ? "is-active" : ""}" data-settings-section="${section.id}">${section.label}</button>`).join("")}
        </nav>
        <div class="settings-content" id="settings-content">
          ${settingsContentHtml()}
        </div>
      </div>
    </div>
  </div>`;
}

/**
 * Patch only the settings dialog. Full `render()` rebuilds the whole shell and
 * remounts every media thumbnail — that is what made tab switches flicker.
 */
function updateSettingsPanel(): void {
  if (!state.settingsOpen) return;
  const content = app.querySelector<HTMLElement>("#settings-content");
  if (!content) {
    render();
    return;
  }
  content.innerHTML = settingsContentHtml();
  content.classList.remove("is-swap");
  // Restart the fade so consecutive tab switches stay calm instead of popping.
  void content.offsetWidth;
  content.classList.add("is-swap");
  app.querySelectorAll<HTMLButtonElement>("[data-settings-section]").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.settingsSection === state.settingsSection);
  });
  bindSettingsEvents();
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
    <div class="brand"><span class="brand-mark">C</span><div><strong>Camlib</strong><span>媒体库</span></div><button class="icon-button brand-settings" type="button" id="settings-button-top" title="设置" aria-label="打开设置">⚙</button></div>
    <div class="sidebar-section library-section"><div class="section-label"><span>媒体库</span>${state.library ? `<span class="section-actions"><button class="icon-button" id="change-library-button" title="更换媒体库" aria-label="更换媒体库">⇄</button><button class="icon-button" id="refresh-button" title="刷新状态" aria-label="刷新状态">↻</button></span>` : ""}</div>${state.library ? `<div class="library-entry ${state.availability !== "available" ? "is-offline" : ""}"><span class="drive-icon">▣</span><div><strong>${escapeHtml(state.library.volumeLabel || state.library.driveLetter ? `${state.library.volumeLabel ?? "本地磁盘"} ${state.library.driveLetter ? `(${state.library.driveLetter}:)` : ""}` : "已连接媒体库")}</strong><span>${state.availability === "available" ? `${formatCount(facetTotal())} 个媒体` : "暂时不可用"}</span></div><span class="status-dot"></span></div>${renderLibrarySwitcher()}` : `<div class="library-entry is-empty"><span class="drive-icon">＋</span><div><strong>添加媒体库</strong><span>选择一个目录开始</span></div></div>`}</div>
    <nav class="sidebar-section date-section" aria-label="按日期浏览"><div class="section-label"><span>按日期浏览</span></div>${renderDateNavigation()}</nav>
    <div class="sidebar-footer"><span class="footer-dot"></span><span>${state.availability === "available" ? "索引已连接" : state.availability === "unconfigured" ? "等待连接" : "等待设备"}</span><label class="auto-scan-toggle" title="启动时自动增量扫描"><input id="auto-scan-toggle" type="checkbox" ${state.autoScanOnStartup ? "checked" : ""} aria-label="启动时自动扫描" /><span>启动扫描</span></label><button class="icon-button" title="扫描媒体库" id="scan-button" aria-label="扫描媒体库">⟳</button><button class="icon-button" title="设置" id="settings-button" aria-label="打开设置">⚙</button></div>
  </aside><main class="content">
    <header class="topbar"><div class="title-block"><div class="eyebrow">${primaryDateLabel() ? `筛选 · ${primaryDateLabel()}` : "媒体总览"}</div><h1>${primaryDateLabel() || "所有媒体"}</h1><span class="result-count">${formatCount(state.page.total)} 个项目</span>${hasAnyFilter() ? `<button class="text-button clear-all-filters" id="clear-all-filters" type="button">清除筛选</button>` : ""}</div><div class="top-actions"><div class="search-box"><span aria-hidden="true">⌕</span><input id="search-input" value="${escapeHtml(searchDraft)}" placeholder="搜索文件名" aria-label="搜索文件名" /><kbd>/</kbd><button class="search-button" id="search-button" type="button">搜索</button></div><button class="outline-button" id="scan-top-button" type="button">${state.scanning ? "扫描中…" : "扫描媒体库"}</button></div></header>
    ${state.firstSeenFrom ? `<div class="notice-banner" role="status"><span class="notice-icon">↓</span><div><strong>正在查看新导入</strong><span>按首次入库时间筛选（备份完成后自动扫描的结果）。可用「清除筛选」恢复全部媒体。</span></div></div>` : ""}
    ${renderStatusBanner()}${renderDeleteFeedback()}<div class="sticky-controls"><div class="toolbar"><div class="filter-column"><div class="filter-row">${renderKindFilters()}</div>${renderDateRangeControls()}</div><div class="toolbar-right">${renderRatingFilter()}<label class="select-wrap"><span>排序</span><select id="sort-select" aria-label="排序"><option value="newest" ${state.sort === "newest" ? "selected" : ""}>最新</option><option value="oldest" ${state.sort === "oldest" ? "selected" : ""}>最早</option><option value="name" ${state.sort === "name" ? "selected" : ""}>文件名</option><option value="rating-desc" ${state.sort === "rating-desc" ? "selected" : ""}>评分高→低</option><option value="rating-asc" ${state.sort === "rating-asc" ? "selected" : ""}>评分低→高</option></select></label><label class="density-control" title="缩略图密度"><span>▦</span><input id="density-input" type="range" min="1" max="5" value="${state.density}" aria-label="缩略图密度" /><span>▦</span></label></div></div>${renderSelectionToolbar()}</div>
    <section class="media-area" aria-live="polite">${hasItems ? `${renderMediaGrid()}${state.page.total > state.page.items.length ? `<button class="load-more" id="load-more" type="button">加载更多 · 已显示 ${state.page.items.length} / ${state.page.total}</button>` : ""}` : renderLibraryEmpty()}</section></main></div>${state.previewIndex !== null ? renderPreview() : ""}${renderDeleteConfirm()}${renderTagManager()}${renderSettingsPanel()}`;
  bindEvents();
  bindTagManagerEvents();
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
  app.querySelectorAll<HTMLButtonElement>("[data-tag-filter]").forEach((button) => button.addEventListener("click", () => {
    const tagId = button.dataset.tagFilter;
    if (!tagId) return;
    if (state.tagIds.has(tagId)) state.tagIds.delete(tagId);
    else state.tagIds.add(tagId);
    void refreshMedia();
  }));
  app.querySelector<HTMLButtonElement>("#open-tag-manager")?.addEventListener("click", () => openTagManager());
  app.querySelector<HTMLSelectElement>("#rating-filter")?.addEventListener("change", (event) => {
    const value = (event.target as HTMLSelectElement).value;
    state.ratingEq = null;
    state.ratingMin = null;
    if (value.startsWith("eq:")) state.ratingEq = Number(value.slice(3));
    else if (value.startsWith("min:")) state.ratingMin = Number(value.slice(4));
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
    state.tagIds.clear();
    state.ratingEq = null;
    state.ratingMin = null;
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
  bindSettingsEvents();
}

function bindSettingsEvents(): void {
  const once = (element: HTMLElement | null, handler: (event: Event) => void): void => {
    if (!element || element.dataset.bound) return;
    element.dataset.bound = "1";
    element.addEventListener("click", handler);
  };
  once(app.querySelector<HTMLElement>("#settings-button"), () => void openSettings());
  once(app.querySelector<HTMLElement>("#settings-button-top"), () => void openSettings());
  once(app.querySelector<HTMLElement>("#settings-close"), () => closeSettings());
  const backdrop = app.querySelector<HTMLElement>("#settings-backdrop");
  if (backdrop && !backdrop.dataset.bound) {
    backdrop.dataset.bound = "1";
    backdrop.addEventListener("click", (event) => {
      if (event.target === event.currentTarget) closeSettings();
    });
  }
  app.querySelectorAll<HTMLButtonElement>("[data-settings-section]").forEach((button) => {
    if (button.dataset.bound) return;
    button.dataset.bound = "1";
    button.addEventListener("click", () => {
      const section = button.dataset.settingsSection as SettingsSection | undefined;
      if (!section || section === state.settingsSection) return;
      state.settingsSection = section;
      state.settingsError = null;
      state.settingsNotice = null;
      state.fullRebuildConfirm = false;
      state.settingsLoading = true;
      updateSettingsPanel();
      void loadSettingsSectionData().finally(() => {
        state.settingsLoading = false;
        updateSettingsPanel();
      });
    });
  });
  bindSettingsBodyEvents();
}

/** Rebind only controls inside the patchable settings content area. */
function bindSettingsBodyEvents(): void {
  app.querySelectorAll<HTMLButtonElement>("[data-copy-path]").forEach((button) => {
    button.addEventListener("click", () => {
      const path = button.dataset.copyPath;
      if (!path) return;
      void navigator.clipboard.writeText(path).then(() => {
        state.settingsNotice = "已复制完整路径";
        updateSettingsPanel();
      }).catch(() => {
        state.settingsError = "复制路径失败";
        updateSettingsPanel();
      });
    });
  });
  app.querySelectorAll<HTMLButtonElement>("[data-open-dir]").forEach((button) => {
    button.addEventListener("click", () => void openDirectory(button.dataset.openDir as "app_data" | "app_cache" | "thumbnail_cache" | "library"));
  });
  app.querySelector<HTMLButtonElement>("#settings-change-library")?.addEventListener("click", () => {
    closeSettings(false);
    state.libraryFormOpen = true;
    render();
  });
  app.querySelector<HTMLButtonElement>("#settings-rescan-library")?.addEventListener("click", () => void runSettingsScan(false));
  app.querySelector<HTMLButtonElement>("#settings-incremental-scan")?.addEventListener("click", () => void runSettingsScan(false));
  app.querySelector<HTMLButtonElement>("#settings-full-rebuild")?.addEventListener("click", () => {
    state.fullRebuildConfirm = true;
    state.settingsError = null;
    updateSettingsPanel();
  });
  app.querySelector<HTMLButtonElement>("#settings-full-rebuild-cancel")?.addEventListener("click", () => {
    state.fullRebuildConfirm = false;
    updateSettingsPanel();
  });
  app.querySelector<HTMLButtonElement>("#settings-full-rebuild-confirm")?.addEventListener("click", () => void runSettingsScan(true));
  app.querySelector<HTMLButtonElement>("#settings-scan-cancel")?.addEventListener("click", () => void cancelCurrentScan());
  app.querySelector<HTMLButtonElement>("#settings-choose-thumbnail")?.addEventListener("click", () => void chooseThumbnailCacheFolder());
  app.querySelector<HTMLFormElement>("#settings-thumbnail-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const input = app.querySelector<HTMLInputElement>("#settings-thumbnail-path");
    if (input?.value.trim()) void saveThumbnailCacheDir(input.value.trim());
  });
  app.querySelector<HTMLButtonElement>("#settings-rebuild-thumbnails")?.addEventListener("click", () => void runThumbnailRebuild());
  app.querySelector<HTMLButtonElement>("#settings-thumbnail-cancel")?.addEventListener("click", () => void cancelThumbnailRebuild());
  app.querySelector<HTMLButtonElement>("#settings-save-backup-defaults")?.addEventListener("click", () => void saveBackupDefaults());
  app.querySelector<HTMLButtonElement>("#settings-open-backup-panel")?.addEventListener("click", () => {
    closeSettings();
    void openBackupPanel();
  });
  app.querySelector<HTMLButtonElement>("#settings-open-app-data")?.addEventListener("click", () => void openDirectory("app_data"));
  app.querySelector<HTMLButtonElement>("#settings-open-thumbnail-cache")?.addEventListener("click", () => void openDirectory("thumbnail_cache"));
}

async function openSettings(): Promise<void> {
  if (state.settingsOpen) return;
  state.settingsOpen = true;
  state.settingsLoading = true;
  state.settingsError = null;
  state.settingsNotice = null;
  state.fullRebuildConfirm = false;
  render();
  try {
    await loadSettingsSectionData();
  } finally {
    state.settingsLoading = false;
    updateSettingsPanel();
  }
}

function closeSettings(rerender = true): void {
  state.settingsOpen = false;
  state.fullRebuildConfirm = false;
  state.settingsError = null;
  state.settingsNotice = null;
  if (rerender) render();
}

async function loadSettingsSectionData(): Promise<void> {
  try {
    if (state.settingsSection === "library" || state.settingsSection === "index") {
      if (state.library) {
        const [summary, runs] = await Promise.all([
          getLibraryIndexSummary(state.library.id),
          listScanRuns(state.library.id, 8),
        ]);
        state.indexSummary = summary;
        state.scanRuns = runs;
      } else {
        state.indexSummary = null;
        state.scanRuns = [];
      }
    }
    if (state.settingsSection === "thumbnails") {
      state.thumbnailCacheDir = state.thumbnailCacheDir || "";
      const stats = await getThumbnailCacheStats();
      state.thumbnailStats = stats;
      state.thumbnailCacheDir = stats.path;
    }
    if (state.settingsSection === "about") {
      state.aboutInfo = await getAppAbout();
    }
    if (state.settingsSection === "backup") {
      // Values already live in state from bootstrap; refresh if settings panel is the source of truth.
      const infra = await getInfrastructureState();
      state.backupConflictPolicy = infra.settings.backup_conflict_policy;
      state.backupIgnoreExtensions = extensionsToInput(infra.settings.backup_ignore_extensions);
      state.autoScanOnStartup = infra.settings.auto_scan_on_startup;
      state.thumbnailCacheDir = infra.settings.thumbnail_cache_dir;
    }
  } catch (error) {
    state.settingsError = error instanceof Error ? error.message : "加载设置失败";
  }
}

async function openDirectory(which: "app_data" | "app_cache" | "thumbnail_cache" | "library"): Promise<void> {
  try {
    await openAppDirectory(which);
    state.settingsError = null;
  } catch (error) {
    state.settingsError = error instanceof Error ? error.message : "打开目录失败";
    updateSettingsPanel();
  }
}

async function runSettingsScan(full: boolean): Promise<void> {
  if (!state.library || state.scanning) return;
  state.fullRebuildConfirm = false;
  state.settingsError = null;
  state.settingsNotice = full ? "正在全量重建索引…" : "正在增量扫描…";
  updateSettingsPanel();
  try {
    const start = await startLibraryScan(state.library.id, full);
    if (!state.scanning) return;
    const reported = state.scanProgress as ScanProgressDto | null;
    if (reported && reported.jobId === start.jobId) return;
    state.scanProgress = {
      jobId: start.jobId,
      kind: "scan",
      seq: 0,
      phase: "discovering",
      state: "running",
      current: null,
      processed: 0,
      total: 0,
      errors: [],
      error: null,
    };
    updateSettingsPanel();
  } catch (error) {
    state.settingsError = error instanceof Error ? error.message : "无法开始扫描";
    state.settingsNotice = null;
    updateSettingsPanel();
  }
}

async function chooseThumbnailCacheFolder(): Promise<void> {
  try {
    const selected = await openFileDialog({
      directory: true,
      multiple: false,
      title: "选择缩略图缓存文件夹",
    });
    if (typeof selected === "string" && selected.trim()) {
      state.thumbnailCacheDir = selected.trim();
      updateSettingsPanel();
    }
  } catch (error) {
    state.settingsError = error instanceof Error ? error.message : "打开文件夹选择器失败";
    updateSettingsPanel();
  }
}

/** Prefer in-place settings patch when the dialog is open (avoids full-shell flash). */
function renderSettingsAware(): void {
  if (state.settingsOpen) updateSettingsPanel();
  else render();
}

async function saveThumbnailCacheDir(path: string): Promise<void> {
  state.settingsBusy = true;
  state.settingsError = null;
  try {
    const settings = await setThumbnailCacheDir(path);
    state.thumbnailCacheDir = settings.thumbnail_cache_dir;
    const stats = await getThumbnailCacheStats();
    state.thumbnailStats = stats;
    state.settingsNotice = "缩略图目录已更新";
  } catch (error) {
    state.settingsError = error instanceof Error ? error.message : "保存缩略图目录失败";
  } finally {
    state.settingsBusy = false;
    renderSettingsAware();
  }
}

async function runThumbnailRebuild(): Promise<void> {
  if (!state.library || state.thumbnailRebuilding) return;
  state.settingsError = null;
  state.settingsNotice = "正在重建缩略图…";
  state.thumbnailRebuilding = true;
  state.thumbnailProgress = null;
  renderSettingsAware();
  try {
    const start = await startThumbnailRebuild(state.library.id);
    state.thumbnailJobId = start.jobId;
  } catch (error) {
    state.thumbnailRebuilding = false;
    state.settingsError = error instanceof Error ? error.message : "无法开始重建缩略图";
    state.settingsNotice = null;
    renderSettingsAware();
  }
}

async function cancelThumbnailRebuild(): Promise<void> {
  if (!state.thumbnailJobId) return;
  try {
    await cancelPreviewJob(state.thumbnailJobId);
  } catch (error) {
    state.settingsError = error instanceof Error ? error.message : "无法取消缩略图重建";
    renderSettingsAware();
  }
}

async function saveBackupDefaults(): Promise<void> {
  const ignoreInput = app.querySelector<HTMLInputElement>("#settings-ignore-extensions");
  const policySelect = app.querySelector<HTMLSelectElement>("#settings-conflict-policy");
  const extensions = parseExtensionsInput(ignoreInput?.value ?? state.backupIgnoreExtensions);
  const policy = (policySelect?.value as ConflictPolicy | undefined) ?? state.backupConflictPolicy;
  state.settingsBusy = true;
  state.settingsError = null;
  try {
    await setBackupIgnoreExtensions(extensions);
    const settings = await setBackupConflictPolicy(policy);
    state.backupConflictPolicy = settings.backup_conflict_policy;
    state.backupIgnoreExtensions = extensionsToInput(settings.backup_ignore_extensions);
    state.settingsNotice = "备份默认项已保存";
  } catch (error) {
    state.settingsError = error instanceof Error ? error.message : "保存备份默认项失败";
  } finally {
    state.settingsBusy = false;
    renderSettingsAware();
  }
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

function renderStars(rating: number, interactive: boolean, mediaId?: string): string {
  const stars = [1, 2, 3, 4, 5].map((value) => {
    const filled = value <= rating;
    if (interactive) {
      return `<button type="button" class="star-button ${filled ? "is-filled" : ""}" data-set-rating="${value}" data-media-id="${escapeHtml(mediaId ?? "")}" aria-label="${value} 星" aria-pressed="${filled}">★</button>`;
    }
    return `<span class="star-glyph ${filled ? "is-filled" : ""}" aria-hidden="true">★</span>`;
  }).join("");
  return `<span class="star-row" role="img" aria-label="评分 ${rating} / 5">${stars}${rating === 0 ? `<span class="star-empty-label">未评分</span>` : ""}</span>`;
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
  const files = meta.files.map((file) => `<li class="meta-file ${file.existsNow ? "" : "is-missing"}"><span class="meta-file-role">${fileRoleLabel(file.role)}</span><span class="meta-file-name" title="${escapeHtml(file.relativePath)}">${escapeHtml(file.fileName)}</span><span class="meta-file-size">${formatSize(file.sizeBytes)}</span>${file.existsNow ? "" : `<span class="meta-file-state">缺失</span>`}</li>`).join("");
  const tagChips = meta.tags.map((tag) => `<span class="tag-chip" ${tag.color ? `style="--tag-accent:${escapeHtml(tag.color)}"` : ""}><span>${escapeHtml(tag.name)}</span><button type="button" class="tag-remove" data-remove-tag="${escapeHtml(tag.id)}" aria-label="移除标签 ${escapeHtml(tag.name)}">×</button></span>`).join("");
  const remainingTags = state.tags.filter((tag) => !meta.tags.some((attached) => attached.id === tag.id));
  const tagSuggestions = remainingTags
    .map((tag) => `<button type="button" class="tag-suggest" data-add-tag="${escapeHtml(tag.id)}">${escapeHtml(tag.name)}</button>`)
    .join("");
  return `<div class="meta-panel-body">
    <h3>媒体信息</h3>
    <div class="meta-rating-block">
      <span class="meta-rating-label">评分</span>
      ${renderStars(meta.rating, true, item.id)}
      ${meta.rating > 0 ? `<button type="button" class="text-button" data-set-rating="0" data-media-id="${escapeHtml(item.id)}">清除</button>` : ""}
    </div>
    <dl class="meta-list">${rows.map(([label, value]) => `<div class="meta-row"><dt>${label}</dt><dd>${escapeHtml(String(value))}</dd></div>`).join("")}</dl>
    <div class="meta-tags-block">
      <div class="meta-tags-head">
        <h4>标签</h4>
        <button type="button" class="text-button" id="open-tag-manager-from-preview">管理标签</button>
      </div>
      <div class="tag-chip-row" id="preview-tag-chips">${tagChips || `<span class="tag-empty">暂无标签</span>`}</div>
      ${remainingTags.length
        ? `<div class="tag-suggest-row">${tagSuggestions}</div>`
        : (state.tags.length ? `<div class="tag-empty">该媒体已带有全部标签</div>` : `<div class="tag-empty">还没有标签，请先在「标签管理」中新建</div>`)}
    </div>
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

function bindPreviewMetaEvents(panel: HTMLElement, item: MediaItemDto): void {
  panel.querySelectorAll<HTMLButtonElement>("[data-set-rating]").forEach((button) => {
    button.addEventListener("click", () => {
      const rating = Number(button.dataset.setRating);
      const mediaId = button.dataset.mediaId || item.id;
      void applyPreviewRating(panel, item, mediaId, rating);
    });
  });
  panel.querySelectorAll<HTMLButtonElement>("[data-remove-tag]").forEach((button) => {
    button.addEventListener("click", () => {
      const tagId = button.dataset.removeTag;
      if (!tagId) return;
      void applyPreviewTag(panel, item, tagId, "remove");
    });
  });
  panel.querySelectorAll<HTMLButtonElement>("[data-add-tag]").forEach((button) => {
    button.addEventListener("click", () => {
      const tagId = button.dataset.addTag;
      if (!tagId) return;
      void applyPreviewTag(panel, item, tagId, "add");
    });
  });
  panel.querySelector<HTMLButtonElement>("#open-tag-manager-from-preview")?.addEventListener("click", () => {
    openTagManager();
  });
}

async function applyPreviewRating(
  panel: HTMLElement,
  item: MediaItemDto,
  mediaId: string,
  rating: number,
): Promise<void> {
  try {
    await setRating(mediaId, rating);
    item.rating = rating;
    if (rating > 0) state.ratings.set(mediaId, rating);
    else state.ratings.delete(mediaId);
    if (previewMetaCache) {
      previewMetaCache = { ...previewMetaCache, rating };
      panel.innerHTML = renderMetaPanel(previewMetaCache, item);
      bindPreviewMetaEvents(panel, item);
    }
  } catch (error) {
    state.error = error instanceof Error ? error.message : "更新评分失败";
    render();
  }
}

async function applyPreviewTag(
  panel: HTMLElement,
  item: MediaItemDto,
  tagId: string | null,
  mode: "add" | "remove",
): Promise<void> {
  const mediaId = item.id;
  try {
    if (mode === "add" && tagId) {
      await attachTag(mediaId, tagId);
      const tag = state.tags.find((entry) => entry.id === tagId);
      if (tag && previewMetaCache && !previewMetaCache.tags.some((entry) => entry.id === tagId)) {
        previewMetaCache = { ...previewMetaCache, tags: [...previewMetaCache.tags, tag] };
      }
    } else if (mode === "remove" && tagId) {
      await detachTag(mediaId, tagId);
      if (previewMetaCache) {
        previewMetaCache = {
          ...previewMetaCache,
          tags: previewMetaCache.tags.filter((entry) => entry.id !== tagId),
        };
      }
    } else {
      return;
    }
    await refreshTags();
    if (previewMetaCache) {
      // Keep counts roughly fresh without another preview fetch.
      previewMetaCache = {
        ...previewMetaCache,
        tags: previewMetaCache.tags.map((tag) => ({
          ...tag,
          mediaCount: state.tags.find((entry) => entry.id === tag.id)?.mediaCount ?? tag.mediaCount,
        })),
      };
      panel.innerHTML = renderMetaPanel(previewMetaCache, item);
      bindPreviewMetaEvents(panel, item);
    }
    // If the active filter requires this tag and we just removed it, refresh.
    if (mode === "remove" && tagId && state.tagIds.has(tagId)) {
      void refreshMedia();
    }
  } catch (error) {
    state.error = error instanceof Error ? error.message : "更新标签失败";
    render();
  }
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
    previewMetaCache = preview.meta;
    if (metaPanel) {
      metaPanel.innerHTML = renderMetaPanel(preview.meta, item);
      bindPreviewMetaEvents(metaPanel, item);
    }
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
  previewMetaCache = null;
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
  if (!state.library) { renderSettingsAware(); return; }
  const token = ++mediaQueryToken;
  state.loading = true; state.error = null; renderSettingsAware();
  try {
    const page = await queryMedia({ ...currentQueryFields(), limit: 120 });
    if (token !== mediaQueryToken) return;
    state.page = page;
    state.selectedIds.clear();
    state.lastSelectIndex = null;
    state.favorites = new Set(state.page.items.filter((item) => item.favorite).map((item) => item.id));
    state.ratings = new Map(state.page.items.filter((item) => item.rating > 0).map((item) => [item.id, item.rating]));
  }
  catch (error) {
    if (token !== mediaQueryToken) return;
    state.error = error instanceof Error ? error.message : "读取媒体索引失败";
  }
  finally {
    if (token === mediaQueryToken) {
      state.loading = false;
      renderSettingsAware();
      // A filter change starts a new result list; keep the viewport at the top
      // so the user does not land mid-page on unrelated items.
      if (!state.settingsOpen) scrollToContentTop();
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
    next.items.forEach((item) => {
      if (item.favorite) state.favorites.add(item.id);
      if (item.rating > 0) state.ratings.set(item.id, item.rating);
    });
    render();
  }
  catch (error) {
    if (token !== mediaQueryToken) return;
    state.error = error instanceof Error ? error.message : "加载更多媒体失败"; render();
  }
}

async function refreshTags(): Promise<void> {
  try {
    state.tags = await listTags();
  } catch {
    // Filter chips stay usable with the previous list; preview can still edit.
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
    state.ratings.delete(id);
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
  state.error = null; state.scanning = true; state.scanProgress = null; renderSettingsAware();
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
    renderSettingsAware();
  }
  catch (error) { state.scanning = false; state.error = error instanceof Error ? error.message : "无法开始扫描"; renderSettingsAware(); }
}

async function cancelCurrentScan(): Promise<void> {
  if (!state.scanProgress || state.scanProgress.state !== "running") return;
  try { await cancelLibraryScan(state.scanProgress.jobId); }
  catch (error) { state.error = error instanceof Error ? error.message : "无法取消扫描"; renderSettingsAware(); }
}

async function bootstrap(): Promise<void> {
  state.loading = true; state.error = null; renderSettingsAware();
  try {
    const [infra, libraries] = await Promise.all([getInfrastructureState(), listLibraries()]);
    state.backupConflictPolicy = infra.settings.backup_conflict_policy;
    state.backupIgnoreExtensions = extensionsToInput(infra.settings.backup_ignore_extensions);
    state.thumbnailCacheDir = infra.settings.thumbnail_cache_dir;
    state.density = clampDensity(infra.settings.ui_density);
    state.sort = infra.settings.ui_sort;
    state.autoScanOnStartup = infra.settings.auto_scan_on_startup;
    state.libraries = libraries; state.availability = infra.library_status.availability; state.rootPath = infra.library_status.root_path; state.libraryStatusReason = infra.library_status.reason; state.library = libraries.find((library) => library.rootPath === infra.library_status.root_path) ?? libraries[0] ?? null;
    if (state.library && state.availability === "available") {
      state.facets = await listDateFacets(state.library.id);
      resetSidebarExpansionForSelection();
      void refreshTags();
      await refreshMedia();
      void maybeAutoScan();
    }
    else { state.page = { items: [], total: 0, offset: 0, limit: 120 }; state.facets = []; state.loading = false; renderSettingsAware(); }
  } catch (error) { state.loading = false; state.error = error instanceof Error ? error.message : "初始化媒体库失败"; renderSettingsAware(); }
}

window.addEventListener("keydown", (event) => {
  if (state.tagsManagerOpen) {
    if (event.key === "Escape") {
      event.preventDefault();
      closeTagManager();
    }
    return;
  }
  if (state.settingsOpen) {
    if (event.key === "Escape") {
      event.preventDefault();
      if (state.fullRebuildConfirm) {
        state.fullRebuildConfirm = false;
        updateSettingsPanel();
      } else {
        closeSettings();
      }
      return;
    }
    return;
  }
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
    if (progress.state === "completed") {
      state.settingsNotice = "扫描完成";
      state.fullRebuildConfirm = false;
    }
    if (state.settingsOpen) {
      updateSettingsPanel();
      void bootstrap().then(() => {
        if (state.settingsOpen) void loadSettingsSectionData().then(() => updateSettingsPanel());
      });
    } else {
      render();
      void bootstrap();
    }
    return;
  }
  if (!state.scanProgress || progress.jobId !== state.scanProgress.jobId) {
    state.scanning = true;
    state.scanProgress = progress;
    renderSettingsAware();
    return;
  }
  state.scanProgress = progress;
  updateScanProgressView();
});
void onPreviewProgress((progress) => {
  if (!state.thumbnailJobId && progress.state === "running") return;
  if (state.thumbnailJobId && progress.jobId !== state.thumbnailJobId && progress.state === "running") return;
  state.thumbnailProgress = progress;
  if (progress.state === "running") {
    state.thumbnailRebuilding = true;
    renderSettingsAware();
    return;
  }
  state.thumbnailRebuilding = false;
  if (state.thumbnailJobId && progress.jobId !== state.thumbnailJobId) return;
  state.thumbnailJobId = null;
  state.settingsNotice =
    progress.state === "completed"
      ? "缩略图重建完成"
      : progress.state === "cancelled"
        ? "缩略图重建已取消"
        : progress.error
          ? `缩略图重建失败：${progress.error}`
          : "缩略图重建结束";
  if (state.settingsOpen) void loadSettingsSectionData().then(() => updateSettingsPanel());
  else render();
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
