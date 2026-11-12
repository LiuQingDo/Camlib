//! Media browsing, tagging, thumbnails, previews, scans, and deletion commands.

use super::ensure_library_ready;
use crate::db::{self, MediaKind, MediaQuery, MediaSort};
use crate::deletion;
use crate::errors::AppError;
use crate::infrastructure::{self, InfrastructureError, InfrastructureState};
use crate::media::{self, MediaStreamRegistry, PreviewJobManagerState};
use crate::scanner::{self, ScanManagerState, ScanStartResponse};
use serde::Deserialize;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaQueryInput {
    library_id: String,
    kind: Option<MediaKind>,
    favorite_only: Option<bool>,
    burst_only: Option<bool>,
    search: Option<String>,
    date_prefix: Option<String>,
    date_from: Option<String>,
    date_to: Option<String>,
    first_seen_from: Option<String>,
    tag_ids: Option<Vec<String>>,
    rating_eq: Option<i64>,
    rating_min: Option<i64>,
    offset: Option<i64>,
    limit: Option<i64>,
    sort: Option<String>,
}

#[tauri::command]
pub fn library_list(state: State<'_, InfrastructureState>) -> Result<Vec<db::Library>, AppError> {
    state.with_infrastructure(|infrastructure| {
        infrastructure
            .repository()
            .list_libraries()
            .map_err(infrastructure::InfrastructureError::database)
    })
}

#[tauri::command]
pub fn media_query(
    query: MediaQueryInput,
    state: State<'_, InfrastructureState>,
) -> Result<db::MediaPage, AppError> {
    let sort = match query.sort.as_deref() {
        Some("oldest") => MediaSort::Oldest,
        Some("name") => MediaSort::Name,
        Some("rating-desc") => MediaSort::RatingDesc,
        Some("rating-asc") => MediaSort::RatingAsc,
        Some("size-desc") => MediaSort::SizeDesc,
        Some("size-asc") => MediaSort::SizeAsc,
        _ => MediaSort::Newest,
    };
    state.with_infrastructure(|infrastructure| {
        infrastructure
            .repository()
            .query_media(MediaQuery {
                library_id: query.library_id,
                kind: query.kind,
                favorite_only: query.favorite_only.unwrap_or(false),
                burst_only: query.burst_only.unwrap_or(false),
                search: query.search,
                date_prefix: query.date_prefix,
                date_from: query.date_from,
                date_to: query.date_to,
                first_seen_from: query.first_seen_from,
                tag_ids: query.tag_ids.unwrap_or_default(),
                item_ids: Vec::new(),
                rating_eq: query.rating_eq,
                rating_min: query.rating_min,
                offset: query.offset.unwrap_or(0),
                limit: query.limit.unwrap_or(120),
                sort,
            })
            .map_err(infrastructure::InfrastructureError::database)
    })
}

#[tauri::command]
pub fn media_date_facets(
    library_id: String,
    state: State<'_, InfrastructureState>,
) -> Result<Vec<db::DateFacet>, AppError> {
    state.with_infrastructure(|infrastructure| {
        infrastructure
            .repository()
            .list_date_facets(&library_id)
            .map_err(infrastructure::InfrastructureError::database)
    })
}

#[tauri::command]
pub fn media_get(
    media_item_id: String,
    state: State<'_, InfrastructureState>,
) -> Result<db::MediaItemDetails, AppError> {
    state.with_infrastructure(|infrastructure| {
        infrastructure
            .repository()
            .get_media_item_details(&media_item_id)
            .map_err(infrastructure::InfrastructureError::database)?
            .ok_or_else(|| {
                infrastructure::InfrastructureError::MediaMissing("媒体不存在".to_owned())
            })
    })
}

/// Open Explorer with the media file selected. Only an opaque media id is
/// accepted; the absolute path is resolved from the library root on disk.
#[tauri::command]
pub fn media_open_folder(
    media_item_id: String,
    state: State<'_, InfrastructureState>,
) -> Result<(), AppError> {
    let (details, root) = state.with_infrastructure(|infrastructure| {
        let details = infrastructure
            .repository()
            .get_media_item_details(&media_item_id)
            .map_err(infrastructure::InfrastructureError::database)?
            .ok_or_else(|| {
                infrastructure::InfrastructureError::MediaMissing("媒体不存在".to_owned())
            })?;
        let library = infrastructure
            .repository()
            .get_library(&details.item.library_id)
            .map_err(infrastructure::InfrastructureError::database)?
            .ok_or_else(|| {
                infrastructure::InfrastructureError::InvalidPath("媒体库不存在".to_owned())
            })?;
        Ok((details, PathBuf::from(library.root_path)))
    })?;

    // Prefer a present photo/single file so Live Photos open on the still.
    let candidate = details
        .files
        .iter()
        .filter(|file| file.exists_now)
        .min_by_key(|file| match file.role {
            db::MediaFileRole::Single => 0,
            db::MediaFileRole::LivePhoto => 1,
            db::MediaFileRole::LiveVideo => 2,
        })
        .or_else(|| details.files.first())
        .ok_or_else(|| AppError::media_missing("媒体没有可打开的文件"))?;

    if !candidate.exists_now {
        return Err(AppError::media_missing(
            "媒体文件已离线或不存在，无法打开所在文件夹",
        ));
    }

    let resolved = deletion::resolve_media_file(&root, &candidate.relative_path)?;
    tauri_plugin_opener::reveal_item_in_dir(&resolved)
        .map_err(|error| AppError::io(format!("打开资源管理器失败: {error}")))
}

#[tauri::command]
pub fn favorite_set(
    media_item_id: String,
    favorite: bool,
    state: State<'_, InfrastructureState>,
) -> Result<(), AppError> {
    let now = format!(
        "unix-ms:{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
    );
    state.with_infrastructure(|infrastructure| {
        infrastructure
            .repository()
            .set_favorite(&media_item_id, favorite, &now)
            .map_err(infrastructure::InfrastructureError::database)
    })
}

#[tauri::command]
pub fn favorite_set_batch(
    media_item_ids: Vec<String>,
    favorite: bool,
    state: State<'_, InfrastructureState>,
) -> Result<usize, AppError> {
    let now = format!(
        "unix-ms:{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
    );
    state.with_infrastructure(|infrastructure| {
        infrastructure
            .repository()
            .set_favorites_batch(&media_item_ids, favorite, &now)
            .map_err(infrastructure::InfrastructureError::database)
    })
}

pub fn now_unix_ms() -> String {
    format!(
        "unix-ms:{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
    )
}

#[tauri::command]
pub fn tag_list(state: State<'_, InfrastructureState>) -> Result<Vec<db::Tag>, AppError> {
    state.with_infrastructure(|infrastructure| {
        infrastructure
            .repository()
            .list_tags()
            .map_err(infrastructure::InfrastructureError::database)
    })
}

#[tauri::command]
pub fn tag_create(
    name: String,
    color: Option<String>,
    state: State<'_, InfrastructureState>,
) -> Result<db::Tag, AppError> {
    let now = now_unix_ms();
    let id = format!("tag-{:016x}", {
        use std::hash::{Hash, Hasher};
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        name.trim().to_lowercase().hash(&mut hasher);
        now.hash(&mut hasher);
        hasher.finish()
    });
    state.with_infrastructure(|infrastructure| {
        infrastructure
            .repository()
            .create_tag(db::NewTag {
                id,
                name: name.trim().to_owned(),
                color,
                created_at: now,
            })
            .map_err(infrastructure::InfrastructureError::database)
    })
}

#[tauri::command]
pub fn tag_find_or_create(
    name: String,
    color: Option<String>,
    state: State<'_, InfrastructureState>,
) -> Result<db::Tag, AppError> {
    let now = now_unix_ms();
    let id = format!("tag-{:016x}", {
        use std::hash::{Hash, Hasher};
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        name.trim().to_lowercase().hash(&mut hasher);
        now.hash(&mut hasher);
        hasher.finish()
    });
    state.with_infrastructure(|infrastructure| {
        infrastructure
            .repository()
            .find_or_create_tag(db::NewTag {
                id,
                name: name.trim().to_owned(),
                color,
                created_at: now,
            })
            .map_err(infrastructure::InfrastructureError::database)
    })
}

#[tauri::command]
pub fn tag_update(
    tag_id: String,
    name: Option<String>,
    color: Option<String>,
    state: State<'_, InfrastructureState>,
) -> Result<db::Tag, AppError> {
    state.with_infrastructure(|infrastructure| {
        infrastructure
            .repository()
            .update_tag(&tag_id, name.as_deref(), color.as_deref())
            .map_err(infrastructure::InfrastructureError::database)
    })
}

#[tauri::command]
pub fn tag_delete(tag_id: String, state: State<'_, InfrastructureState>) -> Result<(), AppError> {
    state.with_infrastructure(|infrastructure| {
        infrastructure
            .repository()
            .delete_tag(&tag_id)
            .map_err(infrastructure::InfrastructureError::database)
    })
}

#[tauri::command]
pub fn tag_attach(
    media_item_id: String,
    tag_id: String,
    state: State<'_, InfrastructureState>,
) -> Result<(), AppError> {
    let now = now_unix_ms();
    state.with_infrastructure(|infrastructure| {
        infrastructure
            .repository()
            .attach_tag(&media_item_id, &tag_id, &now)
            .map_err(infrastructure::InfrastructureError::database)
    })
}

#[tauri::command]
pub fn tag_detach(
    media_item_id: String,
    tag_id: String,
    state: State<'_, InfrastructureState>,
) -> Result<(), AppError> {
    state.with_infrastructure(|infrastructure| {
        infrastructure
            .repository()
            .detach_tag(&media_item_id, &tag_id)
            .map_err(infrastructure::InfrastructureError::database)
    })
}

#[tauri::command]
pub fn tag_attach_batch(
    media_item_ids: Vec<String>,
    tag_id: String,
    state: State<'_, InfrastructureState>,
) -> Result<usize, AppError> {
    let now = now_unix_ms();
    state.with_infrastructure(|infrastructure| {
        infrastructure
            .repository()
            .attach_tags_batch(&media_item_ids, &tag_id, &now)
            .map_err(infrastructure::InfrastructureError::database)
    })
}

#[tauri::command]
pub fn tag_detach_batch(
    media_item_ids: Vec<String>,
    tag_id: String,
    state: State<'_, InfrastructureState>,
) -> Result<usize, AppError> {
    state.with_infrastructure(|infrastructure| {
        infrastructure
            .repository()
            .detach_tags_batch(&media_item_ids, &tag_id)
            .map_err(infrastructure::InfrastructureError::database)
    })
}

#[tauri::command]
pub fn rating_set(
    media_item_id: String,
    rating: i64,
    state: State<'_, InfrastructureState>,
) -> Result<(), AppError> {
    let now = now_unix_ms();
    state.with_infrastructure(|infrastructure| {
        infrastructure
            .repository()
            .set_rating(&media_item_id, rating, &now)
            .map_err(infrastructure::InfrastructureError::database)
    })
}

#[tauri::command]
pub fn rating_set_batch(
    media_item_ids: Vec<String>,
    rating: i64,
    state: State<'_, InfrastructureState>,
) -> Result<usize, AppError> {
    let now = now_unix_ms();
    state.with_infrastructure(|infrastructure| {
        infrastructure
            .repository()
            .set_ratings_batch(&media_item_ids, rating, &now)
            .map_err(infrastructure::InfrastructureError::database)
    })
}

#[tauri::command]
pub fn media_delete_preview(
    library_id: String,
    media_item_ids: Vec<String>,
    state: State<'_, InfrastructureState>,
) -> Result<deletion::DeletePreviewDto, AppError> {
    state.with_infrastructure(|infrastructure| {
        ensure_library_ready(infrastructure, &library_id)?;
        deletion::preview(infrastructure.repository(), &library_id, &media_item_ids)
            .map_err(InfrastructureError::from)
    })
}

/// Recycle media by opaque IDs only. The worker re-resolves every file from
/// SQLite and emits per-file progress so the UI can show partial outcomes.
#[tauri::command]
pub async fn media_delete_items(
    library_id: String,
    media_item_ids: Vec<String>,
    app: AppHandle,
    state: State<'_, InfrastructureState>,
) -> Result<deletion::DeleteResultDto, AppError> {
    let (database_path, thumbnail_cache_dir) = state.with_infrastructure(|infrastructure| {
        ensure_library_ready(infrastructure, &library_id)?;
        let settings = infrastructure.settings()?;
        Ok((
            infrastructure.database_path(),
            PathBuf::from(settings.thumbnail_cache_dir),
        ))
    })?;
    tauri::async_runtime::spawn_blocking(move || {
        let repository = db::Repository::open(database_path).map_err(AppError::from)?;
        deletion::delete_to_recycle_bin(
            &repository,
            &library_id,
            &media_item_ids,
            thumbnail_cache_dir.as_path(),
            |progress| {
                let _ = app.emit("delete-progress", progress.clone());
            },
        )
    })
    .await
    .map_err(|error| AppError::internal(format!("删除任务异常结束: {error}")))?
}

/// Drop offline (`missing`) index rows for a library, e.g. segments whose
/// content now lives in a merged file. Only rows whose files are all gone
/// qualify, and the library must currently be available so an unplugged drive
/// cannot wipe a healthy index.
#[tauri::command]
pub fn media_purge_missing_items(
    library_id: String,
    state: State<'_, InfrastructureState>,
) -> Result<usize, AppError> {
    state.with_infrastructure(|infrastructure| {
        ensure_library_ready(infrastructure, &library_id)?;
        infrastructure
            .repository()
            .purge_missing_items(&library_id)
            .map_err(InfrastructureError::database)
    })
}

#[tauri::command]
pub async fn media_thumbnail(
    media_item_id: String,
    width: Option<u32>,
    app: AppHandle,
    state: State<'_, InfrastructureState>,
    streams: State<'_, MediaStreamRegistry>,
) -> Result<media::ThumbnailDto, AppError> {
    let (details, root, cache_dir) = state.with_infrastructure(|infrastructure| {
        let details = infrastructure
            .repository()
            .get_media_item_details(&media_item_id)
            .map_err(infrastructure::InfrastructureError::database)?
            .ok_or_else(|| {
                infrastructure::InfrastructureError::MediaMissing("媒体不存在".to_owned())
            })?;
        let library = infrastructure
            .repository()
            .get_library(&details.item.library_id)
            .map_err(infrastructure::InfrastructureError::database)?
            .ok_or_else(|| {
                infrastructure::InfrastructureError::InvalidPath("媒体库不存在".to_owned())
            })?;
        let settings = infrastructure.settings()?;
        Ok((
            details,
            PathBuf::from(library.root_path),
            PathBuf::from(settings.thumbnail_cache_dir),
        ))
    })?;
    let width = width.unwrap_or(320).clamp(96, 1600);
    let stream_root = cache_dir.clone();
    let mut thumbnail = tauri::async_runtime::spawn_blocking(move || {
        media::thumbnail_for_item(&details, &root, &cache_dir, width, Some(&app), None)
    })
    .await
    .map_err(|error| AppError::thumbnail(format!("缩略图任务异常退出: {error}")))??;
    let token = streams.register(
        thumbnail.cache_path.clone(),
        stream_root,
        "image/jpeg".to_owned(),
    );
    thumbnail.url = media::stream_url(&token);
    Ok(thumbnail)
}

#[tauri::command]
pub fn media_preview(
    media_item_id: String,
    state: State<'_, InfrastructureState>,
    streams: State<'_, MediaStreamRegistry>,
) -> Result<media::MediaPreviewDto, AppError> {
    state.with_infrastructure(|infrastructure| {
        let details = infrastructure
            .repository()
            .get_media_item_details(&media_item_id)
            .map_err(infrastructure::InfrastructureError::database)?
            .ok_or_else(|| {
                infrastructure::InfrastructureError::MediaMissing("媒体不存在".to_owned())
            })?;
        let library = infrastructure
            .repository()
            .get_library(&details.item.library_id)
            .map_err(infrastructure::InfrastructureError::database)?
            .ok_or_else(|| {
                infrastructure::InfrastructureError::InvalidPath("媒体库不存在".to_owned())
            })?;
        media::preview_sources(
            &details,
            PathBuf::from(&library.root_path).as_path(),
            &streams,
        )
        .map_err(InfrastructureError::from)
    })
}

#[tauri::command]
pub fn thumbnail_rebuild_start(
    library_id: String,
    app: AppHandle,
    infrastructure: State<'_, InfrastructureState>,
    jobs: State<'_, PreviewJobManagerState>,
) -> Result<media::PreviewJobStartDto, AppError> {
    let (database_path, root, cache_dir, exists) = infrastructure.with_infrastructure(|value| {
        ensure_library_ready(value, &library_id)?;
        let settings = value.settings()?;
        let library = value
            .repository()
            .get_library(&library_id)
            .map_err(infrastructure::InfrastructureError::database)?;
        Ok((
            value.database_path(),
            library.as_ref().map(|item| item.root_path.clone()),
            settings.thumbnail_cache_dir,
            library.is_some(),
        ))
    })?;
    if !exists {
        return Err(AppError::invalid_argument("媒体库不存在"));
    }
    let root = PathBuf::from(root.ok_or_else(|| AppError::invalid_argument("媒体库不存在"))?);
    let (job_id, cancel) = jobs.start()?;
    let manager = jobs.shared();
    let job_for_thread = job_id.clone();
    std::thread::spawn(move || {
        match db::Repository::open(&database_path) {
            Ok(repository) => media::run_thumbnail_job(
                &app,
                &repository,
                &root,
                PathBuf::from(cache_dir).as_path(),
                &library_id,
                &job_for_thread,
                &cancel,
            ),
            Err(error) => {
                let _ = app.emit(
                    "preview-progress",
                    media::PreviewProgress {
                        job_id: job_for_thread.clone(),
                        kind: "thumbnail",
                        seq: u64::MAX,
                        phase: "finalizing",
                        state: "failed",
                        current: None,
                        processed: 0,
                        total: 0,
                        errors: vec![error.to_string()],
                        error: Some(error.to_string()),
                    },
                );
            }
        }
        manager.finish(&job_for_thread);
    });
    Ok(media::PreviewJobStartDto { job_id: job_id })
}

#[tauri::command]
pub fn preview_job_cancel(
    job_id: String,
    jobs: State<'_, PreviewJobManagerState>,
) -> Result<(), AppError> {
    jobs.cancel(&job_id)
}

/// Start an incremental scan. The worker reads the root path from the
/// `libraries` table, not from frontend input or a compiled-in drive letter.
/// `full` forces reprocessing of every file (size/mtime shortcuts ignored).
#[tauri::command]
pub fn library_scan_start(
    library_id: String,
    full: Option<bool>,
    app: AppHandle,
    infrastructure: State<'_, InfrastructureState>,
    jobs: State<'_, ScanManagerState>,
) -> Result<ScanStartResponse, AppError> {
    let (database_path, exists) = infrastructure.with_infrastructure(|value| {
        ensure_library_ready(value, &library_id)?;
        Ok((value.database_path(), value.has_library(&library_id)?))
    })?;
    if !exists {
        return Err(AppError::invalid_argument("媒体库不存在"));
    }
    let (job_id, cancel) = jobs.start(&library_id).map_err(AppError::from)?;
    let manager = jobs.inner().clone();
    let scan_run_id = format!("run-{job_id}");
    scanner::spawn_scan(
        app,
        Arc::new(manager),
        database_path,
        library_id,
        job_id.clone(),
        cancel,
        full.unwrap_or(false),
    );
    Ok(ScanStartResponse {
        job_id,
        scan_run_id,
    })
}

#[tauri::command]
pub fn library_scan_cancel(
    job_id: String,
    jobs: State<'_, ScanManagerState>,
) -> Result<(), AppError> {
    jobs.cancel(&job_id)
}
