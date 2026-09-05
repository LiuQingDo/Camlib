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

export interface MediaQueryInput {
  libraryId: string;
  kind?: MediaKind;
  favoriteOnly?: boolean;
  search?: string;
  offset?: number;
  limit?: number;
  sort?: "newest" | "oldest" | "name";
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

export function startLibraryScan(libraryId: string): Promise<ScanStartDto> {
  return invoke<ScanStartDto>("library_scan_start", { libraryId });
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

export function listLibraries(): Promise<LibraryDto[]> {
  return invoke<LibraryDto[]>("library_list");
}

export function queryMedia(query: MediaQueryInput): Promise<MediaPageDto> {
  return invoke<MediaPageDto>("media_query", { query });
}

export function getMediaItem(mediaItemId: string): Promise<MediaItemDetailsDto> {
  return invoke<MediaItemDetailsDto>("media_get", { mediaItemId });
}

export function setFavorite(mediaItemId: string, favorite: boolean): Promise<void> {
  return invoke<void>("favorite_set", { mediaItemId, favorite });
}
