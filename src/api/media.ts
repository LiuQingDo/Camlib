import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type LibraryState = "available" | "offline" | "invalid";
export type MediaKind = "photo" | "video" | "live";
export type MediaFileRole = "single" | "live_photo" | "live_video";
export type ScanState = "present" | "missing" | "ambiguous" | "error";
export type BackupStatus = "preview" | "running" | "completed" | "cancelled" | "failed";
export type ConflictPolicy = "skip_same" | "rename" | "overwrite";

export interface LibraryDto {
  id: string;
  rootPath: string;
  volumeId: string | null;
  volumeLabel: string | null;
  driveLetter: string | null;
  state: LibraryState;
  lastSeenAt: string | null;
  lastScanAt: string | null;
  scanGeneration: number;
  createdAt: string;
  updatedAt: string;
}

export interface MediaItemDto {
  id: string;
  libraryId: string;
  logicalKey: string;
  kind: MediaKind;
  displayName: string;
  captureAt: string | null;
  captureDate: string | null;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  totalSizeBytes: number;
  burstGroup: string | null;
  metadataJson: string | null;
  scanState: ScanState;
  firstSeenAt: string;
  lastSeenAt: string;
  favorite: boolean;
}

export interface MediaFileDto {
  id: string;
  mediaItemId: string;
  libraryId: string;
  role: MediaFileRole;
  /** Always relative to the registered library root; never an absolute path. */
  relativePath: string;
  fileName: string;
  extension: string;
  sizeBytes: number;
  modifiedAt: string;
  contentHash: string | null;
  hashAlgorithm: string | null;
  fileIdentity: string | null;
  existsNow: boolean;
  lastScannedAt: string;
}

export interface TagDto {
  id: string;
  name: string;
  color: string | null;
  createdAt: string;
}

export interface MediaItemDetailsDto {
  item: MediaItemDto;
  files: MediaFileDto[];
  favorite: boolean;
  tags: TagDto[];
}

export interface MediaPageDto {
  items: MediaItemDto[];
  total: number;
  offset: number;
  limit: number;
}

export interface DeletePreviewDto {
  mediaCount: number;
  fileCount: number;
  totalSizeBytes: number;
  summary: string[];
}

export interface DeleteResultDto {
  mediaCount: number;
  filesRecycled: number;
  filesAlreadyMissing: number;
  failedFiles: number;
  errors: string[];
  deletedItemIds: string[];
  failedItemIds: string[];
}

export interface DeleteProgressDto {
  processedFiles: number;
  totalFiles: number;
  current: string;
  state: "running" | "completed";
}

export interface MediaQueryInput {
  libraryId: string;
  kind?: MediaKind;
  favoriteOnly?: boolean;
  burstOnly?: boolean;
  search?: string;
  /** YYYY, YYYY-MM, or YYYY-MM-DD. Mutually exclusive with date range in the UI. */
  datePrefix?: string;
  /** Inclusive capture_date lower bound, YYYY-MM-DD. */
  dateFrom?: string;
  /** Inclusive capture_date upper bound, YYYY-MM-DD. */
  dateTo?: string;
  /** Keep media first indexed at/after this timestamp (`unix-ms:<ms>` or bare integer). */
  firstSeenFrom?: string;
  offset?: number;
  limit?: number;
  sort?: "newest" | "oldest" | "name";
}

export interface DateFacetDto {
  date: string;
  count: number;
}

export interface ThumbnailDto {
  url: string;
  cacheKey: string;
}

export interface MediaSourceDto {
  role: "single" | "photo" | "video";
  url: string;
  mimeType: string;
}

export interface PreviewFileDto {
  role: MediaFileRole;
  fileName: string;
  extension: string;
  sizeBytes: number;
  relativePath: string;
  existsNow: boolean;
}

export interface PreviewMetaDto {
  displayName: string;
  captureAt: string | null;
  captureDate: string | null;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  totalSizeBytes: number;
  burstGroup: string | null;
  favorite: boolean;
  scanState: ScanState;
  files: PreviewFileDto[];
  tags: string[];
}

export interface MediaPreviewDto {
  kind: MediaKind;
  sources: MediaSourceDto[];
  meta: PreviewMetaDto;
}

export interface PreviewJobStartDto {
  jobId: string;
}

export interface PreviewProgressDto {
  jobId: string;
  kind: "thumbnail";
  seq: number;
  phase: "thumbnailing" | "finalizing";
  state: "running" | "completed" | "cancelled" | "failed";
  current: string | null;
  processed: number;
  total: number;
  errors: string[];
  error: string | null;
}

export interface ScanStartDto {
  jobId: string;
  scanRunId: string;
}

export interface ScanProgressDto {
  jobId: string;
  kind: "scan";
  seq: number;
  phase: "discovering" | "indexing" | "finalizing";
  state: "running" | "completed" | "cancelled" | "failed";
  current: string | null;
  processed: number;
  total: number;
  errors: string[];
  error: string | null;
}

export function startLibraryScan(libraryId: string, full = false): Promise<ScanStartDto> {
  return invoke<ScanStartDto>("library_scan_start", { libraryId, full });
}

export function cancelLibraryScan(jobId: string): Promise<void> {
  return invoke<void>("library_scan_cancel", { jobId });
}

export function onScanProgress(
  callback: (event: ScanProgressDto) => void,
): Promise<UnlistenFn> {
  return listen<ScanProgressDto>("scan-progress", (event) => callback(event.payload));
}

export interface BackupRunDto {
  id: string;
  jobId: string;
  sourceVolumeId: string | null;
  sourceRootPath: string;
  targetLibraryId: string;
  status: BackupStatus;
  conflictPolicy: ConflictPolicy;
  ignoreExtensions: string;
  startedAt: string;
  finishedAt: string | null;
  totalFiles: number;
  copiedFiles: number;
  skippedFiles: number;
  failedFiles: number;
  totalBytes: number;
  copiedBytes: number;
  errorSummary: string | null;
}

export interface BackupVolumeDto {
  id: string;
  rootPath: string;
  dcimPath: string;
  volumeLabel: string | null;
  driveLetter: string | null;
  removable: boolean;
}

export type BackupItemStatus = "ready" | "already_exists" | "conflict" | "ignored";

export interface BackupItemPreviewDto {
  sourceRelative: string;
  destinationRelative: string | null;
  fileName: string;
  kind: string | null;
  captureDate: string | null;
  dateSource: "filename" | "file_time" | null;
  sizeBytes: number;
  extension: string;
  status: BackupItemStatus;
  reason: string | null;
}

export interface BackupPreviewDto {
  id: string;
  backupRunId: string;
  source: BackupVolumeDto;
  targetLibraryId: string;
  targetRootPath: string;
  conflictPolicy: ConflictPolicy;
  ignoreExtensions: string[];
  totalFiles: number;
  totalBytes: number;
  readyFiles: number;
  alreadyExistsFiles: number;
  conflictFiles: number;
  ignoredFiles: number;
  requiredBytes: number;
  freeBytes: number | null;
  spaceSufficient: boolean | null;
}

export interface BackupPreviewInput {
  sourceVolumeId: string;
  targetLibraryId: string;
  conflictPolicy?: ConflictPolicy;
  ignoreExtensions?: string[];
}

export interface BackupStartDto {
  jobId: string;
  backupRunId: string;
}

export type BackupItemState = "planned" | "copied" | "skipped" | "failed" | "cancelled";

export interface BackupItemDto {
  id: string;
  backupRunId: string;
  sourceRelative: string;
  destinationRelative: string | null;
  sizeBytes: number;
  status: BackupItemState;
  copiedBytes: number;
  errorMessage: string | null;
}

export interface BackupProgressDto {
  jobId: string;
  kind: "backup";
  seq: number;
  phase: "copying" | "finalizing";
  state: "running" | "completed" | "cancelled" | "failed";
  currentFile: string | null;
  fileProcessed: number;
  fileTotal: number;
  bytesProcessed: number;
  bytesTotal: number;
  speedBytesPerSec: number;
  etaSeconds: number | null;
  errors: string[];
  error: string | null;
}

export function discoverBackupSources(): Promise<BackupVolumeDto[]> {
  return invoke<BackupVolumeDto[]>("backup_sources_discover");
}

export function previewBackup(input: BackupPreviewInput): Promise<BackupPreviewDto> {
  return invoke<BackupPreviewDto>("backup_preview", { request: input });
}

export function startBackup(previewId: string, confirmationToken: string): Promise<BackupStartDto> {
  return invoke<BackupStartDto>("backup_start", { previewId, confirmationToken });
}

export function retryFailedBackup(backupRunId: string, itemIds?: string[]): Promise<BackupStartDto> {
  return invoke<BackupStartDto>("backup_retry_failed", { backupRunId, itemIds });
}

export function cancelBackup(jobId: string): Promise<void> {
  return invoke<void>("backup_cancel", { jobId });
}

export function listBackupHistory(limit = 8): Promise<BackupRunDto[]> {
  return invoke<BackupRunDto[]>("backup_history", { limit });
}

export function listBackupRunItems(
  backupRunId: string,
  onlyRetryable = false,
): Promise<BackupItemDto[]> {
  return invoke<BackupItemDto[]>("backup_run_items", { backupRunId, onlyRetryable });
}

export function onBackupProgress(callback: (event: BackupProgressDto) => void): Promise<UnlistenFn> {
  return listen<BackupProgressDto>("backup-progress", (event) => callback(event.payload));
}

export function listLibraries(): Promise<LibraryDto[]> {
  return invoke<LibraryDto[]>("library_list");
}

export function queryMedia(query: MediaQueryInput): Promise<MediaPageDto> {
  return invoke<MediaPageDto>("media_query", { query });
}

export function listDateFacets(libraryId: string): Promise<DateFacetDto[]> {
  return invoke<DateFacetDto[]>("media_date_facets", { libraryId });
}

export function getMediaItem(mediaItemId: string): Promise<MediaItemDetailsDto> {
  return invoke<MediaItemDetailsDto>("media_get", { mediaItemId });
}

/** Reveal the media file in Explorer. Backend resolves the path from the id. */
export function openMediaFolder(mediaItemId: string): Promise<void> {
  return invoke<void>("media_open_folder", { mediaItemId });
}

export function setFavorite(mediaItemId: string, favorite: boolean): Promise<void> {
  return invoke<void>("favorite_set", { mediaItemId, favorite });
}

/** Apply the same favorite flag to many items in one backend transaction. */
export function setFavoritesBatch(mediaItemIds: string[], favorite: boolean): Promise<number> {
  return invoke<number>("favorite_set_batch", { mediaItemIds, favorite });
}

export function previewDelete(libraryId: string, mediaItemIds: string[]): Promise<DeletePreviewDto> {
  return invoke<DeletePreviewDto>("media_delete_preview", { libraryId, mediaItemIds });
}

export function deleteMediaItems(libraryId: string, mediaItemIds: string[]): Promise<DeleteResultDto> {
  return invoke<DeleteResultDto>("media_delete_items", { libraryId, mediaItemIds });
}

export function onDeleteProgress(
  callback: (event: DeleteProgressDto) => void,
): Promise<UnlistenFn> {
  return listen<DeleteProgressDto>("delete-progress", (event) => callback(event.payload));
}

export function getMediaThumbnail(mediaItemId: string, width = 320): Promise<ThumbnailDto> {
  return invoke<ThumbnailDto>("media_thumbnail", { mediaItemId, width });
}

export function getMediaPreview(mediaItemId: string): Promise<MediaPreviewDto> {
  return invoke<MediaPreviewDto>("media_preview", { mediaItemId });
}

export function startThumbnailRebuild(libraryId: string): Promise<PreviewJobStartDto> {
  return invoke<PreviewJobStartDto>("thumbnail_rebuild_start", { libraryId });
}

export function cancelPreviewJob(jobId: string): Promise<void> {
  return invoke<void>("preview_job_cancel", { jobId });
}

export function onPreviewProgress(callback: (event: PreviewProgressDto) => void): Promise<UnlistenFn> {
  return listen<PreviewProgressDto>("preview-progress", (event) => callback(event.payload));
}
