import { invoke } from "@tauri-apps/api/core";

export interface VolumeInfo {
  drive_letter: string | null;
  volume_label: string | null;
  volume_id: string | null;
}

export type UiSortMode = "newest" | "oldest" | "name" | "rating-desc" | "rating-asc";

export interface AppSettings {
  library_root: string | null;
  thumbnail_cache_dir: string;
  library_volume: VolumeInfo | null;
  backup_conflict_policy: "skip_same" | "rename" | "overwrite";
  ui_density: number;
  ui_sort: UiSortMode;
  auto_scan_on_startup: boolean;
  backup_ignore_extensions: string[];
}

export type LibraryAvailability =
  | "unconfigured"
  | "available"
  | "disconnected"
  | "invalid";

export interface LibraryStatus {
  availability: LibraryAvailability;
  root_path: string | null;
  volume: VolumeInfo | null;
  reason: string | null;
}

export interface InfrastructureState {
  settings: AppSettings;
  library_status: LibraryStatus;
}

export interface ScanRunDto {
  id: string;
  libraryId: string;
  jobId: string;
  status: "running" | "completed" | "cancelled" | "failed";
  startedAt: string;
  finishedAt: string | null;
  filesSeen: number;
  itemsAdded: number;
  itemsUpdated: number;
  itemsMissing: number;
  errors: number;
  errorSummary: string | null;
}

export interface LibraryIndexSummaryDto {
  libraryId: string;
  totalItems: number;
  photos: number;
  videos: number;
  live: number;
  missing: number;
  favorites: number;
  totalSizeBytes: number;
  lastScanAt: string | null;
  scanGeneration: number;
}

export interface FfmpegStatusDto {
  available: boolean;
  path: string | null;
  message: string | null;
}

export interface ThumbnailCacheStatsDto {
  path: string;
  fileCount: number;
  totalBytes: number;
}

export interface AppAboutDto {
  version: string;
  appDataDir: string;
  appCacheDir: string;
  databasePath: string;
  settingsPath: string;
  thumbnailCacheDir: string;
  ffmpeg: FfmpegStatusDto;
}

export type AppDirectoryKind = "app_data" | "app_cache" | "thumbnail_cache" | "library";

export function getAppSettings(): Promise<AppSettings> {
  return invoke<AppSettings>("get_app_settings");
}

export function setLibraryRoot(path: string): Promise<LibraryStatus> {
  return invoke<LibraryStatus>("set_library_root", { path });
}

export function setThumbnailCacheDir(path: string): Promise<AppSettings> {
  return invoke<AppSettings>("set_thumbnail_cache_dir", { path });
}

export function setBackupConflictPolicy(policy: AppSettings["backup_conflict_policy"]): Promise<AppSettings> {
  return invoke<AppSettings>("set_backup_conflict_policy", { policy });
}

export function setBackupIgnoreExtensions(extensions: string[]): Promise<AppSettings> {
  return invoke<AppSettings>("set_backup_ignore_extensions", { extensions });
}

export function setUiPrefs(input: { uiDensity?: number; uiSort?: UiSortMode }): Promise<AppSettings> {
  return invoke<AppSettings>("set_ui_prefs", {
    uiDensity: input.uiDensity,
    uiSort: input.uiSort,
  });
}

export function setAutoScanOnStartup(enabled: boolean): Promise<AppSettings> {
  return invoke<AppSettings>("set_auto_scan_on_startup", { enabled });
}

export function getLibraryStatus(): Promise<LibraryStatus> {
  return invoke<LibraryStatus>("get_library_status");
}

export function getInfrastructureState(): Promise<InfrastructureState> {
  return invoke<InfrastructureState>("get_infrastructure_state");
}

export function listScanRuns(libraryId: string, limit = 8): Promise<ScanRunDto[]> {
  return invoke<ScanRunDto[]>("list_scan_runs", { libraryId, limit });
}

export function getLibraryIndexSummary(libraryId: string): Promise<LibraryIndexSummaryDto> {
  return invoke<LibraryIndexSummaryDto>("library_index_summary", { libraryId });
}

export function getAppAbout(): Promise<AppAboutDto> {
  return invoke<AppAboutDto>("get_app_about");
}

export function getThumbnailCacheStats(): Promise<ThumbnailCacheStatsDto> {
  return invoke<ThumbnailCacheStatsDto>("get_thumbnail_cache_stats");
}

export function openAppDirectory(which: AppDirectoryKind): Promise<void> {
  return invoke<void>("open_app_directory", { which });
}