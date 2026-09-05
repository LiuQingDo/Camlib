mod infrastructure;

use infrastructure::{AppSettings, Infrastructure, InfrastructureState, LibraryStatus};
use std::path::PathBuf;
use tauri::{Manager, State};

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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let app_data_dir = app.path().app_data_dir()?;
            let app_cache_dir = app.path().app_cache_dir()?;
            let settings_path = app_data_dir.join("settings.json");
            let default_thumbnail_cache_dir = app_cache_dir.join("thumbnails");

            let infrastructure = Infrastructure::open(settings_path, default_thumbnail_cache_dir)
                .map_err(|error| -> Box<dyn std::error::Error> { error.into() })?;
            app.manage(InfrastructureState::new(infrastructure));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            greet,
            get_app_settings,
            set_library_root,
            set_thumbnail_cache_dir,
            get_library_status,
            get_infrastructure_state
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
