//! App shell commands: greeting, ffmpeg probe, About panel, cache stats, folder opening.

use crate::errors::AppError;
use crate::infrastructure::{self, InfrastructureState};
use crate::media;
use serde::Serialize;
use std::path::PathBuf;
use tauri::{AppHandle, State};

#[tauri::command]
pub fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

/// ffmpeg 是视频缩略图与剪辑的可选依赖，缺失不应让启动失败。
/// 前端在首帧之后调用一次，只用来决定是否显示一行安装引导。
/// `async` 是有意的：探测要起一个 `ffmpeg -version` 子进程，不能占着主线程。
#[tauri::command]
pub async fn ffmpeg_available(app: AppHandle) -> bool {
    media::resolve_ffmpeg(&app).is_ok()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FfmpegStatusDto {
    available: bool,
    path: Option<String>,
    message: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThumbnailCacheStatsDto {
    path: String,
    file_count: u64,
    total_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppAboutDto {
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
pub fn get_app_about(
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
pub fn get_thumbnail_cache_stats(
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
pub fn open_app_directory(
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
