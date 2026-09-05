pub mod db;
mod infrastructure;
mod scanner;

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use db::{MediaKind, MediaQuery, MediaSort};
use infrastructure::{AppSettings, Infrastructure, InfrastructureState, LibraryStatus};
use scanner::{ScanManagerState, ScanStartResponse};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{AppHandle, Manager, State};

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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct MediaAssetDto {
    mime_type: String,
    data_base64: String,
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
            .ok_or_else(|| infrastructure::InfrastructureError::InvalidPath("媒体不存在".to_owned()))
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
fn media_asset(
    media_item_id: String,
    state: State<'_, InfrastructureState>,
) -> Result<MediaAssetDto, String> {
    state.with_infrastructure(|infrastructure| {
        let details = infrastructure
            .repository()
            .get_media_item_details(&media_item_id)
            .map_err(infrastructure::InfrastructureError::database)?
            .ok_or_else(|| infrastructure::InfrastructureError::InvalidPath("媒体不存在".to_owned()))?;
        let file = details
            .files
            .iter()
            .find(|file| file.exists_now)
            .ok_or_else(|| infrastructure::InfrastructureError::InvalidPath("媒体文件不可用".to_owned()))?;
        let library = infrastructure
            .repository()
            .get_library(&details.item.library_id)
            .map_err(infrastructure::InfrastructureError::database)?
            .ok_or_else(|| infrastructure::InfrastructureError::InvalidPath("媒体库不存在".to_owned()))?;
        let root = fs::canonicalize(&library.root_path)
            .map_err(|error| infrastructure::InfrastructureError::InvalidPath(format!("媒体库不可用: {error}")))?;
        let candidate = root.join(PathBuf::from(&file.relative_path));
        let path = fs::canonicalize(&candidate)
            .map_err(|error| infrastructure::InfrastructureError::InvalidPath(format!("媒体文件不可用: {error}")))?;
        if !path.starts_with(&root) {
            return Err(infrastructure::InfrastructureError::InvalidPath("媒体路径越界".to_owned()));
        }
        let bytes = fs::read(&path)
            .map_err(|error| infrastructure::InfrastructureError::InvalidPath(format!("读取媒体失败: {error}")))?;
        Ok(MediaAssetDto {
            mime_type: mime_for_extension(&file.extension).to_owned(),
            data_base64: BASE64.encode(bytes),
        })
    })
}

fn mime_for_extension(extension: &str) -> &'static str {
    match extension.to_ascii_lowercase().as_str() {
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "heic" => "image/heic",
        "heif" => "image/heif",
        "mp4" => "video/mp4",
        "mov" => "video/quicktime",
        "m4v" => "video/x-m4v",
        "webm" => "video/webm",
        _ => "application/octet-stream",
    }
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
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
            Ok(())
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
            media_asset,
            library_scan_start,
            library_scan_cancel
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
