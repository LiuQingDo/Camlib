mod backup;
pub mod db;
mod deletion;
mod infrastructure;
mod media;
mod scanner;

use backup::{BackupPreviewDto, BackupPreviewRequest, BackupVolumeDto};
use db::{MediaKind, MediaQuery, MediaSort};
use infrastructure::{AppSettings, Infrastructure, InfrastructureState, LibraryStatus};
use media::{MediaStreamRegistry, PreviewJobManagerState};
use scanner::{ScanManagerState, ScanStartResponse};
use serde::Deserialize;
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
fn get_app_settings(state: State<'_, InfrastructureState>) -> Result<AppSettings, String> {
    state.with_infrastructure(|infrastructure| infrastructure.settings())
}

/// Register a media-library root. The command accepts a path from the folder picker,
/// but the backend stores and returns only its canonical form.
#[tauri::command]
fn set_library_root(
    path: String,
    state: State<'_, InfrastructureState>,
) -> Result<LibraryStatus, String> {
    state.with_infrastructure(|infrastructure| infrastructure.set_library_root(PathBuf::from(path)))
}

/// Set the thumbnail cache directory. The directory is created when necessary and
/// the canonical path is persisted.
#[tauri::command]
fn set_thumbnail_cache_dir(
    path: String,
    state: State<'_, InfrastructureState>,
) -> Result<AppSettings, String> {
    state.with_infrastructure(|infrastructure| {
        infrastructure.set_thumbnail_cache_dir(PathBuf::from(path))
    })
}

/// Re-check the library root and its recorded volume identity.
#[tauri::command]
fn get_library_status(state: State<'_, InfrastructureState>) -> Result<LibraryStatus, String> {
    state.with_infrastructure(|infrastructure| infrastructure.library_status())
}

/// Convenience DTO for bootstrapping the frontend in one invocation.
#[tauri::command]
fn get_infrastructure_state(
    state: State<'_, InfrastructureState>,
) -> Result<infrastructure::InfrastructureStateDto, String> {
    state.with_infrastructure(|infrastructure| infrastructure.state())
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MediaQueryInput {
    library_id: String,
    kind: Option<MediaKind>,
    favorite_only: Option<bool>,
    search: Option<String>,
    date_prefix: Option<String>,
    offset: Option<i64>,
    limit: Option<i64>,
    sort: Option<String>,
}

#[tauri::command]
fn library_list(state: State<'_, InfrastructureState>) -> Result<Vec<db::Library>, String> {
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
) -> Result<db::MediaPage, String> {
    let sort = match query.sort.as_deref() {
        Some("oldest") => MediaSort::Oldest,
        Some("name") => MediaSort::Name,
        _ => MediaSort::Newest,
    };
    state.with_infrastructure(|infrastructure| {
        infrastructure
            .repository()
            .query_media(MediaQuery {
                library_id: query.library_id,
                kind: query.kind,
                favorite_only: query.favorite_only.unwrap_or(false),
                search: query.search,
                date_prefix: query.date_prefix,
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
) -> Result<Vec<db::DateFacet>, String> {
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
) -> Result<db::MediaItemDetails, String> {
    state.with_infrastructure(|infrastructure| {
        infrastructure
            .repository()
            .get_media_item_details(&media_item_id)
            .map_err(infrastructure::InfrastructureError::database)?
            .ok_or_else(|| {
                infrastructure::InfrastructureError::InvalidPath("媒体不存在".to_owned())
            })
    })
}

#[tauri::command]
fn favorite_set(
    media_item_id: String,
    favorite: bool,
    state: State<'_, InfrastructureState>,
) -> Result<(), String> {
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
fn media_delete_preview(
    library_id: String,
    media_item_ids: Vec<String>,
    state: State<'_, InfrastructureState>,
) -> Result<deletion::DeletePreviewDto, String> {
    state.with_infrastructure(|infrastructure| {
        deletion::preview(infrastructure.repository(), &library_id, &media_item_ids)
            .map_err(infrastructure::InfrastructureError::InvalidPath)
    })
}

#[tauri::command]
fn media_delete_items(
    library_id: String,
    media_item_ids: Vec<String>,
    state: State<'_, InfrastructureState>,
) -> Result<deletion::DeleteResultDto, String> {
    state.with_infrastructure(|infrastructure| {
        let settings = infrastructure.settings()?;
        deletion::delete_to_recycle_bin(
            infrastructure.repository(),
            &library_id,
            &media_item_ids,
            PathBuf::from(settings.thumbnail_cache_dir).as_path(),
        )
        .map_err(infrastructure::InfrastructureError::InvalidPath)
    })
}

#[tauri::command]
fn media_thumbnail(
    media_item_id: String,
    width: Option<u32>,
    app: AppHandle,
    state: State<'_, InfrastructureState>,
) -> Result<media::ThumbnailDto, String> {
    state.with_infrastructure(|infrastructure| {
        let details = infrastructure
            .repository()
            .get_media_item_details(&media_item_id)
            .map_err(infrastructure::InfrastructureError::database)?
            .ok_or_else(|| {
                infrastructure::InfrastructureError::InvalidPath("媒体不存在".to_owned())
            })?;
        let library = infrastructure
            .repository()
            .get_library(&details.item.library_id)
            .map_err(infrastructure::InfrastructureError::database)?
            .ok_or_else(|| {
                infrastructure::InfrastructureError::InvalidPath("媒体库不存在".to_owned())
            })?;
        let settings = infrastructure.settings()?;
        media::thumbnail_for_item(
            &details,
            PathBuf::from(&library.root_path).as_path(),
            PathBuf::from(&settings.thumbnail_cache_dir).as_path(),
            width.unwrap_or(320).clamp(96, 1600),
            Some(&app),
            None,
        )
        .map_err(infrastructure::InfrastructureError::InvalidPath)
    })
}

#[tauri::command]
fn media_preview(
    media_item_id: String,
    state: State<'_, InfrastructureState>,
    streams: State<'_, MediaStreamRegistry>,
) -> Result<media::MediaPreviewDto, String> {
    state.with_infrastructure(|infrastructure| {
        let details = infrastructure
            .repository()
            .get_media_item_details(&media_item_id)
            .map_err(infrastructure::InfrastructureError::database)?
            .ok_or_else(|| {
                infrastructure::InfrastructureError::InvalidPath("媒体不存在".to_owned())
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
        .map_err(infrastructure::InfrastructureError::InvalidPath)
    })
}

#[tauri::command]
fn thumbnail_rebuild_start(
    library_id: String,
    app: AppHandle,
    infrastructure: State<'_, InfrastructureState>,
    jobs: State<'_, PreviewJobManagerState>,
) -> Result<media::PreviewJobStartDto, String> {
    let (database_path, root, cache_dir, exists) = infrastructure.with_infrastructure(|value| {
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
        return Err("媒体库不存在".to_owned());
    }
    let root = PathBuf::from(root.ok_or_else(|| "媒体库不存在".to_owned())?);
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
) -> Result<(), String> {
    jobs.cancel(&job_id)
}

/// Start an incremental scan. The worker reads the root path from the
/// `libraries` table, not from frontend input or a compiled-in drive letter.
#[tauri::command]
fn library_scan_start(
    library_id: String,
    app: AppHandle,
    infrastructure: State<'_, InfrastructureState>,
    jobs: State<'_, ScanManagerState>,
) -> Result<ScanStartResponse, String> {
    let (database_path, exists) = infrastructure.with_infrastructure(|value| {
        Ok((value.database_path(), value.has_library(&library_id)?))
    })?;
    if !exists {
        return Err("媒体库不存在".to_owned());
    }
    let (job_id, cancel) = jobs.start(&library_id)?;
    let manager = jobs.inner().clone();
    let scan_run_id = format!("run-{job_id}");
    scanner::spawn_scan(
        app,
        Arc::new(manager),
        database_path,
        library_id,
        job_id.clone(),
        cancel,
    );
    Ok(ScanStartResponse {
        job_id,
        scan_run_id,
    })
}

#[tauri::command]
fn library_scan_cancel(job_id: String, jobs: State<'_, ScanManagerState>) -> Result<(), String> {
    jobs.cancel(&job_id)
}

/// Discover removable volumes with a direct DCIM directory. The result is
/// only a list of candidates; no camera file is opened or changed here.
#[tauri::command]
fn backup_sources_discover() -> Result<Vec<BackupVolumeDto>, String> {
    Ok(backup::discover_volumes())
}

/// Build and persist a read-only backup preview. This command intentionally
/// has no copy counterpart in this session.
#[tauri::command]
fn backup_preview(
    request: BackupPreviewRequest,
    state: State<'_, InfrastructureState>,
) -> Result<BackupPreviewDto, String> {
    state.with_infrastructure(|infrastructure| {
        backup::preview(infrastructure.repository(), request)
            .map_err(|error| infrastructure::InfrastructureError::InvalidPath(error.to_string()))
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let streams = MediaStreamRegistry::default();
    let protocol_streams = streams.clone();
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
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
            app.manage(InfrastructureState::new(infrastructure));
            app.manage(ScanManagerState::new());
            app.manage(PreviewJobManagerState::new());
            app.manage(streams.clone());
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
            get_library_status,
            get_infrastructure_state,
            library_list,
            media_query,
            media_date_facets,
            media_get,
            favorite_set,
            media_delete_preview,
            media_delete_items,
            media_thumbnail,
            media_preview,
            thumbnail_rebuild_start,
            preview_job_cancel,
            library_scan_start,
            library_scan_cancel,
            backup_sources_discover,
            backup_preview
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
