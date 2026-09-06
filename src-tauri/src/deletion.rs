//! Safe, auditable media deletion. The frontend supplies opaque media IDs;
//! this module resolves every physical file from SQLite and never trusts a
//! frontend-provided path.

use crate::db::{DeletionLogInput, MediaItemDetails, Repository};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

static NEXT_DELETE_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DeletePreviewDto {
    pub media_count: usize,
    pub file_count: usize,
    pub total_size_bytes: i64,
    pub summary: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DeleteResultDto {
    pub media_count: usize,
    pub files_recycled: usize,
    pub files_already_missing: usize,
    pub failed_files: usize,
    pub errors: Vec<String>,
}

pub fn preview(
    repository: &Repository,
    library_id: &str,
    media_item_ids: &[String],
) -> Result<DeletePreviewDto, String> {
    let root = library_root(repository, library_id)?;
    let mut seen_items = HashSet::new();
    let mut files = 0;
    let mut total_size_bytes = 0;
    let mut summary = Vec::new();
    for id in media_item_ids {
        if !seen_items.insert(id) {
            continue;
        }
        let details = repository
            .get_media_item_details(id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| format!("媒体不存在: {id}"))?;
        ensure_item_library(&details, library_id)?;
        for file in &details.files {
            // Preview performs the same path validation as deletion. Missing
            // files remain visible in the summary but are not re-deleted.
            if file.exists_now {
                let (_, candidate) = lexical_candidate(&root, &file.relative_path)?;
                match fs::symlink_metadata(&candidate) {
                    Ok(_) => {
                        let resolved = resolve_media_file(&root, &file.relative_path)?;
                        if let Ok(metadata) = fs::metadata(&resolved) {
                            total_size_bytes += metadata.len() as i64;
                        } else {
                            total_size_bytes += file.size_bytes;
                        }
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                        total_size_bytes += file.size_bytes;
                    }
                    Err(error) => return Err(format!("检查媒体文件失败: {error}")),
                }
            } else {
                total_size_bytes += file.size_bytes;
            }
            files += 1;
            summary.push(format!(
                "{} · {}",
                details.item.display_name, file.relative_path
            ));
        }
    }
    Ok(DeletePreviewDto {
        media_count: seen_items.len(),
        file_count: files,
        total_size_bytes,
        summary,
    })
}

pub fn delete_to_recycle_bin(
    repository: &Repository,
    library_id: &str,
    media_item_ids: &[String],
    thumbnail_cache_dir: &Path,
) -> Result<DeleteResultDto, String> {
    let root = library_root(repository, library_id)?;
    let mut seen_items = HashSet::new();
    let mut result = DeleteResultDto {
        media_count: 0,
        files_recycled: 0,
        files_already_missing: 0,
        failed_files: 0,
        errors: Vec::new(),
    };

    for id in media_item_ids {
        if !seen_items.insert(id) {
            continue;
        }
        result.media_count += 1;
        let details = repository
            .get_media_item_details(id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| format!("媒体不存在: {id}"))?;
        ensure_item_library(&details, library_id)?;
        for file in &details.files {
            let log_id = format!("delete-{}", NEXT_DELETE_ID.fetch_add(1, Ordering::Relaxed));
            let now = timestamp_now();
            if !file.exists_now {
                result.files_already_missing += 1;
                repository
                    .record_deletion_log(DeletionLogInput {
                        id: &log_id,
                        media_item_id: id,
                        media_file_id: Some(&file.id),
                        relative_path: Some(&file.relative_path),
                        action: "already_missing",
                        status: "skipped",
                        error_message: None,
                        created_at: &now,
                    })
                    .map_err(|e| e.to_string())?;
                continue;
            }

            let resolved = match resolve_media_file(&root, &file.relative_path) {
                Ok(path) => path,
                Err(error) => {
                    result.failed_files += 1;
                    let message = format!("{}: {}", file.relative_path, error);
                    result.errors.push(message.clone());
                    repository
                        .record_deletion_log(DeletionLogInput {
                            id: &log_id,
                            media_item_id: id,
                            media_file_id: Some(&file.id),
                            relative_path: Some(&file.relative_path),
                            action: "rejected",
                            status: "failed",
                            error_message: Some(&message),
                            created_at: &now,
                        })
                        .map_err(|e| e.to_string())?;
                    continue;
                }
            };

            if !resolved.is_file() {
                result.files_already_missing += 1;
                repository
                    .mark_media_file_deleted(&file.id, &now)
                    .map_err(|e| e.to_string())?;
                repository
                    .record_deletion_log(DeletionLogInput {
                        id: &log_id,
                        media_item_id: id,
                        media_file_id: Some(&file.id),
                        relative_path: Some(&file.relative_path),
                        action: "already_missing",
                        status: "skipped",
                        error_message: None,
                        created_at: &now,
                    })
                    .map_err(|e| e.to_string())?;
                continue;
            }

            match send_to_recycle_bin(&resolved) {
                Ok(()) => {
                    result.files_recycled += 1;
                    repository
                        .mark_media_file_deleted(&file.id, &now)
                        .map_err(|e| e.to_string())?;
                    repository
                        .record_deletion_log(DeletionLogInput {
                            id: &log_id,
                            media_item_id: id,
                            media_file_id: Some(&file.id),
                            relative_path: Some(&file.relative_path),
                            action: "recycle",
                            status: "completed",
                            error_message: None,
                            created_at: &now,
                        })
                        .map_err(|e| e.to_string())?;
                }
                Err(error) => {
                    result.failed_files += 1;
                    let message = format!("回收站删除失败 {}: {}", file.relative_path, error);
                    result.errors.push(message.clone());
                    repository
                        .record_deletion_log(DeletionLogInput {
                            id: &log_id,
                            media_item_id: id,
                            media_file_id: Some(&file.id),
                            relative_path: Some(&file.relative_path),
                            action: "recycle",
                            status: "failed",
                            error_message: Some(&message),
                            created_at: &now,
                        })
                        .map_err(|e| e.to_string())?;
                }
            }
        }
        repository
            .refresh_media_item_state(id)
            .map_err(|e| e.to_string())?;
        // Cache data is rebuildable. Remove only the library's cache subtree,
        // whose path is checked below, so stale thumbnails cannot survive.
        invalidate_library_thumbnail_cache(thumbnail_cache_dir, library_id)?;
    }
    Ok(result)
}

fn library_root(repository: &Repository, library_id: &str) -> Result<PathBuf, String> {
    let library = repository
        .get_library(library_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "媒体库不存在".to_owned())?;
    let root = fs::canonicalize(&library.root_path)
        .map_err(|e| format!("媒体库根目录 canonicalize 失败: {e}"))?;
    if !root.is_dir() {
        return Err("媒体库根目录不是目录".to_owned());
    }
    Ok(root)
}

fn ensure_item_library(details: &MediaItemDetails, library_id: &str) -> Result<(), String> {
    if details.item.library_id != library_id
        || details
            .files
            .iter()
            .any(|file| file.library_id != library_id)
    {
        return Err("媒体项不属于当前媒体库".to_owned());
    }
    Ok(())
}

/// Canonicalize both root and target. A lexical relative path check alone is
/// insufficient because a symlink can point outside the library.
pub fn resolve_media_file(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let (canonical_root, candidate) = lexical_candidate(root, relative)?;
    let canonical_file =
        fs::canonicalize(&candidate).map_err(|e| format!("媒体文件 canonicalize 失败: {e}"))?;
    if !canonical_file.starts_with(&canonical_root) {
        return Err("媒体路径越过媒体库根目录".to_owned());
    }
    if !canonical_file.is_file() {
        return Err("媒体路径不是文件".to_owned());
    }
    Ok(canonical_file)
}

fn lexical_candidate(root: &Path, relative: &str) -> Result<(PathBuf, PathBuf), String> {
    let relative_path = Path::new(relative);
    if relative.is_empty()
        || relative_path.is_absolute()
        || relative_path.components().any(|component| {
            matches!(
                component,
                Component::Prefix(_)
                    | Component::RootDir
                    | Component::ParentDir
                    | Component::CurDir
            )
        })
        || relative
            .replace('\\', "/")
            .split('/')
            .any(|part| part.is_empty())
    {
        return Err("媒体相对路径无效或包含路径穿越段".to_owned());
    }
    let canonical_root =
        fs::canonicalize(root).map_err(|e| format!("媒体库根目录 canonicalize 失败: {e}"))?;
    Ok((canonical_root.clone(), canonical_root.join(relative_path)))
}

fn invalidate_library_thumbnail_cache(cache_dir: &Path, library_id: &str) -> Result<(), String> {
    let cache_root = fs::canonicalize(cache_dir)
        .or_else(|_| {
            cache_dir
                .parent()
                .ok_or_else(|| {
                    std::io::Error::new(std::io::ErrorKind::NotFound, "缓存目录无父目录")
                })
                .and_then(fs::canonicalize)
                .map(|parent| parent.join(cache_dir.file_name().unwrap_or_default()))
        })
        .map_err(|e| format!("缩略图缓存目录 canonicalize 失败: {e}"))?;
    let thumbs = cache_root.join("thumbs");
    let library_cache = thumbs.join(safe_component(library_id));
    if library_cache.exists() {
        fs::remove_dir_all(&library_cache).map_err(|e| format!("清理缩略图缓存失败: {e}"))?;
    }
    Ok(())
}

fn safe_component(value: &str) -> String {
    value
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.') {
                c
            } else {
                '_'
            }
        })
        .collect()
}

#[cfg(windows)]
fn send_to_recycle_bin(path: &Path) -> Result<(), String> {
    use windows_sys::Win32::UI::Shell::{
        SHFileOperationW, FOF_ALLOWUNDO, FOF_NOCONFIRMATION, FOF_NOERRORUI, FOF_SILENT, FO_DELETE,
        SHFILEOPSTRUCTW,
    };
    // SHFileOperation does not accept the extended-length `\\?\` prefix
    // returned by canonicalize on some Windows configurations.
    let api_path = path
        .to_string_lossy()
        .strip_prefix(r"\\?\UNC\")
        .map(|rest| format!(r"\\{rest}"))
        .or_else(|| {
            path.to_string_lossy()
                .strip_prefix(r"\\?\")
                .map(str::to_owned)
        })
        .unwrap_or_else(|| path.to_string_lossy().into_owned());
    let mut from: Vec<u16> = api_path.encode_utf16().collect();
    from.extend([0, 0]);
    let mut operation = SHFILEOPSTRUCTW {
        hwnd: std::ptr::null_mut(),
        wFunc: FO_DELETE,
        pFrom: from.as_ptr(),
        pTo: std::ptr::null(),
        fFlags: (FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_NOERRORUI | FOF_SILENT) as u16,
        fAnyOperationsAborted: 0,
        hNameMappings: std::ptr::null_mut(),
        lpszProgressTitle: std::ptr::null(),
    };
    let code = unsafe { SHFileOperationW(&mut operation) };
    if code == 0 {
        Ok(())
    } else {
        Err(format!("Windows 回收站 API 错误码 {code}"))
    }
}

#[cfg(not(windows))]
fn send_to_recycle_bin(_path: &Path) -> Result<(), String> {
    Err("当前平台不支持 Windows 回收站".to_owned())
}

fn timestamp_now() -> String {
    format!(
        "unix-ms:{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{
        LibraryState, LivePhotoInput, MediaFileRole, MediaKind, NewLibrary, NewMediaFile,
        NewMediaItem, Repository, ScanState,
    };

    fn library(root: &Path) -> NewLibrary {
        let root = fs::canonicalize(root).unwrap();
        NewLibrary {
            id: "library-test".into(),
            root_path: root.to_string_lossy().into_owned(),
            volume_id: None,
            volume_label: None,
            drive_letter: None,
            state: LibraryState::Available,
            last_seen_at: Some("2026-01-01T00:00:00Z".into()),
            last_scan_at: None,
            scan_generation: 0,
            created_at: "2026-01-01T00:00:00Z".into(),
            updated_at: "2026-01-01T00:00:00Z".into(),
        }
    }

    fn item(id: &str) -> NewMediaItem {
        NewMediaItem {
            id: id.into(),
            library_id: "library-test".into(),
            logical_key: id.into(),
            kind: MediaKind::Live,
            display_name: id.into(),
            capture_at: None,
            capture_date: Some("2026-01-01".into()),
            width: None,
            height: None,
            duration_ms: None,
            total_size_bytes: 2,
            burst_group: None,
            metadata_json: None,
            scan_state: ScanState::Present,
            first_seen_at: "2026-01-01T00:00:00Z".into(),
            last_seen_at: "2026-01-01T00:00:00Z".into(),
        }
    }

    fn file(id: &str, item_id: &str, role: MediaFileRole, path: &str, size: i64) -> NewMediaFile {
        NewMediaFile {
            id: id.into(),
            media_item_id: item_id.into(),
            library_id: "library-test".into(),
            role,
            relative_path: path.into(),
            size_bytes: size,
            modified_at: "2026-01-01T00:00:00Z".into(),
            content_hash: None,
            hash_algorithm: None,
            file_identity: None,
            exists_now: true,
            last_scanned_at: "2026-01-01T00:00:00Z".into(),
        }
    }

    #[test]
    fn rejects_traversal_and_absolute_paths_before_filesystem_access() {
        let root = tempfile::tempdir().unwrap();
        let outside = root.path().parent().unwrap().join("outside.jpg");
        fs::write(&outside, b"outside").unwrap();
        assert!(resolve_media_file(root.path(), "../outside.jpg").is_err());
        assert!(resolve_media_file(root.path(), outside.to_string_lossy().as_ref()).is_err());
        assert!(resolve_media_file(root.path(), "./inside.jpg").is_err());
    }

    #[test]
    fn live_photo_recycles_both_files_and_repeated_delete_is_skipped() {
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("photo.jpg"), b"photo").unwrap();
        fs::write(root.path().join("photo.mov"), b"video").unwrap();
        let repository = Repository::open_in_memory().unwrap();
        repository.create_library(library(root.path())).unwrap();
        repository
            .upsert_live_photo(LivePhotoInput {
                item: item("live-1"),
                photo: file(
                    "photo-file",
                    "live-1",
                    MediaFileRole::LivePhoto,
                    "photo.jpg",
                    5,
                ),
                video: file(
                    "video-file",
                    "live-1",
                    MediaFileRole::LiveVideo,
                    "photo.mov",
                    5,
                ),
            })
            .unwrap();

        let cache = root.path().join("cache");
        let preview = preview(&repository, "library-test", &["live-1".into()]).unwrap();
        assert_eq!(preview.media_count, 1);
        assert_eq!(preview.file_count, 2);
        assert_eq!(preview.summary.len(), 2);
        let first =
            delete_to_recycle_bin(&repository, "library-test", &["live-1".into()], &cache).unwrap();
        assert_eq!(first.files_recycled, 2, "{first:?}");
        assert_eq!(first.failed_files, 0);
        assert!(!root.path().join("photo.jpg").exists());
        assert!(!root.path().join("photo.mov").exists());
        assert_eq!(
            repository
                .get_media_item("live-1")
                .unwrap()
                .unwrap()
                .scan_state,
            ScanState::Missing
        );

        let second = delete_to_recycle_bin(
            &repository,
            "library-test",
            &["live-1".into(), "live-1".into()],
            &cache,
        )
        .unwrap();
        assert_eq!(second.files_already_missing, 2);
        assert_eq!(second.failed_files, 0);
        assert_eq!(repository.deletion_log_count("live-1").unwrap(), 4);
    }

    #[test]
    fn partial_failure_recycles_valid_member_and_logs_missing_member() {
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("photo.jpg"), b"photo").unwrap();
        let repository = Repository::open_in_memory().unwrap();
        repository.create_library(library(root.path())).unwrap();
        repository
            .upsert_live_photo(LivePhotoInput {
                item: item("live-partial"),
                photo: file(
                    "photo-file",
                    "live-partial",
                    MediaFileRole::LivePhoto,
                    "photo.jpg",
                    5,
                ),
                video: file(
                    "video-file",
                    "live-partial",
                    MediaFileRole::LiveVideo,
                    "missing.mov",
                    5,
                ),
            })
            .unwrap();
        let result = delete_to_recycle_bin(
            &repository,
            "library-test",
            &["live-partial".into()],
            &root.path().join("cache"),
        )
        .unwrap();
        assert_eq!(result.files_recycled, 1, "{result:?}");
        assert_eq!(result.failed_files, 1);
        assert!(result
            .errors
            .iter()
            .any(|error| error.contains("missing.mov")));
        assert_eq!(repository.deletion_log_count("live-partial").unwrap(), 2);
        assert_eq!(
            repository
                .get_media_item("live-partial")
                .unwrap()
                .unwrap()
                .scan_state,
            ScanState::Error
        );
    }

    #[cfg(windows)]
    #[test]
    fn symlink_to_outside_is_rejected_by_canonical_containment() {
        use std::os::windows::fs::symlink_file;
        let root = tempfile::tempdir().unwrap();
        let outside = root.path().parent().unwrap().join("camlib-outside.jpg");
        let link = root.path().join("link.jpg");
        fs::write(&outside, b"outside").unwrap();
        if symlink_file(&outside, &link).is_err() {
            return;
        }
        assert!(resolve_media_file(root.path(), "link.jpg").is_err());
    }
}
