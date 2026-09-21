mod backup;
pub mod db;
mod deletion;
mod errors;
mod infrastructure;
mod media;
mod scanner;
mod system;

use backup::{
    BackupManagerState, BackupPreviewDto, BackupPreviewRequest, BackupStartResponse,
    BackupVolumeDto,
};
use db::{MediaKind, MediaQuery, MediaSort};
use errors::AppError;
use infrastructure::{
    AppSettings, CloseBehavior, Infrastructure, InfrastructureError, InfrastructureState,
    LibraryAvailability, LibraryStatus,
};
use media::{MediaStreamRegistry, PreviewJobManagerState};
use scanner::{ScanManagerState, ScanStartResponse};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, State};

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

/// Return the persisted application settings and the current library status.
#[tauri::command]
fn get_app_settings(state: State<'_, InfrastructureState>) -> Result<AppSettings, AppError> {
    state.with_infrastructure(|infrastructure| infrastructure.settings())
}

/// Register a media-library root. The command accepts a path from the folder picker,
/// but the backend stores and returns only its canonical form.
#[tauri::command]
fn set_library_root(
    path: String,
    state: State<'_, InfrastructureState>,
) -> Result<LibraryStatus, AppError> {
    state.with_infrastructure(|infrastructure| infrastructure.set_library_root(PathBuf::from(path)))
}

/// Set the thumbnail cache directory. The directory is created when necessary and
/// the canonical path is persisted.
#[tauri::command]
fn set_thumbnail_cache_dir(
    path: String,
    state: State<'_, InfrastructureState>,
) -> Result<AppSettings, AppError> {
    state.with_infrastructure(|infrastructure| {
        infrastructure.set_thumbnail_cache_dir(PathBuf::from(path))
    })
}

#[tauri::command]
fn set_backup_conflict_policy(
    policy: db::ConflictPolicy,
    state: State<'_, InfrastructureState>,
) -> Result<AppSettings, AppError> {
    state.with_infrastructure(|infrastructure| infrastructure.set_backup_conflict_policy(policy))
}

/// Persist grid density, sort, and default preview mode across launches.
#[tauri::command]
fn set_ui_prefs(
    ui_density: Option<u8>,
    ui_sort: Option<String>,
    ui_preview_mode: Option<String>,
    state: State<'_, InfrastructureState>,
) -> Result<AppSettings, AppError> {
    let sort = match ui_sort.as_deref() {
        Some(value) => Some(infrastructure::UiSort::parse(value).map_err(AppError::from)?),
        None => None,
    };
    let preview_mode = match ui_preview_mode.as_deref() {
        Some(value) => Some(infrastructure::UiPreviewMode::parse(value).map_err(AppError::from)?),
        None => None,
    };
    state.with_infrastructure(|infrastructure| {
        infrastructure.set_ui_prefs(ui_density, sort, preview_mode)
    })
}

/// Toggle the startup incremental scan. Default is enabled.
#[tauri::command]
fn set_auto_scan_on_startup(
    enabled: bool,
    state: State<'_, InfrastructureState>,
) -> Result<AppSettings, AppError> {
    state.with_infrastructure(|infrastructure| infrastructure.set_auto_scan_on_startup(enabled))
}

/// Toggle system notifications for scan/backup/disk events.
#[tauri::command]
fn set_notifications_enabled(
    enabled: bool,
    state: State<'_, InfrastructureState>,
) -> Result<AppSettings, AppError> {
    state.with_infrastructure(|infrastructure| infrastructure.set_notifications_enabled(enabled))
}

/// Persist the window close behavior (quit vs minimize to tray).
#[tauri::command]
fn set_close_behavior(
    behavior: String,
    state: State<'_, InfrastructureState>,
) -> Result<AppSettings, AppError> {
    let behavior = CloseBehavior::parse(&behavior).map_err(AppError::from)?;
    state.with_infrastructure(|infrastructure| infrastructure.set_close_behavior(behavior))
}

/// Persist backup ignore extensions used as the single default source for
/// the settings panel and backup preview.
#[tauri::command]
fn set_backup_ignore_extensions(
    extensions: Vec<String>,
    state: State<'_, InfrastructureState>,
) -> Result<AppSettings, AppError> {
    state.with_infrastructure(|infrastructure| {
        infrastructure.set_backup_ignore_extensions(extensions)
    })
}

/// Recent scan_runs rows for the settings index summary.
#[tauri::command]
fn list_scan_runs(
    library_id: String,
    limit: Option<i64>,
    state: State<'_, InfrastructureState>,
) -> Result<Vec<db::ScanRun>, AppError> {
    state.with_infrastructure(|infrastructure| {
        infrastructure
            .repository()
            .list_scan_runs(&library_id, limit.unwrap_or(8))
            .map_err(infrastructure::InfrastructureError::database)
    })
}

/// Aggregate counters for the media-library status card.
#[tauri::command]
fn library_index_summary(
    library_id: String,
    state: State<'_, InfrastructureState>,
) -> Result<db::LibraryIndexSummary, AppError> {
    state.with_infrastructure(|infrastructure| {
        infrastructure
            .repository()
            .library_index_summary(&library_id)
            .map_err(infrastructure::InfrastructureError::database)
    })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct FfmpegStatusDto {
    available: bool,
    path: Option<String>,
    message: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ThumbnailCacheStatsDto {
    path: String,
    file_count: u64,
    total_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AppAboutDto {
    version: String,
    app_data_dir: String,
    app_cache_dir: String,
    database_path: String,
    settings_path: String,
    thumbnail_cache_dir: String,
    ffmpeg: FfmpegStatusDto,
}

/// Version, directories, and ffmpeg detection for the About panel.
#[tauri::command]
fn get_app_about(
    app: AppHandle,
    state: State<'_, InfrastructureState>,
) -> Result<AppAboutDto, AppError> {
    let (app_data_dir, app_cache_dir, database_path, settings_path, thumbnail_cache_dir) = state
        .with_infrastructure(|infrastructure| {
            let settings = infrastructure.settings()?;
            Ok((
                infrastructure.app_data_dir(),
                infrastructure.app_cache_dir(),
                infrastructure.database_path(),
                infrastructure.settings_path(),
                PathBuf::from(settings.thumbnail_cache_dir),
            ))
        })?;
    let ffmpeg = match media::resolve_ffmpeg(&app) {
        Ok(path) => FfmpegStatusDto {
            available: true,
            path: Some(path.to_string_lossy().into_owned()),
            message: None,
        },
        Err(error) => FfmpegStatusDto {
            available: false,
            path: None,
            message: Some(error.to_string()),
        },
    };
    Ok(AppAboutDto {
        version: env!("CARGO_PKG_VERSION").to_owned(),
        app_data_dir: app_data_dir.to_string_lossy().into_owned(),
        app_cache_dir: app_cache_dir.to_string_lossy().into_owned(),
        database_path: database_path.to_string_lossy().into_owned(),
        settings_path: settings_path.to_string_lossy().into_owned(),
        thumbnail_cache_dir: thumbnail_cache_dir.to_string_lossy().into_owned(),
        ffmpeg,
    })
}

#[tauri::command]
fn get_thumbnail_cache_stats(
    state: State<'_, InfrastructureState>,
) -> Result<ThumbnailCacheStatsDto, AppError> {
    state.with_infrastructure(|infrastructure| {
        let stats = infrastructure.thumbnail_cache_stats()?;
        Ok(ThumbnailCacheStatsDto {
            path: stats.path,
            file_count: stats.file_count,
            total_bytes: stats.total_bytes,
        })
    })
}

/// Open a directory in Explorer. Accepts only well-known app-owned locations.
#[tauri::command]
fn open_app_directory(
    which: String,
    state: State<'_, InfrastructureState>,
) -> Result<(), AppError> {
    let path = state.with_infrastructure(|infrastructure| {
        let settings = infrastructure.settings()?;
        Ok(match which.as_str() {
            "app_data" => infrastructure.app_data_dir(),
            "app_cache" => infrastructure.app_cache_dir(),
            "thumbnail_cache" => PathBuf::from(settings.thumbnail_cache_dir),
            "library" => {
                PathBuf::from(infrastructure.library_status()?.root_path.ok_or_else(|| {
                    infrastructure::InfrastructureError::InvalidPath("尚未配置媒体库".to_owned())
                })?)
            }
            other => {
                return Err(infrastructure::InfrastructureError::InvalidPath(format!(
                    "不支持的目录类型: {other}"
                )))
            }
        })
    })?;
    if !path.exists() {
        return Err(AppError::invalid_argument(format!(
            "目录不存在: {}",
            path.display()
        )));
    }
    tauri_plugin_opener::open_path(&path, None::<&str>)
        .map_err(|error| AppError::io(format!("打开目录失败: {error}")))
}

/// Re-check the library root and its recorded volume identity.
#[tauri::command]
fn get_library_status(state: State<'_, InfrastructureState>) -> Result<LibraryStatus, AppError> {
    state.with_infrastructure(|infrastructure| infrastructure.library_status())
}

/// Block dangerous filesystem work while the library volume is unavailable.
fn ensure_library_ready(
    infrastructure: &mut Infrastructure,
    library_id: &str,
) -> Result<(), InfrastructureError> {
    let exists = infrastructure.has_library(library_id)?;
    if !exists {
        return Err(InfrastructureError::InvalidPath("媒体库不存在".to_owned()));
    }
    let status = infrastructure.library_status()?;
    match status.availability {
        LibraryAvailability::Available => Ok(()),
        LibraryAvailability::Unconfigured => Err(InfrastructureError::InvalidPath(
            "尚未配置媒体库".to_owned(),
        )),
        LibraryAvailability::Disconnected => Err(InfrastructureError::LibraryOffline(
            status
                .reason
                .unwrap_or_else(|| "媒体库已断开，请连接磁盘后重试".to_owned()),
        )),
        LibraryAvailability::Invalid => Err(InfrastructureError::VolumeChanged(
            status
                .reason
                .unwrap_or_else(|| "媒体库卷与记录不一致，请重新选择媒体库目录".to_owned()),
        )),
    }
}

/// Convenience DTO for bootstrapping the frontend in one invocation.
#[tauri::command]
fn get_infrastructure_state(
    state: State<'_, InfrastructureState>,
) -> Result<infrastructure::InfrastructureStateDto, AppError> {
    state.with_infrastructure(|infrastructure| infrastructure.state())
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MediaQueryInput {
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
fn library_list(state: State<'_, InfrastructureState>) -> Result<Vec<db::Library>, AppError> {
    state.with_infrastructure(|infrastructure| {
        infrastructure
            .repository()
            .list_libraries()
            .map_err(infrastructure::InfrastructureError::database)
    })
}

#[tauri::command]
fn media_query(
    query: MediaQueryInput,
    state: State<'_, InfrastructureState>,
) -> Result<db::MediaPage, AppError> {
    let sort = match query.sort.as_deref() {
        Some("oldest") => MediaSort::Oldest,
        Some("name") => MediaSort::Name,
        Some("rating-desc") => MediaSort::RatingDesc,
        Some("rating-asc") => MediaSort::RatingAsc,
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
fn media_date_facets(
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
fn media_get(
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
fn media_open_folder(
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
fn favorite_set(
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
fn favorite_set_batch(
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

fn now_unix_ms() -> String {
    format!(
        "unix-ms:{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
    )
}

#[tauri::command]
fn tag_list(state: State<'_, InfrastructureState>) -> Result<Vec<db::Tag>, AppError> {
    state.with_infrastructure(|infrastructure| {
        infrastructure
            .repository()
            .list_tags()
            .map_err(infrastructure::InfrastructureError::database)
    })
}

#[tauri::command]
fn tag_create(
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
fn tag_find_or_create(
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
fn tag_update(
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
fn tag_delete(tag_id: String, state: State<'_, InfrastructureState>) -> Result<(), AppError> {
    state.with_infrastructure(|infrastructure| {
        infrastructure
            .repository()
            .delete_tag(&tag_id)
            .map_err(infrastructure::InfrastructureError::database)
    })
}

#[tauri::command]
fn tag_attach(
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
fn tag_detach(
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
fn tag_attach_batch(
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
fn tag_detach_batch(
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
fn rating_set(
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
fn rating_set_batch(
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
fn media_delete_preview(
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
async fn media_delete_items(
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

#[tauri::command]
async fn media_thumbnail(
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
fn media_preview(
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
fn thumbnail_rebuild_start(
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
fn preview_job_cancel(
    job_id: String,
    jobs: State<'_, PreviewJobManagerState>,
) -> Result<(), AppError> {
    jobs.cancel(&job_id)
}

/// Start an incremental scan. The worker reads the root path from the
/// `libraries` table, not from frontend input or a compiled-in drive letter.
/// `full` forces reprocessing of every file (size/mtime shortcuts ignored).
#[tauri::command]
fn library_scan_start(
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
fn library_scan_cancel(job_id: String, jobs: State<'_, ScanManagerState>) -> Result<(), AppError> {
    jobs.cancel(&job_id)
}

/// Discover removable volumes with a direct DCIM directory. The result is
/// only a list of candidates; no camera file is opened or changed here.
#[tauri::command]
fn backup_sources_discover() -> Result<Vec<BackupVolumeDto>, AppError> {
    Ok(backup::discover_volumes())
}

/// Build and persist a read-only backup preview. Copying is a separate command
/// and requires the preview confirmation token. Conflict policy and default
/// ignore extensions come from app settings when the request omits them.
#[tauri::command]
async fn backup_preview(
    request: BackupPreviewRequest,
    state: State<'_, InfrastructureState>,
) -> Result<BackupPreviewDto, AppError> {
    let (database_path, conflict_policy, default_ignore) =
        state.with_infrastructure(|infrastructure| {
            let settings = infrastructure.settings()?;
            Ok((
                infrastructure.database_path(),
                settings.backup_conflict_policy,
                settings.backup_ignore_extensions,
            ))
        })?;
    tauri::async_runtime::spawn_blocking(move || {
        let repository = db::Repository::open(database_path).map_err(AppError::from)?;
        let mut request = request;
        if request.conflict_policy.is_none() {
            request.conflict_policy = Some(conflict_policy);
        }
        if request.ignore_extensions.is_none() {
            request.ignore_extensions = Some(default_ignore);
        }
        backup::preview(&repository, request).map_err(AppError::from)
    })
    .await
    .map_err(|error| AppError::internal(format!("备份预览任务异常结束: {error}")))?
}

/// Execute only the exact persisted preview that the user confirmed.
#[tauri::command]
fn backup_start(
    preview_id: String,
    confirmation_token: String,
    app: AppHandle,
    infrastructure: State<'_, InfrastructureState>,
    backups: State<'_, BackupManagerState>,
    scans: State<'_, ScanManagerState>,
) -> Result<BackupStartResponse, AppError> {
    let database_path = infrastructure.with_infrastructure(|value| {
        let run = value
            .repository()
            .get_backup_run(&preview_id)
            .map_err(infrastructure::InfrastructureError::database)?
            .ok_or_else(|| {
                infrastructure::InfrastructureError::InvalidPath("备份预览不存在".to_owned())
            })?;
        if !matches!(run.status, db::BackupStatus::Preview) || confirmation_token != run.job_id {
            return Err(infrastructure::InfrastructureError::InvalidPath(
                "备份预览未确认，或已失效，请重新生成预览".to_owned(),
            ));
        }
        Ok(value.database_path())
    })?;
    let (job_id, cancel) = backups.start()?;
    let backup_run_id = preview_id.clone();
    backup::spawn(
        app,
        Arc::new(backups.inner().clone()),
        Arc::new(scans.inner().clone()),
        database_path,
        backup_run_id.clone(),
        job_id.clone(),
        cancel,
        None,
    );
    Ok(BackupStartResponse {
        job_id,
        backup_run_id,
    })
}

#[tauri::command]
fn backup_retry_failed(
    backup_run_id: String,
    item_ids: Option<Vec<String>>,
    app: AppHandle,
    infrastructure: State<'_, InfrastructureState>,
    backups: State<'_, BackupManagerState>,
    scans: State<'_, ScanManagerState>,
) -> Result<BackupStartResponse, AppError> {
    let database_path = infrastructure.with_infrastructure(|value| {
        let run = value
            .repository()
            .get_backup_run(&backup_run_id)
            .map_err(infrastructure::InfrastructureError::database)?
            .ok_or_else(|| {
                infrastructure::InfrastructureError::InvalidPath("备份任务不存在".to_owned())
            })?;
        if !matches!(
            run.status,
            db::BackupStatus::Failed | db::BackupStatus::Cancelled
        ) {
            return Err(infrastructure::InfrastructureError::InvalidPath(
                "只有失败或取消的备份任务可以重试".to_owned(),
            ));
        }
        Ok(value.database_path())
    })?;
    let repository = db::Repository::open(&database_path).map_err(AppError::from)?;
    // Cancelled runs keep unfinished work as `cancelled`; allow retrying those
    // too so a partial cancel can resume without a fresh preview of copied files.
    let retryable = repository
        .list_backup_items(&backup_run_id)
        .map_err(AppError::from)?
        .into_iter()
        .filter(|item| item.status == "failed" || item.status == "cancelled")
        .map(|item| item.id)
        .collect::<std::collections::HashSet<_>>();
    let selected = item_ids.unwrap_or_else(|| retryable.iter().cloned().collect());
    if selected.is_empty() || selected.iter().any(|id| !retryable.contains(id)) {
        return Err(AppError::invalid_argument("没有可重试的失败文件"));
    }
    let (job_id, cancel) = backups.start()?;
    backup::spawn(
        app,
        Arc::new(backups.inner().clone()),
        Arc::new(scans.inner().clone()),
        database_path,
        backup_run_id.clone(),
        job_id.clone(),
        cancel,
        Some(selected),
    );
    Ok(BackupStartResponse {
        job_id,
        backup_run_id,
    })
}

#[tauri::command]
fn backup_cancel(job_id: String, backups: State<'_, BackupManagerState>) -> Result<(), AppError> {
    backups.cancel(&job_id)
}

/// Recent backup attempts (completed / failed / cancelled), newest first.
#[tauri::command]
fn backup_history(
    limit: Option<i64>,
    state: State<'_, InfrastructureState>,
) -> Result<Vec<db::BackupRun>, AppError> {
    state.with_infrastructure(|infrastructure| {
        infrastructure
            .repository()
            .list_backup_runs(limit.unwrap_or(8))
            .map_err(infrastructure::InfrastructureError::database)
    })
}

/// Item-level detail for one backup run; used by the retry / history UI.
#[tauri::command]
fn backup_run_items(
    backup_run_id: String,
    only_retryable: Option<bool>,
    state: State<'_, InfrastructureState>,
) -> Result<Vec<db::BackupItem>, AppError> {
    state.with_infrastructure(|infrastructure| {
        let items = infrastructure
            .repository()
            .list_backup_items(&backup_run_id)
            .map_err(infrastructure::InfrastructureError::database)?;
        Ok(if only_retryable.unwrap_or(false) {
            items
                .into_iter()
                .filter(|item| item.status == "failed" || item.status == "cancelled")
                .collect()
        } else {
            items
        })
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let streams = MediaStreamRegistry::default();
    let protocol_streams = streams.clone();
    tauri::Builder::default()
        // Must register first: a second launch focuses the existing window.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            system::show_main_window(app);
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .setup(move |app| {
            let app_data_dir = app.path().app_data_dir()?;
            let app_cache_dir = app.path().app_cache_dir()?;
            let settings_path = app_data_dir.join("settings.json");
            let default_thumbnail_cache_dir = app_cache_dir.join("thumbnails");

            let database_path = app_data_dir.join("camlib.sqlite3");
            let infrastructure = Infrastructure::open_with_database(
                settings_path,
                default_thumbnail_cache_dir,
                database_path,
            )
            .map_err(|error| -> Box<dyn std::error::Error> { error.into() })?;

            // Orphaned running rows from a previous process are shown as
            // interrupted failures; this build does not resume jobs.
            {
                let repository = infrastructure.repository();
                let now = system::timestamp_now();
                let _ = repository.fail_interrupted_scan_runs(&now);
                let _ = repository.fail_interrupted_backup_runs(&now);
            }

            app.manage(InfrastructureState::new(infrastructure));
            app.manage(ScanManagerState::new());
            app.manage(BackupManagerState::new());
            app.manage(PreviewJobManagerState::new());
            app.manage(streams.clone());

            if let Some(window) = app.get_webview_window("main") {
                system::install_close_handler(&window, app.handle().clone());
            }
            system::setup_tray(app.handle());
            system::spawn_volume_watch(app.handle().clone());
            Ok(())
        })
        .register_uri_scheme_protocol("camlib", move |_context, request| {
            media::serve_stream(&protocol_streams, request)
        })
        .invoke_handler(tauri::generate_handler![
            greet,
            get_app_settings,
            set_library_root,
            set_thumbnail_cache_dir,
            set_backup_conflict_policy,
            set_backup_ignore_extensions,
            set_ui_prefs,
            set_auto_scan_on_startup,
            set_notifications_enabled,
            set_close_behavior,
            get_library_status,
            get_infrastructure_state,
            list_scan_runs,
            library_index_summary,
            get_app_about,
            get_thumbnail_cache_stats,
            open_app_directory,
            library_list,
            media_query,
            media_date_facets,
            media_get,
            media_open_folder,
            favorite_set,
            favorite_set_batch,
            tag_list,
            tag_create,
            tag_find_or_create,
            tag_update,
            tag_delete,
            tag_attach,
            tag_detach,
            tag_attach_batch,
            tag_detach_batch,
            rating_set,
            rating_set_batch,
            media_delete_preview,
            media_delete_items,
            media_thumbnail,
            media_preview,
            thumbnail_rebuild_start,
            preview_job_cancel,
            library_scan_start,
            library_scan_cancel,
            backup_sources_discover,
            backup_preview,
            backup_start,
            backup_retry_failed,
            backup_cancel,
            backup_history,
            backup_run_items
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
