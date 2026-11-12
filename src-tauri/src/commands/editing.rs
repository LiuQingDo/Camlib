//! Photo editing, video trimming/merging, and library segment merge commands.

use crate::db;
use crate::editing;
use crate::errors::AppError;
use crate::infrastructure::{self, InfrastructureError, InfrastructureState};
use crate::library_merge;
use crate::scanner::{self, ScanManagerState};
use crate::video_merge;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{AppHandle, State};

/// Render an edited COPY of a photo beside the original (never overwrites it)
/// and kick off an incremental scan so the copy joins the library.
// Tauri command：形参名就是前端 invoke 的载荷键，把编辑参数收进结构体会改变
// IPC 契约；这里保留扁平形参，与前端 editing API 的字段逐项对应。
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn media_edit_image(
    media_item_id: String,
    crop: editing::CropRect,
    rotate90: Option<i32>,
    flip_h: Option<bool>,
    flip_v: Option<bool>,
    brightness: Option<f32>,
    contrast: Option<f32>,
    saturation: Option<f32>,
    app: AppHandle,
    state: State<'_, InfrastructureState>,
    scans: State<'_, ScanManagerState>,
) -> Result<editing::EditResultDto, AppError> {
    let (details, root, database_path, library_id) =
        state.with_infrastructure(|infrastructure| {
            let details = infrastructure
                .repository()
                .get_media_item_details(&media_item_id)
                .map_err(InfrastructureError::database)?
                .ok_or_else(|| InfrastructureError::MediaMissing("媒体不存在".to_owned()))?;
            let library = infrastructure
                .repository()
                .get_library(&details.item.library_id)
                .map_err(InfrastructureError::database)?
                .ok_or_else(|| InfrastructureError::InvalidPath("媒体库不存在".to_owned()))?;
            if library.state != db::LibraryState::Available {
                return Err(InfrastructureError::LibraryOffline(
                    "媒体库当前不可用".to_owned(),
                ));
            }
            Ok((
                details,
                PathBuf::from(library.root_path),
                infrastructure.database_path(),
                library.id,
            ))
        })?;
    let params = editing::CropParams {
        crop,
        rotate90: rotate90.unwrap_or(0).rem_euclid(4),
        flip_h: flip_h.unwrap_or(false),
        flip_v: flip_v.unwrap_or(false),
        brightness: brightness.unwrap_or(1.0),
        contrast: contrast.unwrap_or(1.0),
        saturation: saturation.unwrap_or(1.0),
    };
    let app_for_edit = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        editing::edit_image(&app_for_edit, &details, &root, &params)
    })
    .await
    .map_err(|error| AppError::internal(format!("编辑任务异常退出: {error}")))??;

    // Index the new copy without waiting for the next full scan.
    let scan_manager = Arc::new(scans.inner().clone());
    if let Ok((scan_job, scan_cancel)) = scan_manager.start(&library_id) {
        scanner::spawn_scan(
            app,
            scan_manager,
            database_path,
            library_id,
            scan_job,
            scan_cancel,
            false,
        );
    }
    Ok(result)
}

/// Start trimming a video into a new `{stem}_edited{ext}` copy. Runs as a
/// cancellable background job reporting `edit-progress` events.
// Tauri command：形参名即前端 invoke 载荷键（含三个 State 注入），收成结构体
// 会改变 IPC 契约，也会打乱 Tauri 的 State 注入顺序。
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub fn media_trim_video(
    media_item_id: String,
    in_ms: i64,
    out_ms: i64,
    precise: Option<bool>,
    app: AppHandle,
    infrastructure: State<'_, InfrastructureState>,
    edits: State<'_, editing::EditJobManagerState>,
    scans: State<'_, ScanManagerState>,
) -> Result<editing::EditJobStartDto, AppError> {
    if in_ms < 0 || out_ms <= in_ms {
        return Err(AppError::invalid_argument("剪辑区间无效"));
    }
    let (database_path, library_id) = infrastructure.with_infrastructure(|value| {
        let details = value
            .repository()
            .get_media_item_details(&media_item_id)
            .map_err(InfrastructureError::database)?
            .ok_or_else(|| InfrastructureError::MediaMissing("媒体不存在".to_owned()))?;
        let library = value
            .repository()
            .get_library(&details.item.library_id)
            .map_err(InfrastructureError::database)?
            .ok_or_else(|| InfrastructureError::InvalidPath("媒体库不存在".to_owned()))?;
        if library.state != db::LibraryState::Available {
            return Err(InfrastructureError::LibraryOffline(
                "媒体库当前不可用".to_owned(),
            ));
        }
        Ok((value.database_path(), library.id))
    })?;
    let (job_id, cancel) = edits.start()?;
    editing::spawn(
        app,
        Arc::new(edits.inner().clone()),
        Arc::new(scans.inner().clone()),
        database_path,
        library_id,
        job_id.clone(),
        cancel,
        editing::TrimParams {
            media_item_id,
            in_ms,
            out_ms,
            precise: precise.unwrap_or(false),
        },
    );
    Ok(editing::EditJobStartDto { job_id })
}

/// Start cutting a video into several segment copies in one job, optionally
/// joining flagged segments (in segment order) into one extra merged copy.
/// Runs as a cancellable background job reporting `edit-progress` events.
#[tauri::command]
pub fn media_cut_video_segments(
    media_item_id: String,
    segments: Vec<editing::CutSegmentSpec>,
    precise: Option<bool>,
    app: AppHandle,
    infrastructure: State<'_, InfrastructureState>,
    edits: State<'_, editing::EditJobManagerState>,
    scans: State<'_, ScanManagerState>,
) -> Result<editing::EditJobStartDto, AppError> {
    if segments.is_empty() || segments.len() > editing::MAX_CUT_SEGMENTS {
        return Err(AppError::invalid_argument("剪辑片段数量无效"));
    }
    for segment in &segments {
        if segment.in_ms < 0 || segment.out_ms <= segment.in_ms {
            return Err(AppError::invalid_argument("剪辑区间无效"));
        }
    }
    let (database_path, library_id) = infrastructure.with_infrastructure(|value| {
        let details = value
            .repository()
            .get_media_item_details(&media_item_id)
            .map_err(InfrastructureError::database)?
            .ok_or_else(|| InfrastructureError::MediaMissing("媒体不存在".to_owned()))?;
        let library = value
            .repository()
            .get_library(&details.item.library_id)
            .map_err(InfrastructureError::database)?
            .ok_or_else(|| InfrastructureError::InvalidPath("媒体库不存在".to_owned()))?;
        if library.state != db::LibraryState::Available {
            return Err(InfrastructureError::LibraryOffline(
                "媒体库当前不可用".to_owned(),
            ));
        }
        Ok((value.database_path(), library.id))
    })?;
    let (job_id, cancel) = edits.start()?;
    editing::spawn_cut_segments(
        app,
        Arc::new(edits.inner().clone()),
        Arc::new(scans.inner().clone()),
        database_path,
        library_id,
        job_id.clone(),
        cancel,
        editing::CutSegmentsParams {
            media_item_id,
            segments,
            precise: precise.unwrap_or(false),
        },
    );
    Ok(editing::EditJobStartDto { job_id })
}

/// Cancel the running video trim job.
#[tauri::command]
pub fn media_edit_cancel(
    job_id: String,
    edits: State<'_, editing::EditJobManagerState>,
) -> Result<(), AppError> {
    edits.cancel(&job_id)
}

/// Start merging selected videos into one new `{stem}_merged{ext}` copy.
/// `media_item_ids` order is the playback order. Runs as a cancellable
/// background job reporting `media-merge-progress` events.
// Tauri command：形参名即前端 invoke 载荷键（含三个 State 注入），收成结构体
// 会改变 IPC 契约，也会打乱 Tauri 的 State 注入顺序。
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub fn media_merge_videos(
    library_id: String,
    media_item_ids: Vec<String>,
    mode: Option<String>,
    recycle_sources: Option<bool>,
    app: AppHandle,
    infrastructure: State<'_, InfrastructureState>,
    merges: State<'_, video_merge::VideoMergeManagerState>,
    scans: State<'_, ScanManagerState>,
) -> Result<video_merge::VideoMergeStartDto, AppError> {
    if media_item_ids.len() < 2 {
        return Err(AppError::invalid_argument("合并至少需要选择两个视频"));
    }
    let mode = match mode.as_deref() {
        Some("reencode") => video_merge::VideoMergeMode::Reencode,
        _ => video_merge::VideoMergeMode::Copy,
    };
    let database_path = infrastructure.with_infrastructure(|value| {
        let library = value
            .repository()
            .get_library(&library_id)
            .map_err(InfrastructureError::database)?
            .ok_or_else(|| InfrastructureError::InvalidPath("媒体库不存在".to_owned()))?;
        if library.state != db::LibraryState::Available {
            return Err(InfrastructureError::LibraryOffline(
                "媒体库当前不可用".to_owned(),
            ));
        }
        Ok(value.database_path())
    })?;
    let (job_id, cancel) = merges.start()?;
    video_merge::spawn(
        app,
        Arc::new(merges.inner().clone()),
        Arc::new(scans.inner().clone()),
        database_path,
        library_id,
        job_id.clone(),
        cancel,
        video_merge::VideoMergeParams {
            media_item_ids,
            mode,
            recycle_sources: recycle_sources.unwrap_or(false),
        },
    );
    Ok(video_merge::VideoMergeStartDto { job_id })
}

/// Cancel the running video merge job.
#[tauri::command]
pub fn media_merge_cancel(
    job_id: String,
    merges: State<'_, video_merge::VideoMergeManagerState>,
) -> Result<(), AppError> {
    merges.cancel(&job_id)
}

/// Preview library camera-split video segments that can be merged.
#[tauri::command]
pub fn library_merge_preview(
    library_id: String,
    state: State<'_, InfrastructureState>,
) -> Result<library_merge::LibraryMergePreviewDto, AppError> {
    state.with_infrastructure(|infrastructure| {
        library_merge::preview(infrastructure.repository(), &library_id)
            .map_err(|error| infrastructure::InfrastructureError::InvalidPath(error.to_string()))
    })
}

/// Start merging library segments. Sources stay untouched unless recycle is on.
#[tauri::command]
pub fn library_merge_start(
    library_id: String,
    recycle_sources: Option<bool>,
    destinations: Option<Vec<String>>,
    app: AppHandle,
    infrastructure: State<'_, InfrastructureState>,
    merges: State<'_, library_merge::LibraryMergeManagerState>,
    scans: State<'_, ScanManagerState>,
) -> Result<library_merge::LibraryMergeStartDto, AppError> {
    let database_path = infrastructure.with_infrastructure(|value| {
        value
            .repository()
            .get_library(&library_id)
            .map_err(infrastructure::InfrastructureError::database)?
            .ok_or_else(|| {
                infrastructure::InfrastructureError::InvalidPath("媒体库不存在".to_owned())
            })?;
        Ok(value.database_path())
    })?;
    let (job_id, cancel) = merges.start()?;
    library_merge::spawn(
        app,
        Arc::new(merges.inner().clone()),
        Arc::new(scans.inner().clone()),
        database_path,
        library_id,
        job_id.clone(),
        cancel,
        recycle_sources.unwrap_or(false),
        destinations,
    );
    Ok(library_merge::LibraryMergeStartDto { job_id })
}

/// Cancel the running library segment merge job.
#[tauri::command]
pub fn library_merge_cancel(
    job_id: String,
    merges: State<'_, library_merge::LibraryMergeManagerState>,
) -> Result<(), AppError> {
    merges.cancel(&job_id)
}
