mod ai;
mod backup;
mod commands;
pub mod db;
mod deletion;
mod editing;
mod errors;
mod infrastructure;
mod library_merge;
mod media;
mod scanner;
mod system;
mod video_merge;

use ai::AiJobManagerState;
use backup::BackupManagerState;
use infrastructure::{Infrastructure, InfrastructureState};
use media::{MediaStreamRegistry, PreviewJobManagerState};
use scanner::ScanManagerState;
use std::sync::atomic::AtomicBool;
use tauri::Manager;

/// Serializes the chat drawer: one in-flight stream at a time, plus a
/// cooperative cancel flag the stream loop checks between deltas.
#[derive(Default)]
struct AiChatState {
    busy: AtomicBool,
    cancel: AtomicBool,
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
            app.manage(library_merge::LibraryMergeManagerState::new());
            app.manage(editing::EditJobManagerState::new());
            app.manage(video_merge::VideoMergeManagerState::new());
            app.manage(PreviewJobManagerState::new());
            app.manage(AiJobManagerState::new());
            app.manage(AiChatState::default());
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
            commands::system::greet,
            commands::system::ffmpeg_available,
            commands::settings::get_app_settings,
            commands::settings::set_library_root,
            commands::settings::set_thumbnail_cache_dir,
            commands::settings::set_backup_conflict_policy,
            commands::settings::set_backup_ignore_extensions,
            commands::settings::set_backup_merge_segments,
            commands::settings::set_ui_prefs,
            commands::settings::set_auto_scan_on_startup,
            commands::settings::set_notifications_enabled,
            commands::settings::set_close_behavior,
            commands::settings::get_library_status,
            commands::settings::get_infrastructure_state,
            commands::settings::list_scan_runs,
            commands::settings::library_index_summary,
            commands::system::get_app_about,
            commands::system::get_thumbnail_cache_stats,
            commands::system::open_app_directory,
            commands::media::library_list,
            commands::media::media_query,
            commands::media::media_date_facets,
            commands::media::media_get,
            commands::media::media_open_folder,
            commands::media::favorite_set,
            commands::media::favorite_set_batch,
            commands::media::tag_list,
            commands::media::tag_create,
            commands::media::tag_find_or_create,
            commands::media::tag_update,
            commands::media::tag_delete,
            commands::media::tag_attach,
            commands::media::tag_detach,
            commands::media::tag_attach_batch,
            commands::media::tag_detach_batch,
            commands::media::rating_set,
            commands::media::rating_set_batch,
            commands::media::media_delete_preview,
            commands::media::media_delete_items,
            commands::media::media_purge_missing_items,
            commands::media::media_thumbnail,
            commands::media::media_preview,
            commands::media::thumbnail_rebuild_start,
            commands::media::preview_job_cancel,
            commands::media::library_scan_start,
            commands::media::library_scan_cancel,
            commands::backup::backup_sources_discover,
            commands::backup::backup_preview,
            commands::backup::backup_start,
            commands::backup::backup_retry_failed,
            commands::backup::backup_cancel,
            commands::backup::backup_history,
            commands::backup::backup_run_items,
            commands::editing::library_merge_preview,
            commands::editing::library_merge_start,
            commands::editing::library_merge_cancel,
            commands::editing::media_edit_image,
            commands::editing::media_trim_video,
            commands::editing::media_cut_video_segments,
            commands::editing::media_edit_cancel,
            commands::editing::media_merge_videos,
            commands::editing::media_merge_cancel,
            commands::ai::ai_get_config,
            commands::ai::ai_set_config,
            commands::ai::ai_test_connection,
            commands::ai::ai_stats,
            commands::ai::ai_process_preview,
            commands::ai::ai_process_start,
            commands::ai::ai_process_cancel,
            commands::ai::ai_process_item,
            commands::ai::ai_search,
            commands::ai::ai_tag_detach,
            commands::ai::ai_chat,
            commands::ai::ai_chat_cancel,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
