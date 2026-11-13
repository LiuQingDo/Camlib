// 由 main.ts 拆分而来：仅做搬移，未改动逻辑。
import { toUserMessage } from "../api/errors";
import {
  DialogSize,
  ScanRunDto,
  UiPreviewMode,
  UiTheme,
  ffmpegAvailable,
  getInfrastructureState,
  listScanRuns,
  setBackupConflictPolicy,
  setBackupMergeSegments,
  setLibraryRoot,
  setUiPrefs,
} from "../api/infrastructure";
import {
  BackupRunDto,
  ConflictPolicy,
  ScanProgressDto,
  cancelBackup,
  cancelLibraryMerge,
  cancelLibraryScan,
  discoverBackupSources,
  listBackupHistory,
  listDateFacets,
  listLibraries,
  previewBackup,
  previewLibraryMerge,
  retryFailedBackup,
  startBackup,
  startLibraryMerge,
  startLibraryScan,
} from "../api/media";
import { extensionsToInput } from "../lib/filters";
import { formatCaptureAt, formatCount, formatSize } from "../lib/format";
import { app } from "../render/context";
import { refreshMedia, render, renderSettingsAware } from "../render/paint";
import { renderShell } from "../render/shell";
import { willCopyCount } from "../render/text";
import { patchToolbar, resetSidebarExpansionForSelection, searchUi } from "../render/toolbar";
import { SortMode, state } from "../state";
import { sanitizeDialogSizes } from "../views/dialogs";
import { updateSettingsPanel } from "../views/settings";
import { refreshTags } from "./media-query";
import {
  applyTheme,
  clampDensity,
  clampPreviewMode,
  clampSort,
  clampTheme,
  loadAiStats,
  syncThemeToggle,
} from "./settings-ops";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";

// Bootstrap re-runs after every scan terminal event. Auto-scan must only fire
// for the first successful launch of this session so completion cannot loop.
export let startupAutoScanStarted = false;

export async function connectLibrary(path: string): Promise<void> {
  state.loading = true;
  state.error = null;
  render();
  try {
    await setLibraryRoot(path);
    state.libraryFormOpen = false;
    // A newly registered root should get one automatic incremental scan.
    startupAutoScanStarted = false;
    // 切换媒体库是骨架级别的变化：旧库的日期树展开态 / 网格 / 弹窗都作废，
    // 直接重建一次骨架，再由 bootstrap 填内容。
    renderShell(true);
    await bootstrap();
  } catch (error) {
    state.error = toUserMessage(error, "连接媒体库失败");
    state.loading = false;
    render();
  }
}

export async function chooseLibraryFolder(): Promise<void> {
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
    state.error = toUserMessage(error, "打开文件夹选择器失败");
    patchToolbar();
  }
}

export async function persistUiPrefs(input: {
  uiDensity?: number;
  uiSort?: SortMode;
  uiPreviewMode?: UiPreviewMode;
  uiTheme?: UiTheme;
  uiDialogSizes?: Record<string, DialogSize>;
}): Promise<void> {
  try {
    const settings = await setUiPrefs(input);
    state.density = clampDensity(settings.ui_density);
    state.sort = clampSort(settings.ui_sort);
    state.previewMode = clampPreviewMode(settings.ui_preview_mode);
    state.theme = clampTheme(settings.ui_theme);
    state.dialogSizes = sanitizeDialogSizes(settings.ui_dialog_sizes);
  } catch (error) {
    state.error = toUserMessage(error, "保存界面偏好失败");
    // A failed size write keeps the dragged geometry live for this session;
    // the next successful save or settings load reconciles both sides.
  }
}

export async function maybeAutoScan(): Promise<void> {
  if (startupAutoScanStarted) return;
  if (!state.library || state.availability !== "available") return;
  if (!state.autoScanOnStartup || state.scanning) return;
  startupAutoScanStarted = true;
  await scanLibrary();
}

export async function loadBackupHistory(): Promise<void> {
  try {
    state.backupHistory = await listBackupHistory(8);
  } catch {
    // History is optional chrome; do not surface a hard error on open.
    state.backupHistory = [];
  }
}

export async function openBackupPanel(): Promise<void> {
  state.backupOpen = true;
  state.backupPreview = null;
  state.backupLoading = true;
  patchToolbar();
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
    state.error = toUserMessage(error, "发现相机盘失败");
  } finally {
    state.backupLoading = false;
    patchToolbar();
  }
}

export async function createBackupPreview(): Promise<void> {
  const sourceSelect = app.querySelector<HTMLSelectElement>("#backup-source");
  const targetSelect = app.querySelector<HTMLSelectElement>("#backup-target");
  const ignoreInput = app.querySelector<HTMLInputElement>("#backup-ignore");
  const mergeSelect = app.querySelector<HTMLSelectElement>("#backup-merge");
  const deepVerifyInput = app.querySelector<HTMLInputElement>("#backup-deep-verify");
  if (sourceSelect?.value) state.backupSourceId = sourceSelect.value;
  if (targetSelect?.value) state.backupTargetId = targetSelect.value;
  if (ignoreInput) state.backupIgnoreExtensions = ignoreInput.value;
  if (mergeSelect) state.backupMergeSegments = mergeSelect.value === "on";
  if (deepVerifyInput) state.backupDeepVerify = deepVerifyInput.checked;
  const source = state.backupSourceId;
  const target = state.backupTargetId;
  if (!source || !target) return;
  const ignore = state.backupIgnoreExtensions
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  state.backupLoading = true;
  state.error = null;
  patchToolbar();
  try {
    state.backupPreview = await previewBackup({
      sourceVolumeId: source,
      targetLibraryId: target,
      conflictPolicy: state.backupConflictPolicy,
      ignoreExtensions: ignore,
      mergeSegments: state.backupMergeSegments,
      deepVerify: state.backupDeepVerify,
    });
  } catch (error) {
    state.error = toUserMessage(error, "生成备份预览失败");
  } finally {
    state.backupLoading = false;
    patchToolbar();
  }
}

export async function saveBackupConflict(policy: ConflictPolicy): Promise<void> {
  try {
    const settings = await setBackupConflictPolicy(policy);
    state.backupConflictPolicy = settings.backup_conflict_policy;
    patchToolbar();
  } catch (error) {
    state.error = toUserMessage(error, "保存冲突策略失败");
    patchToolbar();
  }
}

export async function saveBackupMerge(enabled: boolean): Promise<void> {
  try {
    const settings = await setBackupMergeSegments(enabled);
    state.backupMergeSegments = settings.backup_merge_segments;
    patchToolbar();
  } catch (error) {
    state.error = toUserMessage(error, "保存分段合并设置失败");
    patchToolbar();
  }
}

export async function startConfirmedBackup(): Promise<void> {
  const preview = state.backupPreview;
  if (!preview || state.backupJobId) return;
  if (preview.spaceSufficient === false) {
    state.error = "目标盘空间不足，无法开始备份";
    patchToolbar();
    return;
  }
  const deepVerifyNote = preview.deepVerify
    ? "\n\n已开启深度校验：每个文件复制后会回读并比对内容哈希，速度会慢一些。"
    : "";
  const confirmed = window.confirm(
    `将按预览复制 ${formatCount(willCopyCount(preview))} 个文件（${formatSize(preview.requiredBytes)}）。${deepVerifyNote}\n\n相机源文件不会被删除、移动或修改。是否开始备份？`,
  );
  if (!confirmed) return;
  state.backupLoading = true;
  state.error = null;
  state.backupLastRunId = preview.backupRunId;
  state.backupProgress = null;
  state.backupFailedItems = [];
  patchToolbar();
  try {
    const start = await startBackup(preview.backupRunId, preview.id);
    state.backupJobId = start.jobId;
    state.backupLastRunId = start.backupRunId;
  } catch (error) {
    state.error = toUserMessage(error, "无法开始备份");
  } finally {
    state.backupLoading = false;
    patchToolbar();
  }
}

export async function cancelCurrentBackup(): Promise<void> {
  if (!state.backupJobId) return;
  try {
    await cancelBackup(state.backupJobId);
  } catch (error) {
    state.error = toUserMessage(error, "无法取消备份");
    patchToolbar();
  }
}

export async function retryCurrentBackup(): Promise<void> {
  const runId = state.backupLastRunId;
  if (!runId || state.backupJobId || state.backupRetrying) return;
  state.backupRetrying = true;
  state.error = null;
  patchToolbar();
  try {
    const start = await retryFailedBackup(runId);
    state.backupJobId = start.jobId;
    state.backupLastRunId = start.backupRunId;
    state.backupProgress = null;
    state.backupFailedItems = [];
  } catch (error) {
    state.error = toUserMessage(error, "重试备份失败");
  } finally {
    state.backupRetrying = false;
    patchToolbar();
  }
}

export async function viewNewImports(): Promise<void> {
  // Prefer the finished backup's start time so items indexed before the run
  // are not listed as "new".
  const runId = state.backupLastRunId;
  const startedAt = runId ? state.backupHistory.find((run) => run.id === runId)?.startedAt : undefined;
  state.firstSeenFrom =
    startedAt && startedAt.startsWith("unix-ms:") ? startedAt : `unix-ms:${Date.now() - 15 * 60 * 1000}`;
  state.datePrefix = undefined;
  state.dateFrom = undefined;
  state.dateTo = undefined;
  state.kind = undefined;
  state.favoriteOnly = false;
  state.burstOnly = false;
  state.search = "";
  searchUi.draft = "";
  state.backupOpen = false;
  if (state.library && state.availability === "available") {
    await refreshMedia();
  } else {
    render();
  }
}

export async function scanLibrary(): Promise<void> {
  if (!state.library || state.scanning) return;
  if (state.availability !== "available") {
    state.error = state.libraryStatusReason || "媒体库不可用，请先连接磁盘";
    renderSettingsAware();
    return;
  }
  state.error = null;
  state.scanning = true;
  state.scanProgress = null;
  renderSettingsAware();
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
    renderSettingsAware();
  } catch (error) {
    state.scanning = false;
    state.error = toUserMessage(error, "无法开始扫描");
    renderSettingsAware();
  }
}

export async function cancelCurrentScan(): Promise<void> {
  if (!state.scanProgress || state.scanProgress.state !== "running") return;
  try {
    await cancelLibraryScan(state.scanProgress.jobId);
  } catch (error) {
    state.error = toUserMessage(error, "无法取消扫描");
    renderSettingsAware();
  }
}

export function refreshMergeSelectionView(): void {
  const content = app.querySelector<HTMLElement>("#settings-content");
  const contentScroll = content?.scrollTop ?? 0;
  const list = app.querySelector<HTMLElement>("#library-merge-list");
  const listScroll = list?.scrollTop ?? 0;
  const filter = app.querySelector<HTMLInputElement>("#library-merge-filter");
  const filterFocused = document.activeElement === filter;
  const cursor = filter?.selectionStart ?? null;
  updateSettingsPanel({ animate: false });
  const nextContent = app.querySelector<HTMLElement>("#settings-content");
  if (nextContent) nextContent.scrollTop = contentScroll;
  const nextList = app.querySelector<HTMLElement>("#library-merge-list");
  if (nextList) nextList.scrollTop = listScroll;
  const nextFilter = app.querySelector<HTMLInputElement>("#library-merge-filter");
  if (filterFocused && nextFilter) {
    nextFilter.focus();
    if (cursor !== null) nextFilter.setSelectionRange(cursor, cursor);
  }
}

export async function loadLibraryMergePreview(): Promise<void> {
  if (!state.library || state.libraryMergeLoading) return;
  if (state.availability !== "available") {
    state.settingsError = state.libraryStatusReason || "媒体库不可用";
    updateSettingsPanel();
    return;
  }
  state.libraryMergeLoading = true;
  state.libraryMergeConfirm = false;
  state.libraryMergeNotice = null;
  updateSettingsPanel();
  try {
    state.libraryMergePreview = await previewLibraryMerge(state.library.id);
    state.libraryMergeSelected = new Set(state.libraryMergePreview.groups.map((group) => group.destinationRelative));
    state.libraryMergeFilter = "";
  } catch (error) {
    state.settingsError = toUserMessage(error, "扫描分段失败");
    state.libraryMergePreview = null;
    state.libraryMergeSelected = new Set();
  } finally {
    state.libraryMergeLoading = false;
    updateSettingsPanel();
  }
}

export async function startLibraryMergeJob(): Promise<void> {
  if (!state.library || !state.libraryMergePreview || state.libraryMergeJobId) return;
  state.libraryMergeConfirm = false;
  state.libraryMergeNotice = null;
  state.settingsError = null;
  try {
    const destinations = state.libraryMergePreview.groups
      .filter((group) => state.libraryMergeSelected.has(group.destinationRelative))
      .map((group) => group.destinationRelative);
    if (destinations.length === 0) {
      updateSettingsPanel({ animate: false });
      return;
    }
    const selectedBytes = state.libraryMergePreview.groups
      .filter((group) => state.libraryMergeSelected.has(group.destinationRelative))
      .reduce((sum, group) => sum + group.sizeBytes, 0);
    const start = await startLibraryMerge(state.library.id, state.libraryMergeRecycle, destinations);
    state.libraryMergeJobId = start.jobId;
    state.libraryMergeProgress = {
      jobId: start.jobId,
      kind: "library_merge",
      seq: 0,
      phase: "merging",
      state: "running",
      currentFile: null,
      groupProcessed: 0,
      groupTotal: destinations.length,
      bytesProcessed: 0,
      bytesTotal: selectedBytes,
      speedBytesPerSec: 0,
      etaSeconds: null,
      errors: [],
      error: null,
    };
    updateSettingsPanel();
  } catch (error) {
    state.libraryMergeJobId = null;
    state.settingsError = toUserMessage(error, "无法开始分段整理");
    updateSettingsPanel();
  }
}

export async function cancelLibraryMergeJob(): Promise<void> {
  const jobId = state.libraryMergeProgress?.jobId ?? state.libraryMergeJobId;
  if (!jobId) return;
  try {
    await cancelLibraryMerge(jobId);
  } catch (error) {
    state.settingsError = toUserMessage(error, "无法取消分段整理");
    updateSettingsPanel();
  }
}

/**
 * ffmpeg 只影响视频缩略图与剪辑，缺失不该挡住首屏，也不该每次启动都弹窗。
 * 首帧之后在空闲时探测一次（后端依次看 CAMLIB_FFMPEG_PATH、打包资源、PATH、
 * WinGet 安装目录），仅当确实找不到时才落一条状态横幅提示。
 */
export function probeFfmpeg(): void {
  const run = () => {
    void ffmpegAvailable()
      .then((available) => {
        if (available) return;
        state.ffmpegMissing = true;
        patchToolbar();
      })
      .catch(() => {
        // 探测本身失败时按「未知」处理：不打扰用户，真正用到 ffmpeg 时那条
        // 路径仍有自己的错误提示。
      });
  };
  if (typeof requestIdleCallback === "function") requestIdleCallback(run, { timeout: 3000 });
  else setTimeout(run, 1200);
}

export async function bootstrap(): Promise<void> {
  state.loading = true;
  state.error = null;
  renderSettingsAware();
  try {
    const [infra, libraries, backups] = await Promise.all([
      getInfrastructureState(),
      listLibraries(),
      listBackupHistory(8),
    ]);
    state.backupConflictPolicy = infra.settings.backup_conflict_policy;
    state.backupIgnoreExtensions = extensionsToInput(infra.settings.backup_ignore_extensions);
    state.backupMergeSegments = infra.settings.backup_merge_segments;
    state.thumbnailCacheDir = infra.settings.thumbnail_cache_dir;
    state.density = clampDensity(infra.settings.ui_density);
    state.sort = clampSort(infra.settings.ui_sort);
    state.previewMode = clampPreviewMode(infra.settings.ui_preview_mode);
    state.theme = clampTheme(infra.settings.ui_theme);
    state.dialogSizes = sanitizeDialogSizes(infra.settings.ui_dialog_sizes);
    applyTheme(state.theme);
    syncThemeToggle();
    state.autoScanOnStartup = infra.settings.auto_scan_on_startup;
    state.notificationsEnabled = infra.settings.notifications_enabled;
    state.closeBehavior = infra.settings.close_behavior;
    state.backupHistory = backups;
    state.libraries = libraries;
    state.availability = infra.library_status.availability;
    state.rootPath = infra.library_status.root_path;
    state.libraryStatusReason = infra.library_status.reason;
    state.library =
      libraries.find((library) => library.rootPath === infra.library_status.root_path) ?? libraries[0] ?? null;
    if (state.library) {
      try {
        state.scanRuns = await listScanRuns(state.library.id, 8);
      } catch {
        state.scanRuns = [];
      }
      state.recentTaskNotice = buildRecentTaskNotice(state.scanRuns, state.backupHistory);
    }
    if (state.library && state.availability === "available") {
      state.facets = await listDateFacets(state.library.id);
      resetSidebarExpansionForSelection();
      void refreshTags();
      void loadAiStats();
      await refreshMedia();
      void maybeAutoScan();
    } else {
      state.page = { items: [], total: 0, offset: 0, limit: 120 };
      state.facets = [];
      state.loading = false;
      renderSettingsAware();
    }
  } catch (error) {
    state.loading = false;
    state.error = toUserMessage(error, "初始化媒体库失败");
    renderSettingsAware();
  }
}

/** Surface the newest interrupted/failed run once after restart. */
export function buildRecentTaskNotice(scans: ScanRunDto[], backups: BackupRunDto[]): string | null {
  const lastScan = scans.find((run) => run.status === "failed" || run.status === "cancelled");
  const lastBackup = backups.find((run) => run.status === "failed" || run.status === "cancelled");
  const parts: string[] = [];
  if (lastScan) {
    const reason = lastScan.errorSummary || (lastScan.status === "cancelled" ? "已取消" : "未完成");
    parts.push(`扫描 ${formatCaptureAt(lastScan.startedAt) || lastScan.startedAt}：${reason}`);
  }
  if (lastBackup) {
    const reason = lastBackup.errorSummary || (lastBackup.status === "cancelled" ? "已取消" : "未完成");
    parts.push(`备份 ${formatCaptureAt(lastBackup.startedAt) || lastBackup.startedAt}：${reason}`);
  }
  return parts.length ? `上次应用中断的任务已标记为失败。${parts.join(" · ")}` : null;
}
