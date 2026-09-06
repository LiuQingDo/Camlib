import { invoke } from "@tauri-apps/api/core";

export interface VolumeInfo {
  drive_letter: string | null;
  volume_label: string | null;
  volume_id: string | null;
}

export interface AppSettings {
  library_root: string | null;
  thumbnail_cache_dir: string;
  library_volume: VolumeInfo | null;
  backup_conflict_policy: "skip_same" | "rename" | "overwrite";
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

export function getLibraryStatus(): Promise<LibraryStatus> {
  return invoke<LibraryStatus>("get_library_status");
}

export function getInfrastructureState(): Promise<InfrastructureState> {
  return invoke<InfrastructureState>("get_infrastructure_state");
}
