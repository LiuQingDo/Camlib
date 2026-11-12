//! Settings and library-status commands.

use crate::db;
use crate::errors::AppError;
use crate::infrastructure::{
    self, AppSettings, CloseBehavior, DialogSize, InfrastructureState, LibraryStatus, UiTheme,
};
use std::path::PathBuf;
use tauri::State;

/// Return the persisted application settings and the current library status.
#[tauri::command]
pub fn get_app_settings(state: State<'_, InfrastructureState>) -> Result<AppSettings, AppError> {
    state.with_infrastructure(|infrastructure| infrastructure.settings())
}

/// Register a media-library root. The command accepts a path from the folder picker,
/// but the backend stores and returns only its canonical form.
#[tauri::command]
pub fn set_library_root(
    path: String,
    state: State<'_, InfrastructureState>,
) -> Result<LibraryStatus, AppError> {
    state.with_infrastructure(|infrastructure| infrastructure.set_library_root(PathBuf::from(path)))
}

/// Set the thumbnail cache directory. The directory is created when necessary and
/// the canonical path is persisted.
#[tauri::command]
pub fn set_thumbnail_cache_dir(
    path: String,
    state: State<'_, InfrastructureState>,
) -> Result<AppSettings, AppError> {
    state.with_infrastructure(|infrastructure| {
        infrastructure.set_thumbnail_cache_dir(PathBuf::from(path))
    })
}

#[tauri::command]
pub fn set_backup_conflict_policy(
    policy: db::ConflictPolicy,
    state: State<'_, InfrastructureState>,
) -> Result<AppSettings, AppError> {
    state.with_infrastructure(|infrastructure| infrastructure.set_backup_conflict_policy(policy))
}

/// Persist grid density, sort, default preview mode, and theme across launches.
#[tauri::command]
pub fn set_ui_prefs(
    ui_density: Option<u8>,
    ui_sort: Option<String>,
    ui_preview_mode: Option<String>,
    ui_theme: Option<String>,
    ui_dialog_sizes: Option<std::collections::BTreeMap<String, DialogSize>>,
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
    let theme = match ui_theme.as_deref() {
        Some(value) => Some(UiTheme::parse(value).map_err(AppError::from)?),
        None => None,
    };
    state.with_infrastructure(|infrastructure| {
        infrastructure.set_ui_prefs(ui_density, sort, preview_mode, theme, ui_dialog_sizes)
    })
}

/// Toggle the startup incremental scan. Default is enabled.
#[tauri::command]
pub fn set_auto_scan_on_startup(
    enabled: bool,
    state: State<'_, InfrastructureState>,
) -> Result<AppSettings, AppError> {
    state.with_infrastructure(|infrastructure| infrastructure.set_auto_scan_on_startup(enabled))
}

/// Toggle system notifications for scan/backup/disk events.
#[tauri::command]
pub fn set_notifications_enabled(
    enabled: bool,
    state: State<'_, InfrastructureState>,
) -> Result<AppSettings, AppError> {
    state.with_infrastructure(|infrastructure| infrastructure.set_notifications_enabled(enabled))
}

/// Persist the window close behavior (quit vs minimize to tray).
#[tauri::command]
pub fn set_close_behavior(
    behavior: String,
    state: State<'_, InfrastructureState>,
) -> Result<AppSettings, AppError> {
    let behavior = CloseBehavior::parse(&behavior).map_err(AppError::from)?;
    state.with_infrastructure(|infrastructure| infrastructure.set_close_behavior(behavior))
}

/// Persist backup ignore extensions used as the single default source for
/// the settings panel and backup preview.
#[tauri::command]
pub fn set_backup_ignore_extensions(
    extensions: Vec<String>,
    state: State<'_, InfrastructureState>,
) -> Result<AppSettings, AppError> {
    state.with_infrastructure(|infrastructure| {
        infrastructure.set_backup_ignore_extensions(extensions)
    })
}

/// Toggle camera-split video segment merging during backup.
#[tauri::command]
pub fn set_backup_merge_segments(
    enabled: bool,
    state: State<'_, InfrastructureState>,
) -> Result<AppSettings, AppError> {
    state.with_infrastructure(|infrastructure| infrastructure.set_backup_merge_segments(enabled))
}

/// Recent scan_runs rows for the settings index summary.
#[tauri::command]
pub fn list_scan_runs(
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
pub fn library_index_summary(
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

/// Re-check the library root and its recorded volume identity.
#[tauri::command]
pub fn get_library_status(
    state: State<'_, InfrastructureState>,
) -> Result<LibraryStatus, AppError> {
    state.with_infrastructure(|infrastructure| infrastructure.library_status())
}

/// Convenience DTO for bootstrapping the frontend in one invocation.
#[tauri::command]
pub fn get_infrastructure_state(
    state: State<'_, InfrastructureState>,
) -> Result<infrastructure::InfrastructureStateDto, AppError> {
    state.with_infrastructure(|infrastructure| infrastructure.state())
}
