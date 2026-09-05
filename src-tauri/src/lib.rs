pub mod db;
mod infrastructure;
mod scanner;

use infrastructure::{AppSettings, Infrastructure, InfrastructureState, LibraryStatus};
use scanner::{ScanManagerState, ScanStartResponse};
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
            library_scan_start,
            library_scan_cancel
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
