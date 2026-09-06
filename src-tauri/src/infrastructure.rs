//! The small, filesystem-only foundation shared by the future scanner and UI.
//!
//! This module deliberately does not scan or mutate media files. It owns only the
//! persisted settings, canonical paths, and the identity/availability check for a
//! registered library volume.

use crate::db::{ConflictPolicy, DbError, LibraryState, NewLibrary, Repository};
use serde::{Deserialize, Serialize};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

const SETTINGS_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct VolumeInfo {
    pub drive_letter: Option<String>,
    pub volume_label: Option<String>,
    pub volume_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AppSettings {
    pub library_root: Option<String>,
    pub thumbnail_cache_dir: String,
    pub library_volume: Option<VolumeInfo>,
    pub backup_conflict_policy: ConflictPolicy,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum LibraryAvailability {
    Unconfigured,
    Available,
    Disconnected,
    Invalid,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct LibraryStatus {
    pub availability: LibraryAvailability,
    pub root_path: Option<String>,
    pub volume: Option<VolumeInfo>,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct InfrastructureStateDto {
    pub settings: AppSettings,
    pub library_status: LibraryStatus,
}

#[derive(Debug)]
pub struct InfrastructureState {
    inner: Mutex<Infrastructure>,
}

impl InfrastructureState {
    pub fn new(infrastructure: Infrastructure) -> Self {
        Self {
            inner: Mutex::new(infrastructure),
        }
    }

    pub fn with_infrastructure<T>(
        &self,
        operation: impl FnOnce(&mut Infrastructure) -> Result<T, InfrastructureError>,
    ) -> Result<T, String> {
        let mut infrastructure = self
            .inner
            .lock()
            .map_err(|_| "基础设施状态锁已损坏".to_owned())?;
        operation(&mut infrastructure).map_err(|error| error.to_string())
    }
}

#[derive(Debug)]
pub struct Infrastructure {
    store: SettingsStore,
    repository: Repository,
    database_path: PathBuf,
}

impl Infrastructure {
    #[allow(dead_code)]
    pub fn open(
        settings_path: PathBuf,
        default_thumbnail_cache_dir: PathBuf,
    ) -> Result<Self, InfrastructureError> {
        let database_path = settings_path
            .parent()
            .map(|parent| parent.join("camlib.sqlite3"))
            .ok_or_else(|| InfrastructureError::InvalidPath("数据库路径无效".to_owned()))?;
        Self::open_with_database(settings_path, default_thumbnail_cache_dir, database_path)
    }

    pub fn open_with_database(
        settings_path: PathBuf,
        default_thumbnail_cache_dir: PathBuf,
        database_path: PathBuf,
    ) -> Result<Self, InfrastructureError> {
        let store = SettingsStore::open(settings_path, default_thumbnail_cache_dir)?;
        let repository = Repository::open(&database_path).map_err(InfrastructureError::database)?;
        Ok(Self {
            store,
            repository,
            database_path,
        })
    }

    #[allow(dead_code)]
    pub fn repository(&self) -> &Repository {
        &self.repository
    }

    pub fn settings(&self) -> Result<AppSettings, InfrastructureError> {
        Ok(self.store.settings.clone())
    }

    pub fn set_library_root(
        &mut self,
        path: PathBuf,
    ) -> Result<LibraryStatus, InfrastructureError> {
        let canonical_root = normalize_existing_directory(&path)?;
        let volume = volume_info(&canonical_root);

        let previous_settings = self.store.settings.clone();
        self.store.settings.library_root = Some(path_to_string(&canonical_root));
        self.store.settings.library_volume = Some(volume);
        if let Err(error) = self.store.save() {
            self.store.settings = previous_settings;
            return Err(error);
        }

        // The JSON file is a UI/bootstrap cache; the scanner trusts only this
        // database record. Keep the library registration in the same operation.
        let root_path = path_to_string(&canonical_root);
        let existing = self
            .repository
            .get_library_by_root(&root_path)
            .map_err(InfrastructureError::database)?;
        let now = timestamp_now();
        let library = NewLibrary {
            id: existing
                .as_ref()
                .map(|library| library.id.clone())
                .unwrap_or_else(|| stable_library_id(&root_path)),
            root_path,
            volume_id: self
                .store
                .settings
                .library_volume
                .as_ref()
                .and_then(|v| v.volume_id.clone()),
            volume_label: self
                .store
                .settings
                .library_volume
                .as_ref()
                .and_then(|v| v.volume_label.clone()),
            drive_letter: self
                .store
                .settings
                .library_volume
                .as_ref()
                .and_then(|v| v.drive_letter.clone()),
            state: LibraryState::Available,
            last_seen_at: Some(now.clone()),
            last_scan_at: existing
                .as_ref()
                .and_then(|library| library.last_scan_at.clone()),
            scan_generation: existing
                .as_ref()
                .map(|library| library.scan_generation)
                .unwrap_or(0),
            created_at: existing
                .as_ref()
                .map(|library| library.created_at.clone())
                .unwrap_or_else(|| now.clone()),
            updated_at: now,
        };
        if let Err(error) = self.repository.upsert_library(library) {
            self.store.settings = previous_settings;
            let _ = self.store.save();
            return Err(InfrastructureError::database(error));
        }

        self.library_status()
    }

    pub fn database_path(&self) -> PathBuf {
        self.database_path.clone()
    }

    pub fn has_library(&self, library_id: &str) -> Result<bool, InfrastructureError> {
        self.repository
            .get_library(library_id)
            .map(|library| library.is_some())
            .map_err(InfrastructureError::database)
    }

    pub fn set_thumbnail_cache_dir(
        &mut self,
        path: PathBuf,
    ) -> Result<AppSettings, InfrastructureError> {
        let canonical_cache = normalize_cache_directory(&path)?;
        let previous_settings = self.store.settings.clone();
        self.store.settings.thumbnail_cache_dir = path_to_string(&canonical_cache);
        if let Err(error) = self.store.save() {
            self.store.settings = previous_settings;
            return Err(error);
        }
        self.settings()
    }

    pub fn set_backup_conflict_policy(
        &mut self,
        policy: ConflictPolicy,
    ) -> Result<AppSettings, InfrastructureError> {
        self.store.settings.backup_conflict_policy = policy;
        self.store.save()?;
        self.settings()
    }

    pub fn library_status(&mut self) -> Result<LibraryStatus, InfrastructureError> {
        let Some(root_text) = self.store.settings.library_root.clone() else {
            return Ok(LibraryStatus {
                availability: LibraryAvailability::Unconfigured,
                root_path: None,
                volume: None,
                reason: None,
            });
        };

        let root = PathBuf::from(&root_text);
        if !root.exists() {
            return Ok(LibraryStatus {
                availability: LibraryAvailability::Disconnected,
                root_path: Some(root_text),
                volume: self.store.settings.library_volume.clone(),
                reason: Some("媒体库根目录不存在，可能是外接盘已断开".to_owned()),
            });
        }

        let canonical_root = match normalize_existing_directory(&root) {
            Ok(path) => path,
            Err(error) => {
                return Ok(LibraryStatus {
                    availability: LibraryAvailability::Invalid,
                    root_path: Some(root_text),
                    volume: self.store.settings.library_volume.clone(),
                    reason: Some(error.to_string()),
                });
            }
        };

        let current_volume = volume_info(&canonical_root);
        let volume_matches = match (
            self.store.settings.library_volume.as_ref(),
            current_volume.volume_id.as_deref(),
        ) {
            (Some(recorded), Some(current_id)) => recorded.volume_id.as_deref() == Some(current_id),
            (Some(recorded), None) if recorded.volume_id.is_some() => false,
            // On platforms without volume APIs, the canonical directory is the
            // available identity. Windows normally has a volume id here.
            _ => true,
        };

        if !volume_matches {
            return Ok(LibraryStatus {
                availability: LibraryAvailability::Invalid,
                root_path: Some(path_to_string(&canonical_root)),
                volume: Some(current_volume),
                reason: Some("当前卷与记录的媒体库卷不一致".to_owned()),
            });
        }

        // Refresh display metadata (e.g. a changed drive letter or label) while
        // preserving the registered canonical root and recorded identity.
        if self.store.settings.library_volume.as_ref() != Some(&current_volume) {
            self.store.settings.library_volume = Some(current_volume.clone());
            self.store.save()?;
        }

        Ok(LibraryStatus {
            availability: LibraryAvailability::Available,
            root_path: Some(path_to_string(&canonical_root)),
            volume: Some(current_volume),
            reason: None,
        })
    }

    pub fn state(&mut self) -> Result<InfrastructureStateDto, InfrastructureError> {
        self.repository
            .schema_version()
            .map_err(InfrastructureError::database)?;
        let library_status = self.library_status()?;
        let settings = self.settings()?;
        Ok(InfrastructureStateDto {
            settings,
            library_status,
        })
    }
}

#[derive(Debug)]
struct SettingsStore {
    path: PathBuf,
    settings: AppSettings,
}

impl SettingsStore {
    fn open(
        path: PathBuf,
        default_thumbnail_cache_dir: PathBuf,
    ) -> Result<Self, InfrastructureError> {
        let path = normalize_settings_file_path(&path)?;
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|error| InfrastructureError::io(parent, error))?;
        }

        let mut settings = if path.exists() {
            let text =
                fs::read_to_string(&path).map_err(|error| InfrastructureError::io(&path, error))?;
            let disk: DiskSettings = serde_json::from_str(&text)
                .map_err(|error| InfrastructureError::InvalidSettings(error.to_string()))?;
            disk.into_app_settings()?
        } else {
            AppSettings {
                library_root: None,
                thumbnail_cache_dir: path_to_string(&normalize_cache_directory(
                    &default_thumbnail_cache_dir,
                )?),
                library_volume: None,
                backup_conflict_policy: ConflictPolicy::SkipSame,
            }
        };

        let original_settings = settings.clone();

        // Settings written by this module always contain a canonical cache path.
        // Re-normalize existing cache paths on load so a hand-edited/old file
        // cannot leak an unnormalized path to the frontend.
        settings.thumbnail_cache_dir = path_to_string(&normalize_cache_directory(Path::new(
            &settings.thumbnail_cache_dir,
        ))?);

        if let Some(root) = settings.library_root.as_deref() {
            settings.library_root =
                Some(path_to_string(&normalize_persisted_path(Path::new(root))?));
        }

        let store = Self { path, settings };
        if !store.path.exists() || store.settings != original_settings {
            store.save()?;
        }
        Ok(store)
    }

    fn save(&self) -> Result<(), InfrastructureError> {
        let disk = DiskSettings::from(&self.settings);
        let content = serde_json::to_vec_pretty(&disk)
            .map_err(|error| InfrastructureError::InvalidSettings(error.to_string()))?;
        atomic_write(&self.path, &content)
    }
}

#[derive(Debug, Serialize, Deserialize)]
struct DiskSettings {
    version: u32,
    library_root: Option<String>,
    thumbnail_cache_dir: String,
    library_volume: Option<VolumeInfo>,
    #[serde(default)]
    backup_conflict_policy: Option<ConflictPolicy>,
}

impl DiskSettings {
    fn into_app_settings(self) -> Result<AppSettings, InfrastructureError> {
        if self.version != SETTINGS_VERSION {
            return Err(InfrastructureError::InvalidSettings(format!(
                "不支持的设置版本: {}",
                self.version
            )));
        }
        if let Some(root) = &self.library_root {
            // A registered root was canonicalized before persistence. Rejecting
            // a non-absolute value prevents relative paths from entering runtime.
            if !Path::new(root).is_absolute() {
                return Err(InfrastructureError::InvalidSettings(
                    "媒体库根目录必须是绝对路径".to_owned(),
                ));
            }
        }
        Ok(AppSettings {
            library_root: self.library_root,
            thumbnail_cache_dir: self.thumbnail_cache_dir,
            library_volume: self.library_volume,
            backup_conflict_policy: self
                .backup_conflict_policy
                .unwrap_or(ConflictPolicy::SkipSame),
        })
    }
}

impl From<&AppSettings> for DiskSettings {
    fn from(settings: &AppSettings) -> Self {
        Self {
            version: SETTINGS_VERSION,
            library_root: settings.library_root.clone(),
            thumbnail_cache_dir: settings.thumbnail_cache_dir.clone(),
            library_volume: settings.library_volume.clone(),
            backup_conflict_policy: Some(settings.backup_conflict_policy.clone()),
        }
    }
}

#[derive(Debug)]
pub enum InfrastructureError {
    InvalidPath(String),
    Io { path: PathBuf, message: String },
    InvalidSettings(String),
    Database(String),
}

impl InfrastructureError {
    fn io(path: &Path, error: std::io::Error) -> Self {
        Self::Io {
            path: path.to_path_buf(),
            message: error.to_string(),
        }
    }

    pub(crate) fn database(error: DbError) -> Self {
        Self::Database(error.to_string())
    }
}

impl std::fmt::Display for InfrastructureError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidPath(message) => write!(formatter, "路径无效: {message}"),
            Self::Io { path, message } => {
                write!(formatter, "访问路径 {} 失败: {message}", path.display())
            }
            Self::InvalidSettings(message) => write!(formatter, "设置文件无效: {message}"),
            Self::Database(message) => write!(formatter, "数据库无效: {message}"),
        }
    }
}

impl std::error::Error for InfrastructureError {}

fn normalize_existing_directory(path: &Path) -> Result<PathBuf, InfrastructureError> {
    if path.as_os_str().is_empty() {
        return Err(InfrastructureError::InvalidPath("路径不能为空".to_owned()));
    }
    let canonical = fs::canonicalize(path).map_err(|error| InfrastructureError::io(path, error))?;
    let metadata =
        fs::metadata(&canonical).map_err(|error| InfrastructureError::io(&canonical, error))?;
    if !metadata.is_dir() {
        return Err(InfrastructureError::InvalidPath(format!(
            "{} 不是目录",
            canonical.display()
        )));
    }
    Ok(canonical)
}

fn normalize_cache_directory(path: &Path) -> Result<PathBuf, InfrastructureError> {
    if path.as_os_str().is_empty() {
        return Err(InfrastructureError::InvalidPath("路径不能为空".to_owned()));
    }
    fs::create_dir_all(path).map_err(|error| InfrastructureError::io(path, error))?;
    normalize_existing_directory(path)
}

fn normalize_settings_file_path(path: &Path) -> Result<PathBuf, InfrastructureError> {
    if path.as_os_str().is_empty() {
        return Err(InfrastructureError::InvalidPath(
            "设置路径不能为空".to_owned(),
        ));
    }
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .map_err(|error| InfrastructureError::io(Path::new("."), error))?
            .join(path)
    };
    let parent = absolute
        .parent()
        .ok_or_else(|| InfrastructureError::InvalidPath("设置文件必须位于一个目录中".to_owned()))?;
    fs::create_dir_all(parent).map_err(|error| InfrastructureError::io(parent, error))?;
    let canonical_parent =
        fs::canonicalize(parent).map_err(|error| InfrastructureError::io(parent, error))?;
    let file_name = absolute
        .file_name()
        .ok_or_else(|| InfrastructureError::InvalidPath("设置文件必须有文件名".to_owned()))?;
    Ok(canonical_parent.join(file_name))
}

/// Normalize a path already stored in settings. Existing paths are fully
/// canonicalized (including symlink resolution); a disconnected volume cannot
/// be canonicalized through the filesystem, so it receives lexical cleanup and
/// remains an absolute path for later availability checks.
fn normalize_persisted_path(path: &Path) -> Result<PathBuf, InfrastructureError> {
    if path.as_os_str().is_empty() {
        return Err(InfrastructureError::InvalidPath("路径不能为空".to_owned()));
    }
    if path.is_relative() {
        return Err(InfrastructureError::InvalidSettings(
            "媒体库根目录必须是绝对路径".to_owned(),
        ));
    }
    if path.is_dir() {
        return normalize_existing_directory(path);
    }
    lexical_normalize_absolute(path)
}

fn lexical_normalize_absolute(path: &Path) -> Result<PathBuf, InfrastructureError> {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                if !normalized.pop() {
                    return Err(InfrastructureError::InvalidPath(
                        "路径不能越过文件系统根目录".to_owned(),
                    ));
                }
            }
            Component::Prefix(prefix) => normalized.push(prefix.as_os_str()),
            Component::RootDir | Component::Normal(_) => normalized.push(component.as_os_str()),
        }
    }
    if !normalized.is_absolute() {
        return Err(InfrastructureError::InvalidPath(
            "路径必须是绝对路径".to_owned(),
        ));
    }
    Ok(normalized)
}

fn path_to_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn timestamp_now() -> String {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    format!("unix-ms:{millis}")
}

fn stable_library_id(root: &str) -> String {
    let mut hash = 0xcbf29ce484222325_u64;
    for byte in root.to_ascii_lowercase().as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("library-{hash:016x}")
}

fn atomic_write(path: &Path, content: &[u8]) -> Result<(), InfrastructureError> {
    let parent = path
        .parent()
        .ok_or_else(|| InfrastructureError::InvalidPath("设置文件必须位于一个目录中".to_owned()))?;
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    let temporary_path = parent.join(format!(
        ".{}.{}.{}.tmp",
        path.file_name().unwrap_or_default().to_string_lossy(),
        std::process::id(),
        stamp
    ));

    let result = (|| {
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary_path)
            .map_err(|error| InfrastructureError::io(&temporary_path, error))?;
        file.write_all(content)
            .map_err(|error| InfrastructureError::io(&temporary_path, error))?;
        file.sync_all()
            .map_err(|error| InfrastructureError::io(&temporary_path, error))?;
        replace_file(&temporary_path, path)
    })();

    if result.is_err() {
        let _ = fs::remove_file(&temporary_path);
    }
    result
}

fn replace_file(source: &Path, destination: &Path) -> Result<(), InfrastructureError> {
    #[cfg(windows)]
    {
        // rename cannot replace an existing file on Windows. The settings file
        // is application-owned, so this short replacement is safe and keeps the
        // temporary file from ever being exposed as a valid settings file.
        if destination.exists() {
            fs::remove_file(destination)
                .map_err(|error| InfrastructureError::io(destination, error))?;
        }
    }
    fs::rename(source, destination).map_err(|error| InfrastructureError::io(destination, error))
}

fn volume_info(path: &Path) -> VolumeInfo {
    VolumeInfo {
        drive_letter: drive_letter(path),
        volume_label: platform_volume_label(path),
        volume_id: platform_volume_id(path),
    }
}

fn drive_letter(path: &Path) -> Option<String> {
    let text = path.to_string_lossy();
    let text = text
        .strip_prefix(r"\\?\")
        .or_else(|| text.strip_prefix(r"\\.\"))
        .unwrap_or(&text);
    let bytes = text.as_bytes();
    if bytes.len() >= 2 && bytes[1] == b':' && bytes[0].is_ascii_alphabetic() {
        Some(text[0..1].to_ascii_uppercase())
    } else {
        None
    }
}

#[cfg(not(windows))]
fn platform_volume_label(_path: &Path) -> Option<String> {
    None
}

#[cfg(not(windows))]
fn platform_volume_id(_path: &Path) -> Option<String> {
    None
}

#[cfg(windows)]
fn platform_volume_label(path: &Path) -> Option<String> {
    let mount = windows_mount_path(path)?;
    let mut volume_name = [0u16; 261];
    let mut serial_number = 0u32;
    let mut max_component_length = 0u32;
    let mut flags = 0u32;
    let success = unsafe {
        windows_sys::Win32::Storage::FileSystem::GetVolumeInformationW(
            mount.as_ptr(),
            volume_name.as_mut_ptr(),
            volume_name.len() as u32,
            &mut serial_number,
            &mut max_component_length,
            &mut flags,
            std::ptr::null_mut(),
            0,
        )
    };
    if success == 0 {
        return None;
    }
    let length = volume_name
        .iter()
        .position(|value| *value == 0)
        .unwrap_or(volume_name.len());
    Some(String::from_utf16_lossy(&volume_name[..length]))
}

#[cfg(windows)]
fn platform_volume_id(path: &Path) -> Option<String> {
    let mount = windows_mount_path(path)?;
    let mut volume_name = [0u16; 50];
    let result = unsafe {
        windows_sys::Win32::Storage::FileSystem::GetVolumeNameForVolumeMountPointW(
            mount.as_ptr(),
            volume_name.as_mut_ptr(),
            volume_name.len() as u32,
        )
    };
    if result == 0 {
        // A volume GUID is preferred, but a serial number still gives us a
        // stable identity when the mount-point API is unavailable.
        let mut label = [0u16; 2];
        let mut serial_number = 0u32;
        let mut max_component_length = 0u32;
        let mut flags = 0u32;
        let success = unsafe {
            windows_sys::Win32::Storage::FileSystem::GetVolumeInformationW(
                mount.as_ptr(),
                label.as_mut_ptr(),
                label.len() as u32,
                &mut serial_number,
                &mut max_component_length,
                &mut flags,
                std::ptr::null_mut(),
                0,
            )
        };
        return (success != 0).then(|| format!("serial:{serial_number:08X}"));
    }
    let length = volume_name
        .iter()
        .position(|value| *value == 0)
        .unwrap_or(volume_name.len());
    Some(String::from_utf16_lossy(&volume_name[..length]))
}

#[cfg(windows)]
fn windows_mount_path(path: &Path) -> Option<Vec<u16>> {
    let text = path.to_string_lossy();
    let text = text
        .strip_prefix(r"\\?\")
        .or_else(|| text.strip_prefix(r"\\.\"))
        .unwrap_or(&text);
    let mount = if text.len() >= 2 && text.as_bytes()[1] == b':' {
        format!("{}\\", &text[..2])
    } else {
        return None;
    };
    Some(mount.encode_utf16().chain(std::iter::once(0)).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn test_infrastructure() -> (TempDir, Infrastructure) {
        let temp_dir = tempfile::tempdir().expect("temp directory");
        let settings_path = temp_dir.path().join("app-data").join("settings.json");
        let cache_path = temp_dir.path().join("cache").join("thumbs");
        let infrastructure =
            Infrastructure::open(settings_path, cache_path).expect("open infrastructure");
        (temp_dir, infrastructure)
    }

    #[test]
    fn paths_are_canonicalized_and_settings_survive_reload() {
        let (temp_dir, mut infrastructure) = test_infrastructure();
        let root = temp_dir.path().join("library");
        fs::create_dir_all(root.join("nested")).expect("library");
        let requested_root = root.join("nested").join("..");
        let status = infrastructure
            .set_library_root(requested_root)
            .expect("set library root");
        let canonical_root = fs::canonicalize(&root).expect("canonical root");
        assert_eq!(status.availability, LibraryAvailability::Available);
        assert_eq!(
            status.root_path.as_deref(),
            Some(canonical_root.to_str().unwrap())
        );
        assert!(Path::new(&infrastructure.settings().unwrap().thumbnail_cache_dir).is_absolute());

        let settings_path = temp_dir.path().join("app-data").join("settings.json");
        let reloaded = Infrastructure::open(settings_path, temp_dir.path().join("other-cache"))
            .expect("reload infrastructure");
        assert_eq!(
            reloaded.settings().unwrap(),
            infrastructure.settings().unwrap()
        );
    }

    #[test]
    fn missing_root_is_reported_as_disconnected_without_touching_other_paths() {
        let (temp_dir, mut infrastructure) = test_infrastructure();
        let root = temp_dir.path().join("library");
        fs::create_dir(&root).expect("library");
        infrastructure
            .set_library_root(root.clone())
            .expect("set library root");
        fs::remove_dir(&root).expect("simulate disconnected library");

        let status = infrastructure.library_status().expect("status");
        assert_eq!(status.availability, LibraryAvailability::Disconnected);
        assert!(status.reason.unwrap().contains("断开"));
        assert!(Path::new(&infrastructure.settings().unwrap().thumbnail_cache_dir).exists());
    }

    #[test]
    fn rejects_a_file_as_library_root() {
        let (temp_dir, mut infrastructure) = test_infrastructure();
        let file = temp_dir.path().join("not-a-directory");
        fs::write(&file, b"test").expect("file");
        let error = infrastructure
            .set_library_root(file)
            .expect_err("file must be rejected");
        assert!(error.to_string().contains("不是目录"));
    }

    #[test]
    fn normalizes_a_custom_thumbnail_cache_directory() {
        let (temp_dir, mut infrastructure) = test_infrastructure();
        let requested_cache = temp_dir.path().join("cache").join("nested").join("..");
        let settings = infrastructure
            .set_thumbnail_cache_dir(requested_cache)
            .expect("set thumbnail cache directory");
        assert_eq!(
            settings.thumbnail_cache_dir,
            fs::canonicalize(temp_dir.path().join("cache"))
                .unwrap()
                .to_string_lossy()
        );
        assert!(Path::new(&settings.thumbnail_cache_dir).is_dir());
    }

    #[test]
    fn normalizes_a_disconnected_root_when_loading_settings() {
        let (temp_dir, _infrastructure) = test_infrastructure();
        let settings_path = temp_dir.path().join("app-data").join("settings.json");
        let cache_path = temp_dir.path().join("cache").join("thumbs");
        let missing_root = temp_dir.path().join("missing").join("nested").join("..");
        let disk_settings = DiskSettings {
            version: SETTINGS_VERSION,
            library_root: Some(path_to_string(&missing_root)),
            thumbnail_cache_dir: path_to_string(&cache_path),
            library_volume: None,
            backup_conflict_policy: None,
        };
        fs::write(
            &settings_path,
            serde_json::to_vec(&disk_settings).expect("serialize settings"),
        )
        .expect("write settings");

        let mut loaded =
            Infrastructure::open(settings_path.clone(), temp_dir.path().join("unused-cache"))
                .expect("load settings");
        let loaded_root = loaded.settings().unwrap().library_root.unwrap();
        assert!(!loaded_root.contains(".."));
        assert_eq!(
            loaded.library_status().unwrap().availability,
            LibraryAvailability::Disconnected
        );
        let saved_text = fs::read_to_string(settings_path).expect("read normalized settings");
        assert!(!saved_text.contains(".."));
    }

    #[test]
    fn records_volume_fields_without_using_the_real_media_library() {
        let (temp_dir, mut infrastructure) = test_infrastructure();
        let root = temp_dir.path().join("library");
        fs::create_dir(&root).expect("library");
        let status = infrastructure
            .set_library_root(root)
            .expect("set library root");
        assert_eq!(status.availability, LibraryAvailability::Available);
        assert_eq!(
            status.volume.as_ref().unwrap().drive_letter,
            drive_letter(temp_dir.path())
        );
        assert_eq!(
            status.volume.as_ref().unwrap(),
            infrastructure
                .settings()
                .unwrap()
                .library_volume
                .as_ref()
                .unwrap()
        );
    }
}
