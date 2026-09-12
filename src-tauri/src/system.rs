//! System integration: tray icon, close behavior, notifications, volume watch.
//!
//! Tray and notification failures are logged and swallowed so they can never
//! prevent the main window from starting.

use crate::infrastructure::{
    CloseBehavior, InfrastructureState, LibraryAvailability, LibraryStatus,
};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow, Wry};

/// Latest library availability seen by the volume watcher. Used to avoid
/// repeating disconnect/reconnect notifications for the same transition.
#[derive(Debug, Default)]
pub struct VolumeWatchState {
    last: Mutex<Option<LibraryAvailability>>,
}

pub fn setup_tray(app: &AppHandle<Wry>) {
    if let Err(error) = try_setup_tray(app) {
        eprintln!("托盘图标初始化失败（不影响主窗口）: {error}");
    }
}

fn try_setup_tray(app: &AppHandle<Wry>) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "显示主窗口", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出 Camlib", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;
    let Some(icon) = app.default_window_icon().cloned() else {
        eprintln!("缺少默认窗口图标，跳过托盘初始化");
        return Ok(());
    };

    let _tray = TrayIconBuilder::with_id("main-tray")
        .icon(icon)
        .tooltip("Camlib")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => show_main_window(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

pub fn show_main_window(app: &AppHandle<Wry>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// Hide instead of exit when the persisted close behavior asks for tray mode.
pub fn install_close_handler(window: &WebviewWindow<Wry>, app: AppHandle<Wry>) {
    let window_for_handler = window.clone();
    window.on_window_event(move |event| {
        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
            let behavior = app
                .state::<InfrastructureState>()
                .with_infrastructure(|infrastructure| Ok(infrastructure.settings()?.close_behavior))
                .unwrap_or(CloseBehavior::Quit);
            if behavior == CloseBehavior::MinimizeToTray {
                api.prevent_close();
                let _ = window_for_handler.hide();
            }
        }
    });
}

/// Best-effort system notification. Never panics; failures only log.
pub fn notify(app: &AppHandle<Wry>, title: &str, body: &str) {
    let enabled = app
        .state::<InfrastructureState>()
        .with_infrastructure(|infrastructure| Ok(infrastructure.settings()?.notifications_enabled))
        .unwrap_or(false);
    if !enabled {
        return;
    }
    #[allow(unused_imports)]
    use tauri_plugin_notification::NotificationExt;
    if let Err(error) = app.notification().builder().title(title).body(body).show() {
        eprintln!("系统通知发送失败: {error}");
    }
}

pub fn notify_scan_terminal(
    app: &AppHandle<Wry>,
    state: &str,
    files_seen: i64,
    error: Option<&str>,
) {
    match state {
        "completed" => notify(
            app,
            "扫描完成",
            &format!("已扫描 {files_seen} 个文件，索引已更新"),
        ),
        "failed" => notify(
            app,
            "扫描失败",
            error.unwrap_or("扫描过程中出现错误，请查看设置中的扫描记录"),
        ),
        "cancelled" => notify(app, "扫描已取消", "本次扫描已停止"),
        _ => {}
    }
}

pub fn notify_backup_terminal(
    app: &AppHandle<Wry>,
    state: &str,
    copied_files: i64,
    error: Option<&str>,
) {
    match state {
        "completed" => notify(
            app,
            "备份完成",
            &format!("已复制 {copied_files} 个文件，后台将自动扫描入库"),
        ),
        "failed" => notify(
            app,
            "备份失败",
            error.unwrap_or("备份过程中出现错误，请打开备份面板查看详情"),
        ),
        "cancelled" => notify(app, "备份已取消", "已复制的文件保留在目标盘"),
        _ => {}
    }
}

/// Poll library availability and notify on disconnect/reconnect transitions.
pub fn spawn_volume_watch(app: AppHandle<Wry>) {
    std::thread::spawn(move || {
        let state = VolumeWatchState::default();
        loop {
            let status = app
                .state::<InfrastructureState>()
                .with_infrastructure(|infrastructure| infrastructure.library_status());
            if let Ok(status) = status {
                handle_availability(&app, &state, status);
            }
            std::thread::sleep(Duration::from_secs(5));
        }
    });
}

fn handle_availability(
    app: &AppHandle<Wry>,
    state: &VolumeWatchState,
    status: LibraryStatus,
) {
    let mut last = match state.last.lock() {
        Ok(lock) => lock,
        Err(_) => return,
    };
    let current = status.availability.clone();
    let previous = last.replace(current.clone());
    if previous.as_ref() == Some(&current) {
        return;
    }
    // Seed on first sample without notifying so a cold start with a missing
    // volume does not immediately spam the user.
    if previous.is_none() {
        let _ = app.emit("library-status", &status);
        return;
    }
    let previous = previous.unwrap_or(LibraryAvailability::Unconfigured);
    match (&previous, &current) {
        (LibraryAvailability::Available, LibraryAvailability::Disconnected) => {
            notify(
                app,
                "媒体库已断开",
                status
                    .reason
                    .as_deref()
                    .unwrap_or("媒体库根目录不可用，请连接磁盘后重新扫描"),
            );
        }
        (LibraryAvailability::Available, LibraryAvailability::Invalid) => {
            notify(
                app,
                "媒体库路径异常",
                status
                    .reason
                    .as_deref()
                    .unwrap_or("当前卷与记录的媒体库不一致，请检查磁盘"),
            );
        }
        (LibraryAvailability::Disconnected, LibraryAvailability::Available)
        | (LibraryAvailability::Invalid, LibraryAvailability::Available) => {
            notify(app, "媒体库已恢复", "磁盘重新可用，可以继续扫描与管理");
        }
        _ => {}
    }
    let _ = app.emit("library-status", &status);
}

pub fn timestamp_now() -> String {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0);
    format!("unix-ms:{millis}")
}
