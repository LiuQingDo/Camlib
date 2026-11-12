//! Backup preview, execution, retry, and history commands.

use crate::backup::{
    self, BackupManagerState, BackupPreviewDto, BackupPreviewRequest, BackupStartResponse,
    BackupVolumeDto,
};
use crate::db;
use crate::errors::AppError;
use crate::infrastructure::{self, InfrastructureState};
use crate::scanner::ScanManagerState;
use std::sync::Arc;
use tauri::{AppHandle, State};

/// Discover removable volumes with a direct DCIM directory. The result is
/// only a list of candidates; no camera file is opened or changed here.
#[tauri::command]
pub fn backup_sources_discover() -> Result<Vec<BackupVolumeDto>, AppError> {
    Ok(backup::discover_volumes())
}

/// Build and persist a read-only backup preview. Copying is a separate command
/// and requires the preview confirmation token. Conflict policy and default
/// ignore extensions come from app settings when the request omits them.
#[tauri::command]
pub async fn backup_preview(
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
pub fn backup_start(
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
pub fn backup_retry_failed(
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
pub fn backup_cancel(
    job_id: String,
    backups: State<'_, BackupManagerState>,
) -> Result<(), AppError> {
    backups.cancel(&job_id)
}

/// Recent backup attempts (completed / failed / cancelled), newest first.
#[tauri::command]
pub fn backup_history(
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
pub fn backup_run_items(
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
