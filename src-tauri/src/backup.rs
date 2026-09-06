//! Camera-volume discovery and read-only backup planning.
//!
//! This module deliberately stops at a persisted preview.  It does not copy,
//! rename, delete, or otherwise write camera files.  A later execution phase
//! can consume the preview after the safety checks here have passed.

use crate::db::{BackupStatus, ConflictPolicy, NewBackupRun, Repository};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

const DEFAULT_IGNORED_EXTENSIONS: &[&str] = &[".dng", ".lrv"];
const PHOTO_EXTENSIONS: &[&str] = &[
    ".jpg", ".jpeg", ".png", ".heic", ".heif", ".tif", ".tiff", ".cr2", ".cr3", ".nef", ".arw",
    ".raf", ".rw2", ".orf",
];
const VIDEO_EXTENSIONS: &[&str] = &[".mp4", ".mov", ".avi", ".m4v", ".mts", ".m2ts", ".3gp"];

static NEXT_BACKUP: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BackupVolumeDto {
    pub id: String,
    pub root_path: String,
    pub dcim_path: String,
    pub volume_label: Option<String>,
    pub drive_letter: Option<String>,
    pub removable: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupPreviewRequest {
    pub source_volume_id: String,
    pub target_library_id: String,
    pub conflict_policy: Option<ConflictPolicy>,
    pub ignore_extensions: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum BackupItemStatus {
    Ready,
    AlreadyExists,
    Conflict,
    Ignored,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupItemPreviewDto {
    pub source_relative: String,
    pub destination_relative: Option<String>,
    pub file_name: String,
    pub kind: Option<String>,
    pub capture_date: Option<String>,
    pub date_source: Option<String>,
    pub size_bytes: u64,
    pub extension: String,
    pub status: BackupItemStatus,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupPreviewDto {
    pub id: String,
    pub backup_run_id: String,
    pub source: BackupVolumeDto,
    pub target_library_id: String,
    pub target_root_path: String,
    pub conflict_policy: ConflictPolicy,
    pub ignore_extensions: Vec<String>,
    pub items: Vec<BackupItemPreviewDto>,
    pub total_files: u64,
    pub total_bytes: u64,
    pub ready_files: u64,
    pub already_exists_files: u64,
    pub conflict_files: u64,
    pub ignored_files: u64,
    pub required_bytes: u64,
    pub free_bytes: Option<u64>,
    pub space_sufficient: Option<bool>,
}

#[derive(Debug, Clone)]
struct VolumeCandidate {
    root_path: PathBuf,
    dcim_path: PathBuf,
    volume_id: Option<String>,
    volume_label: Option<String>,
    drive_letter: Option<String>,
    removable: bool,
}

#[derive(Debug)]
pub enum BackupError {
    Io { path: PathBuf, source: io::Error },
    Invalid(String),
    Database(crate::db::DbError),
}

impl std::fmt::Display for BackupError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io { path, source } => write!(f, "读取备份路径失败 {}: {source}", path.display()),
            Self::Invalid(message) => write!(f, "备份预览无效: {message}"),
            Self::Database(error) => write!(f, "备份记录失败: {error}"),
        }
    }
}

impl std::error::Error for BackupError {}

impl From<crate::db::DbError> for BackupError {
    fn from(value: crate::db::DbError) -> Self {
        Self::Database(value)
    }
}

pub fn default_ignore_extensions() -> Vec<String> {
    DEFAULT_IGNORED_EXTENSIONS
        .iter()
        .map(|value| (*value).to_owned())
        .collect()
}

/// Discover removable Windows volumes whose root contains a direct `DCIM`
/// directory. The candidate list is intentionally injectable for tests.
pub fn discover_volumes() -> Vec<BackupVolumeDto> {
    discover_candidates()
        .into_iter()
        .map(|candidate| volume_dto(&candidate))
        .collect()
}

pub fn preview(
    repository: &Repository,
    request: BackupPreviewRequest,
) -> Result<BackupPreviewDto, BackupError> {
    let source = discover_candidates()
        .into_iter()
        .find(|candidate| volume_dto(candidate).id == request.source_volume_id)
        .ok_or_else(|| BackupError::Invalid("源相机盘不存在，或已断开".to_owned()))?;
    let target = repository
        .get_library(&request.target_library_id)?
        .ok_or_else(|| BackupError::Invalid("目标媒体库不存在".to_owned()))?;
    let free_bytes = available_space(Path::new(&target.root_path));
    preview_paths(
        repository,
        source,
        target.root_path,
        request.target_library_id,
        request.conflict_policy.unwrap_or(ConflictPolicy::SkipSame),
        request.ignore_extensions,
        free_bytes,
    )
}

fn preview_paths(
    repository: &Repository,
    source: VolumeCandidate,
    target_root_path: String,
    target_library_id: String,
    conflict_policy: ConflictPolicy,
    ignore_extensions: Option<Vec<String>>,
    free_bytes: Option<u64>,
) -> Result<BackupPreviewDto, BackupError> {
    let source_root = fs::canonicalize(&source.root_path).map_err(|error| BackupError::Io {
        path: source.root_path.clone(),
        source: error,
    })?;
    let target_root =
        fs::canonicalize(Path::new(&target_root_path)).map_err(|error| BackupError::Io {
            path: PathBuf::from(&target_root_path),
            source: error,
        })?;
    let dcim_path = fs::canonicalize(&source.dcim_path).map_err(|error| BackupError::Io {
        path: source.dcim_path.clone(),
        source: error,
    })?;
    if is_same_or_child(&target_root, &source_root) {
        return Err(BackupError::Invalid(
            "目标媒体库不能位于相机源盘内".to_owned(),
        ));
    }
    let ignore_extensions =
        normalize_extensions(ignore_extensions.unwrap_or_else(default_ignore_extensions));
    let ignore_extensions_list = sorted_extensions(&ignore_extensions);
    let items = collect_items(&source_root, &dcim_path, &target_root, &ignore_extensions)?;
    let source_dto = volume_dto(&source);
    let total_files = items.len() as u64;
    let total_bytes = items.iter().map(|item| item.size_bytes).sum();
    let ready_files = count_status(&items, BackupItemStatus::Ready);
    let already_exists_files = count_status(&items, BackupItemStatus::AlreadyExists);
    let conflict_files = count_status(&items, BackupItemStatus::Conflict);
    let ignored_files = count_status(&items, BackupItemStatus::Ignored);
    let required_bytes = items
        .iter()
        .filter(|item| {
            matches!(
                item.status,
                BackupItemStatus::Ready | BackupItemStatus::Conflict
            )
        })
        .map(|item| item.size_bytes)
        .sum();
    let space_sufficient = free_bytes.map(|free| free >= required_bytes);
    let preview_id = next_id("preview");
    let backup_run_id = next_id("backup-run");
    let error_summary = space_sufficient
        .filter(|sufficient| !sufficient)
        .map(|_| format!("目标盘空间不足，需要 {required_bytes} 字节"));

    repository.create_backup_run(NewBackupRun {
        id: backup_run_id.clone(),
        job_id: preview_id.clone(),
        source_volume_id: Some(source_dto.id.clone()),
        source_root_path: source_dto.root_path.clone(),
        target_library_id: target_library_id.clone(),
        status: BackupStatus::Preview,
        conflict_policy: conflict_policy.clone(),
        ignore_extensions: serde_json::to_string(&ignore_extensions_list)
            .map_err(|error| BackupError::Invalid(format!("忽略配置无法序列化: {error}")))?,
        started_at: timestamp_now(),
        finished_at: None,
        total_files: total_files as i64,
        copied_files: 0,
        skipped_files: (already_exists_files + ignored_files) as i64,
        failed_files: 0,
        total_bytes: total_bytes as i64,
        copied_bytes: 0,
        error_summary,
    })?;

    Ok(BackupPreviewDto {
        id: preview_id,
        backup_run_id,
        source: source_dto,
        target_library_id,
        target_root_path,
        conflict_policy,
        ignore_extensions: ignore_extensions_list,
        items,
        total_files,
        total_bytes,
        ready_files,
        already_exists_files,
        conflict_files,
        ignored_files,
        required_bytes,
        free_bytes,
        space_sufficient,
    })
}

fn collect_items(
    source_root: &Path,
    dcim_path: &Path,
    target_root: &Path,
    ignore_extensions: &HashSet<String>,
) -> Result<Vec<BackupItemPreviewDto>, BackupError> {
    let mut files = Vec::new();
    collect_files(dcim_path, &mut files)?;
    files.sort_by(|left, right| left.file_name().cmp(&right.file_name()));

    files
        .into_iter()
        .map(|path| plan_item(source_root, &path, target_root, ignore_extensions))
        .collect()
}

fn collect_files(path: &Path, output: &mut Vec<PathBuf>) -> Result<(), BackupError> {
    let entries = fs::read_dir(path).map_err(|error| BackupError::Io {
        path: path.to_owned(),
        source: error,
    })?;
    for entry in entries {
        let entry = entry.map_err(|error| BackupError::Io {
            path: path.to_owned(),
            source: error,
        })?;
        let file_type = entry.file_type().map_err(|error| BackupError::Io {
            path: entry.path(),
            source: error,
        })?;
        if file_type.is_symlink() {
            continue;
        }
        if file_type.is_dir() {
            collect_files(&entry.path(), output)?;
        } else if file_type.is_file() {
            output.push(entry.path());
        }
    }
    Ok(())
}

fn plan_item(
    source_root: &Path,
    source_path: &Path,
    target_root: &Path,
    ignore_extensions: &HashSet<String>,
) -> Result<BackupItemPreviewDto, BackupError> {
    let metadata = fs::metadata(source_path).map_err(|error| BackupError::Io {
        path: source_path.to_owned(),
        source: error,
    })?;
    let file_name = source_path
        .file_name()
        .ok_or_else(|| BackupError::Invalid("相机文件缺少文件名".to_owned()))?
        .to_string_lossy()
        .into_owned();
    let extension = source_path
        .extension()
        .map(|extension| format!(".{}", extension.to_string_lossy().to_ascii_lowercase()))
        .unwrap_or_default();
    let source_relative = relative_path(source_root, source_path)?;
    if ignore_extensions.contains(&extension) {
        return Ok(BackupItemPreviewDto {
            source_relative,
            destination_relative: None,
            file_name,
            kind: None,
            capture_date: None,
            date_source: None,
            size_bytes: metadata.len(),
            extension,
            status: BackupItemStatus::Ignored,
            reason: Some("扩展名按备份设置忽略".to_owned()),
        });
    }
    let kind = if PHOTO_EXTENSIONS.contains(&extension.as_str()) {
        "照片"
    } else if VIDEO_EXTENSIONS.contains(&extension.as_str()) {
        "视频"
    } else {
        return Ok(BackupItemPreviewDto {
            source_relative,
            destination_relative: None,
            file_name,
            kind: None,
            capture_date: None,
            date_source: None,
            size_bytes: metadata.len(),
            extension,
            status: BackupItemStatus::Ignored,
            reason: Some("不支持的媒体扩展名".to_owned()),
        });
    };

    let (capture_date, date_source) = capture_date(&file_name, &metadata)
        .map(|(date, source)| (Some(date), Some(source)))
        .unwrap_or((None, None));
    let destination_relative = capture_date.as_ref().map(|date| {
        let year = &date[0..4];
        let month = &date[5..7];
        PathBuf::from(year)
            .join(month)
            .join(date)
            .join(kind)
            .join(&file_name)
    });
    let Some(destination_relative_path) = destination_relative else {
        return Ok(BackupItemPreviewDto {
            source_relative,
            destination_relative: None,
            file_name,
            kind: Some(kind.to_owned()),
            capture_date: None,
            date_source: None,
            size_bytes: metadata.len(),
            extension,
            status: BackupItemStatus::Ignored,
            reason: Some("无法确定拍摄日期".to_owned()),
        });
    };
    let destination_path = target_root.join(&destination_relative_path);
    let status = if !destination_path.exists() {
        BackupItemStatus::Ready
    } else if files_equal(source_path, &destination_path)? {
        BackupItemStatus::AlreadyExists
    } else {
        BackupItemStatus::Conflict
    };
    Ok(BackupItemPreviewDto {
        source_relative,
        destination_relative: Some(path_to_string(&destination_relative_path)),
        file_name,
        kind: Some(kind.to_owned()),
        capture_date,
        date_source,
        size_bytes: metadata.len(),
        extension,
        status,
        reason: None,
    })
}

fn files_equal(left: &Path, right: &Path) -> Result<bool, BackupError> {
    let left_metadata = fs::metadata(left).map_err(|error| BackupError::Io {
        path: left.to_owned(),
        source: error,
    })?;
    let right_metadata = fs::metadata(right).map_err(|error| BackupError::Io {
        path: right.to_owned(),
        source: error,
    })?;
    if left_metadata.len() != right_metadata.len() {
        return Ok(false);
    }
    let left_bytes = fs::read(left).map_err(|error| BackupError::Io {
        path: left.to_owned(),
        source: error,
    })?;
    let right_bytes = fs::read(right).map_err(|error| BackupError::Io {
        path: right.to_owned(),
        source: error,
    })?;
    Ok(left_bytes == right_bytes)
}

fn capture_date(file_name: &str, metadata: &fs::Metadata) -> Option<(String, String)> {
    let bytes = file_name.as_bytes();
    for start in 0..bytes.len().saturating_sub(7) {
        if !bytes[start..start + 8].iter().all(u8::is_ascii_digit) {
            continue;
        }
        let date = std::str::from_utf8(&bytes[start..start + 8]).ok()?;
        if valid_date_digits(date) {
            return Some((
                format!("{}-{}-{}", &date[0..4], &date[4..6], &date[6..8]),
                "filename".to_owned(),
            ));
        }
    }
    let modified = metadata.modified().ok()?;
    Some((date_from_system_time(modified)?, "file_time".to_owned()))
}

fn valid_date_digits(date: &str) -> bool {
    if date.len() != 8 || !date.bytes().all(|byte| byte.is_ascii_digit()) {
        return false;
    }
    let year = date[0..4].parse::<u32>().ok();
    let month = date[4..6].parse::<u32>().ok();
    let day = date[6..8].parse::<u32>().ok();
    matches!((year, month, day), (Some(year), Some(month), Some(day)) if (1970..=2100).contains(&year) && (1..=12).contains(&month) && (1..=days_in_month(year, month)).contains(&day))
}

fn days_in_month(year: u32, month: u32) -> u32 {
    match month {
        2 if year % 400 == 0 || (year % 4 == 0 && year % 100 != 0) => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    }
}

fn date_from_system_time(time: SystemTime) -> Option<String> {
    let seconds = time.duration_since(UNIX_EPOCH).ok()?.as_secs() as i64;
    let days = seconds.div_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    Some(format!("{year:04}-{month:02}-{day:02}"))
}

// Howard Hinnant's Gregorian calendar conversion, kept local to avoid a
// heavyweight date dependency for a date-only backup planner.
fn civil_from_days(days: i64) -> (i32, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = mp + if mp < 10 { 3 } else { -9 };
    let year = y + if month <= 2 { 1 } else { 0 };
    (year as i32, month as u32, day as u32)
}

fn normalize_extensions(values: Vec<String>) -> HashSet<String> {
    values
        .into_iter()
        .map(|value| {
            let value = value.trim().to_ascii_lowercase();
            if value.starts_with('.') {
                value
            } else {
                format!(".{value}")
            }
        })
        .filter(|value| value.len() > 1)
        .collect()
}

fn sorted_extensions(values: &HashSet<String>) -> Vec<String> {
    let mut values = values.iter().cloned().collect::<Vec<_>>();
    values.sort();
    values
}

fn relative_path(root: &Path, path: &Path) -> Result<String, BackupError> {
    path.strip_prefix(root)
        .map(path_to_string)
        .map_err(|_| BackupError::Invalid(format!("源文件越过源盘边界: {}", path.display())))
}

fn path_to_string(path: &Path) -> String {
    path.to_string_lossy().replace('/', "\\")
}

fn is_same_or_child(path: &Path, root: &Path) -> bool {
    path == root || path.strip_prefix(root).is_ok()
}

fn count_status(items: &[BackupItemPreviewDto], status: BackupItemStatus) -> u64 {
    items.iter().filter(|item| item.status == status).count() as u64
}

fn volume_dto(candidate: &VolumeCandidate) -> BackupVolumeDto {
    let root_path = path_to_string(&candidate.root_path);
    let id = candidate
        .volume_id
        .clone()
        .unwrap_or_else(|| stable_id(&root_path));
    BackupVolumeDto {
        id,
        root_path,
        dcim_path: path_to_string(&candidate.dcim_path),
        volume_label: candidate.volume_label.clone(),
        drive_letter: candidate.drive_letter.clone(),
        removable: candidate.removable,
    }
}

fn stable_id(value: &str) -> String {
    let mut hash = 0xcbf29ce484222325_u64;
    for byte in value.to_ascii_lowercase().as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("volume-{hash:016x}")
}

fn next_id(prefix: &str) -> String {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!(
        "{prefix}-{stamp}-{}",
        NEXT_BACKUP.fetch_add(1, Ordering::Relaxed)
    )
}

fn timestamp_now() -> String {
    format!(
        "unix-ms:{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
    )
}

fn discover_candidates() -> Vec<VolumeCandidate> {
    #[cfg(windows)]
    {
        return windows_candidates();
    }
    #[cfg(not(windows))]
    {
        Vec::new()
    }
}

#[cfg(windows)]
fn windows_candidates() -> Vec<VolumeCandidate> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{GetDriveTypeW, GetLogicalDrives};
    let mask = unsafe { GetLogicalDrives() };
    let mut result = Vec::new();
    for index in 0..26 {
        if mask & (1 << index) == 0 {
            continue;
        }
        let letter = (b'A' + index as u8) as char;
        let root = PathBuf::from(format!("{letter}:\\"));
        let wide: Vec<u16> = root.as_os_str().encode_wide().chain(Some(0)).collect();
        if unsafe { GetDriveTypeW(wide.as_ptr()) } != 2 {
            continue;
        }
        let Ok(dcim_path) = find_dcim(&root) else {
            continue;
        };
        let (volume_label, volume_id) = windows_volume_identity(&wide);
        result.push(VolumeCandidate {
            root_path: root,
            dcim_path,
            volume_id,
            volume_label,
            drive_letter: Some(letter.to_string()),
            removable: true,
        });
    }
    result
}

#[cfg(windows)]
fn windows_volume_identity(root: &[u16]) -> (Option<String>, Option<String>) {
    use windows_sys::Win32::Storage::FileSystem::GetVolumeInformationW;
    let mut label = [0u16; 261];
    let mut serial = 0u32;
    let mut max_component = 0u32;
    let mut flags = 0u32;
    let success = unsafe {
        GetVolumeInformationW(
            root.as_ptr(),
            label.as_mut_ptr(),
            label.len() as u32,
            &mut serial,
            &mut max_component,
            &mut flags,
            std::ptr::null_mut(),
            0,
        )
    };
    if success == 0 {
        return (None, None);
    }
    let length = label
        .iter()
        .position(|value| *value == 0)
        .unwrap_or(label.len());
    (
        Some(String::from_utf16_lossy(&label[..length])),
        Some(format!("serial-{serial:08x}")),
    )
}

fn find_dcim(root: &Path) -> Result<PathBuf, BackupError> {
    let entries = fs::read_dir(root).map_err(|error| BackupError::Io {
        path: root.to_owned(),
        source: error,
    })?;
    for entry in entries {
        let entry = entry.map_err(|error| BackupError::Io {
            path: root.to_owned(),
            source: error,
        })?;
        if entry
            .file_type()
            .map_err(|error| BackupError::Io {
                path: entry.path(),
                source: error,
            })?
            .is_dir()
            && entry
                .file_name()
                .to_string_lossy()
                .eq_ignore_ascii_case("DCIM")
        {
            return Ok(entry.path());
        }
    }
    Err(BackupError::Invalid("卷中没有 DCIM 目录".to_owned()))
}

#[cfg(windows)]
fn available_space(path: &Path) -> Option<u64> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
    let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    let mut free = 0u64;
    let mut total = 0u64;
    let mut available = 0u64;
    let success =
        unsafe { GetDiskFreeSpaceExW(wide.as_ptr(), &mut available, &mut total, &mut free) };
    (success != 0).then_some(available)
}

#[cfg(not(windows))]
fn available_space(_path: &Path) -> Option<u64> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{LibraryState, NewLibrary};
    use std::fs;
    use tempfile::TempDir;

    fn library(repository: &Repository, root: &Path) {
        repository
            .create_library(NewLibrary {
                id: "library-test".to_owned(),
                root_path: root.to_string_lossy().into_owned(),
                volume_id: None,
                volume_label: Some("测试媒体库".to_owned()),
                drive_letter: None,
                state: LibraryState::Available,
                last_seen_at: None,
                last_scan_at: None,
                scan_generation: 0,
                created_at: timestamp_now(),
                updated_at: timestamp_now(),
            })
            .unwrap();
    }

    fn source_candidate(root: &Path) -> VolumeCandidate {
        VolumeCandidate {
            root_path: root.to_owned(),
            dcim_path: root.join("DCIM"),
            volume_id: Some("test-camera".to_owned()),
            volume_label: Some("TEST-CAMERA".to_owned()),
            drive_letter: None,
            removable: true,
        }
    }

    fn write(path: &Path, bytes: &[u8]) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, bytes).unwrap();
    }

    #[test]
    fn preview_classifies_duplicates_conflicts_ignored_and_filename_dates_without_writing() {
        let source = TempDir::new().unwrap();
        let target = TempDir::new().unwrap();
        let repository = Repository::open_in_memory().unwrap();
        library(&repository, target.path());
        write(
            &source.path().join("DCIM/100MEDIA/IMG_20240102_123456.JPG"),
            b"same",
        );
        write(
            &source.path().join("DCIM/100MEDIA/VID_20240102_123500.MP4"),
            b"different",
        );
        write(
            &source.path().join("DCIM/100MEDIA/RAW_20240102_123501.DNG"),
            b"raw",
        );
        write(&source.path().join("DCIM/100MEDIA/notes.txt"), b"ignored");
        write(
            &target
                .path()
                .join("2024/01/2024-01-02/照片/IMG_20240102_123456.JPG"),
            b"same",
        );
        write(
            &target
                .path()
                .join("2024/01/2024-01-02/视频/VID_20240102_123500.MP4"),
            b"other",
        );
        let source_before =
            fs::read(source.path().join("DCIM/100MEDIA/VID_20240102_123500.MP4")).unwrap();

        let preview = preview_paths(
            &repository,
            source_candidate(source.path()),
            target.path().to_string_lossy().into_owned(),
            "library-test".to_owned(),
            ConflictPolicy::SkipSame,
            None,
            Some(5),
        )
        .unwrap();

        assert_eq!(preview.already_exists_files, 1);
        assert_eq!(preview.conflict_files, 1);
        assert_eq!(preview.ignored_files, 2);
        assert_eq!(preview.ready_files, 0);
        assert_eq!(preview.space_sufficient, Some(false));
        assert!(preview
            .items
            .iter()
            .any(|item| item.date_source.as_deref() == Some("filename")));
        assert_eq!(
            fs::read(source.path().join("DCIM/100MEDIA/VID_20240102_123500.MP4")).unwrap(),
            source_before
        );
        assert!(!target
            .path()
            .join("2024/01/2024-01-02/视频/RAW_20240102_123501.DNG")
            .exists());
        assert!(repository
            .get_backup_run(&preview.backup_run_id)
            .unwrap()
            .is_some());
    }

    #[test]
    fn preview_falls_back_to_file_time_and_normalizes_ignore_configuration() {
        let source = TempDir::new().unwrap();
        let target = TempDir::new().unwrap();
        let repository = Repository::open_in_memory().unwrap();
        library(&repository, target.path());
        write(&source.path().join("DCIM/NO_DATE/clip.MOV"), b"video");
        write(
            &source.path().join("DCIM/NO_DATE/IMG_20240231_120000.JPG"),
            b"photo",
        );
        let preview = preview_paths(
            &repository,
            source_candidate(source.path()),
            target.path().to_string_lossy().into_owned(),
            "library-test".to_owned(),
            ConflictPolicy::SkipSame,
            Some(vec!["LRV".to_owned()]),
            Some(u64::MAX),
        )
        .unwrap();
        let item = preview
            .items
            .iter()
            .find(|item| item.file_name == "clip.MOV")
            .unwrap();
        assert_eq!(item.date_source.as_deref(), Some("file_time"));
        let invalid_date_item = preview
            .items
            .iter()
            .find(|item| item.file_name == "IMG_20240231_120000.JPG")
            .unwrap();
        assert_eq!(invalid_date_item.date_source.as_deref(), Some("file_time"));
        assert_eq!(preview.ignore_extensions, vec![".lrv"]);
        assert!(preview.space_sufficient == Some(true));
    }

    #[test]
    fn preview_rejects_target_inside_camera_source() {
        let source = TempDir::new().unwrap();
        let repository = Repository::open_in_memory().unwrap();
        let target = source.path().join("target");
        fs::create_dir_all(&target).unwrap();
        library(&repository, &target);
        fs::create_dir_all(source.path().join("DCIM")).unwrap();
        let error = preview_paths(
            &repository,
            source_candidate(source.path()),
            source.path().join("target").to_string_lossy().into_owned(),
            "library-test".to_owned(),
            ConflictPolicy::SkipSame,
            None,
            Some(0),
        )
        .unwrap_err();
        assert!(error.to_string().contains("不能位于相机源盘内"));
    }
}
