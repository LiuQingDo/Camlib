//! Camera-volume discovery, read-only planning, and safe backup execution.
//!
//! Long camera recordings are often auto-split into ~30 minute files that share
//! `VID_YYYYMMDD_HHMMSS` and differ only in a trailing sequence number. When
//! merge is enabled those segments become one backup item and one ffmpeg concat
//! output, so the library keeps a single complete video.

use crate::db::{
    BackupItem, BackupStatus, ConflictPolicy, NewBackupItem, NewBackupRun, Repository,
};
use crate::media::resolve_ffmpeg;
use crate::scanner;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

const DEFAULT_IGNORED_EXTENSIONS: &[&str] = &[".dng", ".lrv"];
const PHOTO_EXTENSIONS: &[&str] = &[
    ".jpg", ".jpeg", ".png", ".heic", ".heif", ".tif", ".tiff", ".cr2", ".cr3", ".nef", ".arw",
    ".raf", ".rw2", ".orf",
];
const VIDEO_EXTENSIONS: &[&str] = &[".mp4", ".mov", ".avi", ".m4v", ".mts", ".m2ts", ".3gp"];

static NEXT_BACKUP: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BackupVolumeDto {
    pub id: String,
    pub root_path: String,
    pub dcim_path: String,
    pub volume_label: Option<String>,
    pub drive_letter: Option<String>,
    pub removable: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupPreviewRequest {
    pub source_volume_id: String,
    pub target_library_id: String,
    pub conflict_policy: Option<ConflictPolicy>,
    pub ignore_extensions: Option<Vec<String>>,
    /// Collapse camera-split video segments into one merged file. Defaults on.
    pub merge_segments: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum BackupItemStatus {
    Ready,
    AlreadyExists,
    Conflict,
    Ignored,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupItemPreviewDto {
    pub source_relative: String,
    pub destination_relative: Option<String>,
    pub file_name: String,
    pub kind: Option<String>,
    pub capture_date: Option<String>,
    pub date_source: Option<String>,
    pub size_bytes: u64,
    pub extension: String,
    pub status: BackupItemStatus,
    pub reason: Option<String>,
    /// Extra source_relative paths (in playback order) when this item will
    /// merge camera-split segments. Empty for ordinary single-file copies.
    #[serde(default)]
    pub merge_sources: Vec<String>,
    /// Human label for a merge group, e.g. `VID_20261001_153408`.
    #[serde(default)]
    pub merge_group: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupPreviewDto {
    pub id: String,
    pub backup_run_id: String,
    pub source: BackupVolumeDto,
    pub target_library_id: String,
    pub target_root_path: String,
    pub conflict_policy: ConflictPolicy,
    pub ignore_extensions: Vec<String>,
    // The complete plan is persisted in `backup_items` for execution and
    // retry. The current UI only presents aggregate counts, so returning every
    // item across IPC makes large camera cards needlessly stall the WebView.
    // Kept for internal construction/debug; never sent to the frontend.
    #[serde(skip_serializing, default)]
    #[allow(dead_code)]
    pub items: Vec<BackupItemPreviewDto>,
    pub total_files: u64,
    pub total_bytes: u64,
    pub ready_files: u64,
    pub already_exists_files: u64,
    pub conflict_files: u64,
    pub ignored_files: u64,
    pub required_bytes: u64,
    pub free_bytes: Option<u64>,
    pub space_sufficient: Option<bool>,
    pub merge_segments: bool,
    /// Number of merge groups that will be produced (0 when merge is off).
    pub merge_group_count: u64,
    /// Number of source segment files that will be collapsed by merging.
    pub merge_segment_count: u64,
    /// Groups that this backup will actually merge. Already-present results are omitted.
    #[serde(default)]
    pub merge_groups: Vec<BackupMergeGroupDto>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BackupMergeGroupDto {
    /// Output file name, e.g. `VID_20261001_153408.mp4`.
    pub file_name: String,
    /// Source file names in playback order.
    pub segments: Vec<String>,
    pub size_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupProgress {
    pub job_id: String,
    pub kind: &'static str,
    pub seq: u64,
    pub phase: &'static str,
    pub state: &'static str,
    pub current_file: Option<String>,
    pub file_processed: i64,
    pub file_total: i64,
    pub bytes_processed: i64,
    pub bytes_total: i64,
    pub speed_bytes_per_sec: u64,
    pub eta_seconds: Option<u64>,
    pub errors: Vec<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupStartResponse {
    pub job_id: String,
    pub backup_run_id: String,
}

#[derive(Debug, Clone)]
struct ActiveBackup {
    cancel: Arc<AtomicBool>,
}

#[derive(Debug, Clone)]
pub struct BackupManagerState {
    jobs: Arc<Mutex<HashMap<String, ActiveBackup>>>,
}

impl BackupManagerState {
    pub fn new() -> Self {
        Self {
            jobs: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn start(&self) -> Result<(String, Arc<AtomicBool>), crate::errors::AppError> {
        let mut jobs = self
            .jobs
            .lock()
            .map_err(|_| crate::errors::AppError::internal("备份任务状态锁已损坏"))?;
        if !jobs.is_empty() {
            return Err(crate::errors::AppError::job_already_running(
                "已有备份任务正在运行",
            ));
        }
        let job_id = next_id("backup");
        let cancel = Arc::new(AtomicBool::new(false));
        jobs.insert(
            job_id.clone(),
            ActiveBackup {
                cancel: cancel.clone(),
            },
        );
        Ok((job_id, cancel))
    }

    pub fn cancel(&self, job_id: &str) -> Result<(), crate::errors::AppError> {
        let jobs = self
            .jobs
            .lock()
            .map_err(|_| crate::errors::AppError::internal("备份任务状态锁已损坏"))?;
        jobs.get(job_id)
            .ok_or_else(|| crate::errors::AppError::job_not_found("备份任务不存在"))?
            .cancel
            .store(true, Ordering::Relaxed);
        Ok(())
    }

    pub fn finish(&self, job_id: &str) {
        if let Ok(mut jobs) = self.jobs.lock() {
            jobs.remove(job_id);
        }
    }
}

#[derive(Debug, Clone)]
struct VolumeCandidate {
    root_path: PathBuf,
    dcim_path: PathBuf,
    volume_id: Option<String>,
    volume_label: Option<String>,
    drive_letter: Option<String>,
    removable: bool,
}

#[derive(Debug)]
pub enum BackupError {
    Io { path: PathBuf, source: io::Error },
    Invalid(String),
    Database(crate::db::DbError),
}

impl std::fmt::Display for BackupError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io { path, source } => write!(f, "读取备份路径失败 {}: {source}", path.display()),
            Self::Invalid(message) => write!(f, "备份预览无效: {message}"),
            Self::Database(error) => write!(f, "备份记录失败: {error}"),
        }
    }
}

impl std::error::Error for BackupError {}

impl From<crate::db::DbError> for BackupError {
    fn from(value: crate::db::DbError) -> Self {
        Self::Database(value)
    }
}

pub fn default_ignore_extensions() -> Vec<String> {
    DEFAULT_IGNORED_EXTENSIONS
        .iter()
        .map(|value| (*value).to_owned())
        .collect()
}

/// Discover removable Windows volumes whose root contains a direct `DCIM`
/// directory. The candidate list is intentionally injectable for tests.
pub fn discover_volumes() -> Vec<BackupVolumeDto> {
    discover_candidates()
        .into_iter()
        .map(|candidate| volume_dto(&candidate))
        .collect()
}

pub fn preview(
    repository: &Repository,
    request: BackupPreviewRequest,
) -> Result<BackupPreviewDto, BackupError> {
    let source = discover_candidates()
        .into_iter()
        .find(|candidate| volume_dto(candidate).id == request.source_volume_id)
        .ok_or_else(|| BackupError::Invalid("源相机盘不存在，或已断开".to_owned()))?;
    let target = repository
        .get_library(&request.target_library_id)?
        .ok_or_else(|| BackupError::Invalid("目标媒体库不存在".to_owned()))?;
    let free_bytes = available_space(Path::new(&target.root_path));
    preview_paths(
        repository,
        source,
        target.root_path,
        request.target_library_id,
        request.conflict_policy.unwrap_or(ConflictPolicy::SkipSame),
        request.ignore_extensions,
        free_bytes,
        request.merge_segments,
    )
}

fn preview_paths(
    repository: &Repository,
    source: VolumeCandidate,
    target_root_path: String,
    target_library_id: String,
    conflict_policy: ConflictPolicy,
    ignore_extensions: Option<Vec<String>>,
    free_bytes: Option<u64>,
    request_merge_segments: Option<bool>,
) -> Result<BackupPreviewDto, BackupError> {
    let source_root = fs::canonicalize(&source.root_path).map_err(|error| BackupError::Io {
        path: source.root_path.clone(),
        source: error,
    })?;
    let target_root =
        fs::canonicalize(Path::new(&target_root_path)).map_err(|error| BackupError::Io {
            path: PathBuf::from(&target_root_path),
            source: error,
        })?;
    let dcim_path = fs::canonicalize(&source.dcim_path).map_err(|error| BackupError::Io {
        path: source.dcim_path.clone(),
        source: error,
    })?;
    if is_same_or_child(&target_root, &source_root) {
        return Err(BackupError::Invalid(
            "目标媒体库不能位于相机源盘内".to_owned(),
        ));
    }
    let ignore_extensions =
        normalize_extensions(ignore_extensions.unwrap_or_else(default_ignore_extensions));
    let ignore_extensions_list = sorted_extensions(&ignore_extensions);
    let mut items = collect_items(&source_root, &dcim_path, &target_root, &ignore_extensions)?;
    let merge_segments = request_merge_segments.unwrap_or(true);
    if merge_segments {
        items = collapse_segment_groups(items);
        refresh_merged_destinations(&mut items, &target_root)?;
    }
    let source_dto = volume_dto(&source);
    let total_files = items.len() as u64;
    let total_bytes = items.iter().map(|item| item.size_bytes).sum();
    let ready_files = count_status(&items, BackupItemStatus::Ready);
    let already_exists_files = count_status(&items, BackupItemStatus::AlreadyExists);
    let conflict_files = count_status(&items, BackupItemStatus::Conflict);
    let ignored_files = count_status(&items, BackupItemStatus::Ignored);
    let required_bytes = items
        .iter()
        .filter(|item| {
            item.status == BackupItemStatus::Ready
                || (item.status == BackupItemStatus::Conflict
                    && conflict_policy != ConflictPolicy::SkipSame)
        })
        .map(|item| item.size_bytes)
        .sum();
    let space_sufficient = free_bytes.map(|free| free >= required_bytes);
    let preview_id = next_id("preview");
    let backup_run_id = next_id("backup-run");
    let error_summary = space_sufficient
        .filter(|sufficient| !sufficient)
        .map(|_| format!("目标盘空间不足，需要 {required_bytes} 字节"));

    let merge_groups = merge_group_summaries(&items, &conflict_policy);
    let merge_group_count = merge_groups.len() as u64;
    let merge_segment_count = merge_groups
        .iter()
        .map(|group| group.segments.len() as u64)
        .sum();

    repository.create_backup_run(NewBackupRun {
        id: backup_run_id.clone(),
        job_id: preview_id.clone(),
        source_volume_id: Some(source_dto.id.clone()),
        source_root_path: source_dto.root_path.clone(),
        target_library_id: target_library_id.clone(),
        status: BackupStatus::Preview,
        conflict_policy: conflict_policy.clone(),
        ignore_extensions: serde_json::to_string(&ignore_extensions_list)
            .map_err(|error| BackupError::Invalid(format!("忽略配置无法序列化: {error}")))?,
        started_at: timestamp_now(),
        finished_at: None,
        total_files: total_files as i64,
        copied_files: 0,
        skipped_files: (already_exists_files + ignored_files) as i64,
        failed_files: 0,
        total_bytes: total_bytes as i64,
        copied_bytes: 0,
        error_summary,
    })?;

    let backup_items = items
        .iter()
        .enumerate()
        .map(|(index, item)| {
            let merge_sources_json = if item.merge_sources.is_empty() {
                None
            } else {
                let mut all = vec![item.source_relative.clone()];
                all.extend(item.merge_sources.iter().cloned());
                Some(serde_json::to_string(&all).map_err(|error| {
                    BackupError::Invalid(format!("合并源列表无法序列化: {error}"))
                })?)
            };
            Ok(NewBackupItem {
                id: format!("{}-item-{index}", backup_run_id),
                backup_run_id: backup_run_id.clone(),
                source_relative: item.source_relative.clone(),
                destination_relative: item.destination_relative.clone(),
                size_bytes: item.size_bytes as i64,
                status: match &item.status {
                    BackupItemStatus::Ready | BackupItemStatus::Conflict => "planned",
                    BackupItemStatus::AlreadyExists | BackupItemStatus::Ignored => "skipped",
                }
                .to_owned(),
                copied_bytes: 0,
                error_message: item.reason.clone(),
                merge_sources_json,
            })
        })
        .collect::<Result<Vec<_>, BackupError>>()?;
    repository.create_backup_items(&backup_items)?;

    Ok(BackupPreviewDto {
        id: preview_id,
        backup_run_id,
        source: source_dto,
        target_library_id,
        target_root_path,
        conflict_policy,
        ignore_extensions: ignore_extensions_list,
        items,
        total_files,
        total_bytes,
        ready_files,
        already_exists_files,
        conflict_files,
        ignored_files,
        required_bytes,
        free_bytes,
        space_sufficient,
        merge_segments,
        merge_group_count,
        merge_segment_count,
        merge_groups,
    })
}

/// Start a previously persisted preview. The caller must provide the preview's
/// job id as its confirmation token; this binds confirmation to exactly the
/// plan the user inspected and prevents a fresh/unreviewed plan from running.
pub fn spawn(
    app: AppHandle,
    manager: Arc<BackupManagerState>,
    scan_manager: Arc<scanner::ScanManagerState>,
    database_path: PathBuf,
    preview_id: String,
    job_id: String,
    cancel: Arc<AtomicBool>,
    retry_item_ids: Option<Vec<String>>,
) {
    std::thread::spawn(move || {
        let result = run(
            &app,
            &database_path,
            &preview_id,
            &job_id,
            &cancel,
            retry_item_ids,
        );
        if let Err(error) = &result {
            if let Ok(mut log) = OpenOptions::new()
                .create(true)
                .append(true)
                .open(database_path.with_file_name(format!("backup-{preview_id}.log")))
            {
                let _ = writeln!(log, "{} [task] {}", timestamp_now(), error);
            }
            if let Ok(repository) = Repository::open(&database_path) {
                let record = repository.get_backup_run(&preview_id).ok().flatten();
                let _ = repository.update_backup_run(
                    &preview_id,
                    &job_id,
                    BackupStatus::Failed,
                    record.as_ref().map(|value| value.copied_files).unwrap_or(0),
                    record
                        .as_ref()
                        .map(|value| value.skipped_files)
                        .unwrap_or(0),
                    record
                        .as_ref()
                        .map(|value| value.failed_files.max(1))
                        .unwrap_or(1),
                    record.as_ref().map(|value| value.copied_bytes).unwrap_or(0),
                    Some(&timestamp_now()),
                    Some(error),
                );
                let items = repository
                    .list_backup_items(&preview_id)
                    .unwrap_or_default();
                emit(
                    &app,
                    progress(
                        &job_id,
                        "failed",
                        None,
                        &items,
                        0,
                        0,
                        Instant::now(),
                        vec![error.clone()],
                        Some(error.clone()),
                    ),
                );
            }
        }
        if matches!(result, Ok(BackupStatus::Completed)) {
            if let Ok(repository) = Repository::open(&database_path) {
                if let Ok(Some(run)) = repository.get_backup_run(&preview_id) {
                    if let Ok((scan_job, scan_cancel)) = scan_manager.start(&run.target_library_id)
                    {
                        scanner::spawn_scan(
                            app.clone(),
                            scan_manager.clone(),
                            database_path.clone(),
                            run.target_library_id,
                            scan_job,
                            scan_cancel,
                            false,
                        );
                    }
                }
            }
        }
        manager.finish(&job_id);
    });
}

fn run(
    app: &AppHandle,
    database_path: &Path,
    run_id: &str,
    job_id: &str,
    cancel: &AtomicBool,
    retry_item_ids: Option<Vec<String>>,
) -> Result<BackupStatus, String> {
    let repository = Repository::open(database_path).map_err(|error| error.to_string())?;
    let run_record = repository
        .get_backup_run(run_id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "备份任务不存在".to_owned())?;
    let target = repository
        .get_library(&run_record.target_library_id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "目标媒体库不存在".to_owned())?;
    let source_root = canonical_dir(Path::new(&run_record.source_root_path), "相机源盘")?;
    let target_root = canonical_dir(Path::new(&target.root_path), "目标媒体库")?;
    if is_same_or_child(&target_root, &source_root) {
        return fail_run(&repository, run_id, job_id, "目标媒体库不能位于相机源盘内");
    }
    if let Some(volume_id) = &run_record.source_volume_id {
        let current = discover_candidates()
            .into_iter()
            .find(|candidate| volume_dto(candidate).id == *volume_id)
            .ok_or_else(|| "源相机盘已断开或身份已变化".to_owned())?;
        let current_root = canonical_dir(&current.root_path, "相机源盘")?;
        if current_root != source_root {
            return fail_run(
                &repository,
                run_id,
                job_id,
                "源相机盘身份已变化，请重新预览",
            );
        }
    }

    let mut items = repository
        .list_backup_items(run_id)
        .map_err(|error| error.to_string())?;
    if let Some(free) = available_space(&target_root) {
        let required = items
            .iter()
            .filter(|item| item.status == "planned")
            .filter_map(|item| {
                let destination = item
                    .destination_relative
                    .as_deref()
                    .and_then(|relative| safe_join(&target_root, relative).ok());
                if run_record.conflict_policy == ConflictPolicy::SkipSame
                    && destination.as_ref().is_some_and(|path| path.exists())
                {
                    None
                } else {
                    Some(item.size_bytes.max(0) as u64)
                }
            })
            .sum::<u64>();
        if free < required {
            return fail_run(
                &repository,
                run_id,
                job_id,
                "目标盘空间不足，请重新检查目标盘",
            );
        }
    }
    let retry_set = retry_item_ids.map(|ids| ids.into_iter().collect::<HashSet<_>>());
    if retry_set.is_some() {
        for item in &items {
            if item.status == "failed"
                && retry_set.as_ref().is_some_and(|ids| ids.contains(&item.id))
            {
                repository
                    .update_backup_item(&item.id, "planned", 0, None, None)
                    .map_err(|error| error.to_string())?;
            }
        }
        items = repository
            .list_backup_items(run_id)
            .map_err(|error| error.to_string())?;
    }

    repository
        .update_backup_run(
            run_id,
            job_id,
            BackupStatus::Running,
            count_items(&items, "copied"),
            count_items(&items, "skipped"),
            count_items(&items, "failed"),
            sum_copied(&items),
            None,
            None,
        )
        .map_err(|error| error.to_string())?;
    emit(
        app,
        progress(
            job_id,
            "running",
            None,
            &items,
            0,
            0,
            Instant::now(),
            vec![],
            None,
        ),
    );

    let started = Instant::now();
    let mut completed_bytes = sum_copied(&items).max(0) as u64;
    let mut completed_files = count_items(&items, "copied") + count_items(&items, "skipped");
    let mut errors = Vec::new();
    let log_path = database_path.with_file_name(format!("backup-{run_id}.log"));
    let mut log = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .ok();

    for index in 0..items.len() {
        let item = items[index].clone();
        if item.status != "planned" {
            continue;
        }
        if cancel.load(Ordering::Relaxed) {
            cancel_remaining(&repository, &items[index..])?;
            return finish(
                app,
                &repository,
                run_id,
                job_id,
                BackupStatus::Cancelled,
                completed_files,
                completed_bytes,
                errors,
                Some("用户取消备份".to_owned()),
            );
        }
        let merge_sources =
            merge_segment_relatives(&item.source_relative, item.merge_sources_json.as_deref());
        let source_path = safe_join(&source_root, &item.source_relative)?;
        let Some(destination_relative) = item.destination_relative.as_deref() else {
            repository
                .update_backup_item(&item.id, "skipped", 0, None, None)
                .map_err(|e| e.to_string())?;
            items[index].status = "skipped".to_owned();
            completed_files += 1;
            continue;
        };
        let destination = safe_join(&target_root, destination_relative)?;
        let policy = run_record.conflict_policy.clone();
        if policy == ConflictPolicy::SkipSame && destination.exists() {
            repository
                .update_backup_item(&item.id, "skipped", 0, None, Some("按冲突设置跳过"))
                .map_err(|e| e.to_string())?;
            items[index].status = "skipped".to_owned();
            completed_files += 1;
            continue;
        }
        let destination = if policy == ConflictPolicy::Rename {
            unique_destination(&destination)?
        } else {
            destination
        };
        let display_name = if merge_sources.len() < 2 {
            item.source_relative.clone()
        } else {
            format!("{}（合并 {} 段）", item.file_name_hint(), merge_sources.len())
        };
        emit(
            app,
            progress(
                job_id,
                "running",
                Some(display_name.clone()),
                &items,
                completed_files,
                completed_bytes,
                started,
                errors.clone(),
                None,
            ),
        );
        let base_bytes = completed_bytes;
        let current_name = display_name.clone();
        let mut last_progress = Instant::now();
        let result = if merge_sources.len() < 2 {
            copy_and_verify(
                &source_path,
                &destination,
                item.size_bytes as u64,
                cancel,
                &mut |file_bytes| {
                    if last_progress.elapsed() >= Duration::from_millis(100) {
                        emit(
                            app,
                            progress(
                                job_id,
                                "running",
                                Some(current_name.clone()),
                                &items,
                                completed_files,
                                base_bytes + file_bytes,
                                started,
                                errors.clone(),
                                None,
                            ),
                        );
                        last_progress = Instant::now();
                    }
                },
            )
        } else {
            let mut segment_paths = Vec::with_capacity(merge_sources.len());
            let mut join_error = None;
            for relative in &merge_sources {
                match safe_join(&source_root, relative) {
                    Ok(path) => segment_paths.push(path),
                    Err(error) => {
                        join_error = Some(error);
                        break;
                    }
                }
            }
            if let Some(error) = join_error {
                Err(CopyError::Message(error))
            } else {
                match resolve_ffmpeg(app) {
                    Ok(ffmpeg) => merge_and_verify(
                        &ffmpeg,
                        &segment_paths,
                        &destination,
                        item.size_bytes as u64,
                        cancel,
                        &mut |file_bytes| {
                            if last_progress.elapsed() >= Duration::from_millis(100) {
                                emit(
                                    app,
                                    progress(
                                        job_id,
                                        "running",
                                        Some(current_name.clone()),
                                        &items,
                                        completed_files,
                                        base_bytes + file_bytes,
                                        started,
                                        errors.clone(),
                                        None,
                                    ),
                                );
                                last_progress = Instant::now();
                            }
                        },
                    ),
                    Err(error) => Err(CopyError::Message(error.to_string())),
                }
            }
        };
        match result {
            Ok(copied) => {
                let relative = relative_string(&target_root, &destination)?;
                repository
                    .update_backup_item(&item.id, "copied", copied as i64, Some(&relative), None)
                    .map_err(|e| e.to_string())?;
                items[index].status = "copied".to_owned();
                items[index].copied_bytes = copied as i64;
                items[index].destination_relative = Some(relative);
                completed_files += 1;
                completed_bytes += copied;
            }
            Err(CopyError::Cancelled) => {
                cleanup_temp(&destination);
                repository
                    .update_backup_item(&item.id, "cancelled", 0, None, Some("用户取消备份"))
                    .map_err(|e| e.to_string())?;
                cancel_remaining(&repository, &items[index + 1..])?;
                return finish(
                    app,
                    &repository,
                    run_id,
                    job_id,
                    BackupStatus::Cancelled,
                    completed_files,
                    completed_bytes,
                    errors,
                    Some("用户取消备份".to_owned()),
                );
            }
            Err(CopyError::Message(message)) => {
                if let Some(file) = log.as_mut() {
                    let _ = writeln!(
                        file,
                        "{} [{}] {}",
                        timestamp_now(),
                        item.source_relative,
                        message
                    );
                }
                repository
                    .update_backup_item(&item.id, "failed", 0, None, Some(&message))
                    .map_err(|e| e.to_string())?;
                items[index].status = "failed".to_owned();
                items[index].error_message = Some(message.clone());
                errors.push(format!("{}: {}", item.file_name_hint(), message));
            }
        }
        emit(
            app,
            progress(
                job_id,
                "running",
                None,
                &items,
                completed_files,
                completed_bytes,
                started,
                errors.clone(),
                None,
            ),
        );
    }
    let status = if errors.is_empty() && count_items(&items, "failed") == 0 {
        BackupStatus::Completed
    } else {
        BackupStatus::Failed
    };
    finish(
        app,
        &repository,
        run_id,
        job_id,
        status,
        completed_files,
        completed_bytes,
        errors,
        None,
    )
}

fn finish(
    app: &AppHandle,
    repository: &Repository,
    run_id: &str,
    job_id: &str,
    status: BackupStatus,
    copied_files: i64,
    copied_bytes: u64,
    errors: Vec<String>,
    extra_error: Option<String>,
) -> Result<BackupStatus, String> {
    let items = repository
        .list_backup_items(run_id)
        .map_err(|error| error.to_string())?;
    let summary = extra_error.or_else(|| (!errors.is_empty()).then(|| errors.join("; ")));
    repository
        .update_backup_run(
            run_id,
            job_id,
            status.clone(),
            copied_files,
            count_items(&items, "skipped"),
            count_items(&items, "failed"),
            copied_bytes as i64,
            Some(&timestamp_now()),
            summary.as_deref(),
        )
        .map_err(|error| error.to_string())?;
    emit(
        app,
        progress(
            job_id,
            match status {
                BackupStatus::Completed => "completed",
                BackupStatus::Cancelled => "cancelled",
                _ => "failed",
            },
            None,
            &items,
            copied_files,
            copied_bytes,
            Instant::now(),
            errors.clone(),
            summary.clone(),
        ),
    );
    let terminal = match status {
        BackupStatus::Completed => "completed",
        BackupStatus::Cancelled => "cancelled",
        _ => "failed",
    };
    crate::system::notify_backup_terminal(
        app,
        terminal,
        copied_files,
        summary
            .as_deref()
            .or_else(|| errors.first().map(String::as_str)),
    );
    Ok(status)
}

fn fail_run(
    repository: &Repository,
    run_id: &str,
    job_id: &str,
    message: &str,
) -> Result<BackupStatus, String> {
    let _ = repository.update_backup_run(
        run_id,
        job_id,
        BackupStatus::Failed,
        0,
        0,
        1,
        0,
        Some(&timestamp_now()),
        Some(message),
    );
    Err(message.to_owned())
}

fn cancel_remaining(repository: &Repository, items: &[BackupItem]) -> Result<(), String> {
    for item in items.iter().filter(|item| item.status == "planned") {
        repository
            .update_backup_item(&item.id, "cancelled", 0, None, Some("用户取消备份"))
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn count_items(items: &[BackupItem], status: &str) -> i64 {
    items.iter().filter(|item| item.status == status).count() as i64
}
fn sum_copied(items: &[BackupItem]) -> i64 {
    items.iter().map(|item| item.copied_bytes).sum()
}

fn progress(
    job_id: &str,
    state: &'static str,
    current_file: Option<String>,
    items: &[BackupItem],
    file_processed: i64,
    bytes_processed: u64,
    started: Instant,
    errors: Vec<String>,
    error: Option<String>,
) -> BackupProgress {
    let speed = if started.elapsed() >= Duration::from_millis(100) {
        (bytes_processed as f64 / started.elapsed().as_secs_f64()) as u64
    } else {
        0
    };
    BackupProgress {
        job_id: job_id.to_owned(),
        kind: "backup",
        seq: if state == "completed" || state == "cancelled" || state == "failed" {
            u64::MAX
        } else {
            bytes_processed
        },
        phase: if current_file
            .as_deref()
            .is_some_and(|name| name.contains("（合并"))
        {
            "merging"
        } else {
            "copying"
        },
        state,
        current_file,
        file_processed,
        file_total: items.len() as i64,
        bytes_processed: bytes_processed as i64,
        bytes_total: items
            .iter()
            .map(|item| item.size_bytes.max(0) as u64)
            .sum::<u64>() as i64,
        speed_bytes_per_sec: speed,
        eta_seconds: (speed > 0).then(|| {
            (items
                .iter()
                .filter(|item| item.status == "planned")
                .map(|item| item.size_bytes.max(0) as u64)
                .sum::<u64>()
                / speed)
                .max(0)
        }),
        errors,
        error,
    }
}

#[derive(Debug)]
pub(crate) enum CopyError {
    Cancelled,
    Message(String),
}

fn parse_merge_sources(json: Option<&str>) -> Vec<String> {
    let Some(json) = json else {
        return Vec::new();
    };
    serde_json::from_str::<Vec<String>>(json).unwrap_or_default()
}

/// Ordered source paths for a merge item. The persisted JSON is the complete
/// playback list; `source_relative` is prepended only when older rows stored
/// extra segments without repeating the head path.
fn merge_segment_relatives(source_relative: &str, json: Option<&str>) -> Vec<String> {
    let parsed = parse_merge_sources(json);
    if parsed.is_empty() {
        return Vec::new();
    }
    if parsed.iter().any(|path| path == source_relative) {
        parsed
    } else {
        let mut all = vec![source_relative.to_owned()];
        all.extend(parsed);
        all
    }
}

/// Split `(sequence, payload)` pairs into runs whose sequence numbers increase
/// by exactly one. Camera splits are consecutive file counters; a gap means a
/// different recording even if the `VID_YYYYMMDD_HHMMSS` stamp matches.
pub(crate) fn split_consecutive_runs<T>(mut parts: Vec<(u64, T)>) -> Vec<Vec<T>> {
    parts.sort_by_key(|(seq, _)| *seq);
    let mut runs = Vec::new();
    let mut current: Vec<(u64, T)> = Vec::new();
    for part in parts {
        if let Some((last_seq, _)) = current.last() {
            if part.0 != last_seq + 1 {
                if current.len() >= 2 {
                    runs.push(current.into_iter().map(|(_, value)| value).collect());
                }
                current = Vec::new();
            }
        }
        current.push(part);
    }
    if current.len() >= 2 {
        runs.push(current.into_iter().map(|(_, value)| value).collect());
    }
    runs
}

/// Windows GUI apps flash a console when spawning ffmpeg without CREATE_NO_WINDOW.
#[cfg(windows)]
fn hide_console_window(command: &mut Command) {
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn hide_console_window(_command: &mut Command) {}

/// Explicit muxer for common camera containers. ffmpeg cannot infer a format
/// from a `.camlib-part` suffix.
fn output_format_for(path: &Path) -> Option<&'static str> {
    let extension = path
        .extension()
        .map(|value| value.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    match extension.as_str() {
        "mp4" | "m4v" => Some("mp4"),
        "mov" => Some("mov"),
        "mkv" => Some("matroska"),
        "avi" => Some("avi"),
        "ts" | "mts" | "m2ts" => Some("mpegts"),
        "3gp" => Some("3gp"),
        _ => None,
    }
}

/// Windows `fs::canonicalize` returns `\\?\` prefixes that ffmpeg's concat
/// demuxer often rejects. Present DOS-style forward-slash paths instead.
pub(crate) fn ffmpeg_path_string(path: &Path) -> String {
    let value = path.to_string_lossy();
    let trimmed = value
        .strip_prefix(r"\\?\UNC\")
        .map(|rest| format!(r"\\{rest}"))
        .or_else(|| value.strip_prefix(r"\\?\").map(str::to_owned))
        .unwrap_or_else(|| value.into_owned());
    trimmed.replace('\\', "/")
}

/// Losslessly join camera-split segments with ffmpeg's concat demuxer.
/// Sources are read-only; output is written to a temp file and committed only
/// after ffmpeg succeeds. Expected size is the sum of inputs (stream copy).
pub(crate) fn merge_and_verify(
    ffmpeg: &Path,
    segments: &[PathBuf],
    destination: &Path,
    expected_size: u64,
    cancel: &AtomicBool,
    on_bytes: &mut dyn FnMut(u64),
) -> Result<u64, CopyError> {
    if segments.len() < 2 {
        return Err(CopyError::Message("合并至少需要两个分段".to_owned()));
    }
    let parent = destination
        .parent()
        .ok_or_else(|| CopyError::Message("目标路径无效".to_owned()))?;
    fs::create_dir_all(parent)
        .map_err(|error| CopyError::Message(format!("创建目标目录失败: {error}")))?;
    let dest_name = destination
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .into_owned();
    let dest_stem = destination
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy()
        .into_owned();
    let dest_extension = destination
        .extension()
        .map(|value| format!(".{}", value.to_string_lossy()))
        .unwrap_or_default();
    let list_path = parent.join(format!(".{dest_name}.camlib-concat"));
    // Keep a real media extension on the temp output so ffmpeg can infer (or we
    // can force) the muxer; a bare `.camlib-part` suffix makes ffmpeg refuse.
    let temp = parent.join(format!(".{dest_stem}.camlib-part{dest_extension}"));
    let log_path = parent.join(format!(".{dest_name}.camlib-ffmpeg.log"));
    let _ = fs::remove_file(&temp);
    let _ = fs::remove_file(&log_path);
    remove_merge_scratch(parent, &dest_stem);
    let mut temp_guard = TempGuard {
        path: temp.clone(),
        armed: true,
    };
    let list_guard = TempGuard {
        path: list_path.clone(),
        armed: true,
    };
    let log_guard = TempGuard {
        path: log_path.clone(),
        armed: true,
    };

    let mut listed = 0_u64;
    let mut list = OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .open(&list_path)
        .map_err(|error| CopyError::Message(format!("创建合并列表失败: {error}")))?;
    for segment in segments {
        let meta = fs::metadata(segment).map_err(|error| {
            CopyError::Message(format!("读取分段失败 {}: {error}", segment.display()))
        })?;
        if !meta.is_file() {
            return Err(CopyError::Message(format!(
                "分段不存在: {}",
                segment.display()
            )));
        }
        listed += meta.len();
        // concat demuxer: single-quoted forward-slash paths; double any quote.
        let escaped = ffmpeg_path_string(segment).replace('\'', "'\\''");
        writeln!(list, "file '{escaped}'")
            .map_err(|error| CopyError::Message(format!("写入合并列表失败: {error}")))?;
    }
    list.sync_all()
        .map_err(|error| CopyError::Message(format!("刷新合并列表失败: {error}")))?;
    drop(list);
    if expected_size > 0 && listed < expected_size {
        return Err(CopyError::Message("源分段大小已变化，请重新预览".to_owned()));
    }
    let expected_size = if expected_size > 0 { expected_size } else { listed };

    let mut log_file = OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .open(&log_path)
        .map_err(|error| CopyError::Message(format!("创建合并日志失败: {error}")))?;
    let mut command = Command::new(ffmpeg);
    command
        .args([
            "-nostdin",
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-f",
            "concat",
            "-safe",
            "0",
            "-i",
        ])
        .arg(ffmpeg_path_string(&list_path))
        .args(["-c", "copy"]);
    if let Some(format) = output_format_for(destination) {
        command.args(["-f", format]);
    }
    if dest_extension.eq_ignore_ascii_case(".mp4")
        || dest_extension.eq_ignore_ascii_case(".mov")
        || dest_extension.eq_ignore_ascii_case(".m4v")
    {
        command.args(["-movflags", "+faststart"]);
    }
    command
        .arg(ffmpeg_path_string(&temp))
        .stdout(Stdio::null())
        .stderr(Stdio::from(
            log_file
                .try_clone()
                .map_err(|error| CopyError::Message(format!("打开合并日志失败: {error}")))?,
        ));
    hide_console_window(&mut command);
    let mut child = command
        .spawn()
        .map_err(|error| CopyError::Message(format!("启动 ffmpeg 合并失败: {error}")))?;

    // Stream copy has no reliable byte meter; report input size as the target
    // and advance by polling the growing output plus a final full-credit step.
    on_bytes(0);
    let mut last_reported = 0_u64;
    loop {
        if cancel.load(Ordering::Relaxed) {
            let _ = child.kill();
            let _ = child.wait();
            return Err(CopyError::Cancelled);
        }
        match child.try_wait() {
            Ok(Some(status)) => {
                if !status.success() {
                    let _ = log_file.flush();
                    let detail = fs::read_to_string(&log_path)
                        .unwrap_or_default()
                        .trim()
                        .to_owned();
                    let detail = if detail.is_empty() {
                        format!("ffmpeg 退出码 {}", status)
                    } else {
                        detail
                    };
                    return Err(CopyError::Message(format!("ffmpeg 合并失败: {detail}")));
                }
                break;
            }
            Ok(None) => {
                if let Ok(meta) = fs::metadata(&temp) {
                    let written = meta.len().min(expected_size);
                    if written > last_reported {
                        last_reported = written;
                        on_bytes(written);
                    }
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(CopyError::Message(format!("等待 ffmpeg 合并失败: {error}")));
            }
        }
    }

    let merged = fs::metadata(&temp)
        .map_err(|error| CopyError::Message(format!("校验合并结果失败: {error}")))?
        .len();
    if merged == 0 {
        return Err(CopyError::Message("合并结果为空".to_owned()));
    }
    // Stream copy of same-codec segments should land near the input total; allow
    // container overhead but reject obvious truncation.
    if expected_size > 0 && merged + expected_size / 20 < expected_size {
        return Err(CopyError::Message(format!(
            "合并结果大小异常: {} 字节，期望约 {expected_size}",
            merged
        )));
    }
    if destination.exists() {
        fs::remove_file(destination)
            .map_err(|error| CopyError::Message(format!("替换冲突文件失败: {error}")))?;
    }
    fs::rename(&temp, destination)
        .map_err(|error| CopyError::Message(format!("提交合并文件失败: {error}")))?;
    temp_guard.armed = false;
    drop(list_guard);
    drop(log_guard);
    remove_merge_scratch(parent, &dest_stem);
    on_bytes(expected_size);
    Ok(merged)
}

/// Drop `.VID_….camlib-part` / `.camlib-merge` leftovers from this stem.
/// The committed file is `VID_….mp4` and does not match the scratch prefix.
fn remove_merge_scratch(parent: &Path, dest_stem: &str) {
    let prefix = format!(".{dest_stem}.camlib-");
    let Ok(entries) = fs::read_dir(parent) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with(&prefix) {
            let _ = fs::remove_file(entry.path());
        }
    }
}

struct TempGuard {
    path: PathBuf,
    armed: bool,
}

impl Drop for TempGuard {
    fn drop(&mut self) {
        if self.armed {
            let _ = fs::remove_file(&self.path);
        }
    }
}

fn copy_and_verify(
    source: &Path,
    destination: &Path,
    expected_size: u64,
    cancel: &AtomicBool,
    on_bytes: &mut dyn FnMut(u64),
) -> Result<u64, CopyError> {
    let source_file = File::open(source)
        .map_err(|error| CopyError::Message(format!("读取源文件失败: {error}")))?;
    let metadata = source_file
        .metadata()
        .map_err(|error| CopyError::Message(format!("读取源文件信息失败: {error}")))?;
    if metadata.len() != expected_size {
        return Err(CopyError::Message(
            "源文件大小已变化，请重新预览".to_owned(),
        ));
    }
    let parent = destination
        .parent()
        .ok_or_else(|| CopyError::Message("目标路径无效".to_owned()))?;
    fs::create_dir_all(parent)
        .map_err(|error| CopyError::Message(format!("创建目标目录失败: {error}")))?;
    let temp = parent.join(format!(
        ".{}.camlib-part",
        destination
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
    ));
    let _ = fs::remove_file(&temp);
    let mut temp_guard = TempGuard {
        path: temp.clone(),
        armed: true,
    };
    let mut output = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temp)
        .map_err(|error| CopyError::Message(format!("创建临时文件失败: {error}")))?;
    let mut input = source_file;
    let mut buffer = vec![0_u8; 1024 * 1024];
    let mut copied = 0_u64;
    loop {
        if cancel.load(Ordering::Relaxed) {
            drop(output);
            return Err(CopyError::Cancelled);
        }
        let read = input
            .read(&mut buffer)
            .map_err(|error| CopyError::Message(format!("读取源文件失败: {error}")))?;
        if read == 0 {
            break;
        }
        output
            .write_all(&buffer[..read])
            .map_err(|error| CopyError::Message(format!("写入目标文件失败: {error}")))?;
        copied += read as u64;
        on_bytes(copied);
    }
    output
        .sync_all()
        .map_err(|error| CopyError::Message(format!("刷新目标文件失败: {error}")))?;
    drop(output);
    if copied != expected_size
        || fs::metadata(&temp)
            .map_err(|error| CopyError::Message(format!("校验目标文件失败: {error}")))?
            .len()
            != expected_size
    {
        return Err(CopyError::Message("复制后文件大小校验失败".to_owned()));
    }
    if destination.exists() {
        fs::remove_file(destination)
            .map_err(|error| CopyError::Message(format!("替换冲突文件失败: {error}")))?;
    }
    fs::rename(&temp, destination)
        .map_err(|error| CopyError::Message(format!("提交目标文件失败: {error}")))?;
    temp_guard.armed = false;
    Ok(copied)
}

fn cleanup_temp(destination: &Path) {
    if let Some(parent) = destination.parent() {
        let _ = fs::remove_file(parent.join(format!(
                ".{}.camlib-part",
                destination
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
            )));
    }
}
fn canonical_dir(path: &Path, label: &str) -> Result<PathBuf, String> {
    fs::canonicalize(path).map_err(|error| format!("{label}不可用: {error}"))
}
fn safe_join(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let mut path = root.to_owned();
    for component in relative.replace('/', "\\").split('\\') {
        if component.is_empty() || component == "." {
            continue;
        }
        if component == ".." {
            return Err("备份相对路径无效".to_owned());
        }
        path.push(component);
    }
    if !is_same_or_child(&path, root) {
        return Err("备份路径越过目录边界".to_owned());
    }
    Ok(path)
}
fn relative_string(root: &Path, path: &Path) -> Result<String, String> {
    path.strip_prefix(root)
        .map(path_to_string)
        .map_err(|_| "目标路径越过媒体库边界".to_owned())
}
fn unique_destination(path: &Path) -> Result<PathBuf, String> {
    if !path.exists() {
        return Ok(path.to_owned());
    }
    let stem = path.file_stem().unwrap_or_default().to_string_lossy();
    let extension = path
        .extension()
        .map(|value| format!(".{}", value.to_string_lossy()))
        .unwrap_or_default();
    for index in 1..100_000 {
        let candidate = path.with_file_name(format!("{stem} ({index}){extension}"));
        if !candidate.exists() {
            return Ok(candidate);
        }
    }
    Err("无法为冲突文件生成新文件名".to_owned())
}
fn emit(app: &AppHandle, progress: BackupProgress) {
    let _ = app.emit("backup-progress", progress);
}

trait BackupItemHint {
    fn file_name_hint(&self) -> String;
}
impl BackupItemHint for BackupItem {
    fn file_name_hint(&self) -> String {
        self.source_relative
            .rsplit(['\\', '/'])
            .next()
            .unwrap_or(&self.source_relative)
            .to_owned()
    }
}

/// Camera auto-split segments share `VID_YYYYMMDD_HHMMSS` and differ only in a
/// trailing file counter (`_333`, `_334`). Different timestamps mean different
/// recordings even when the counters are consecutive.
pub(crate) fn parse_segment_key(file_name: &str) -> Option<(String, u64)> {
    let stem = file_name.rsplit_once('.').map(|(stem, _)| stem).unwrap_or(file_name);
    let (prefix, seq) = stem.rsplit_once('_')?;
    if !seq.bytes().all(|byte| byte.is_ascii_digit()) || seq.is_empty() {
        return None;
    }
    let seq = seq.parse::<u64>().ok()?;
    let mut parts = prefix.split('_');
    let _tag = parts.next()?;
    let date = parts.next()?;
    let time = parts.next()?;
    if parts.next().is_some() {
        return None;
    }
    if date.len() != 8 || !date.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    if time.len() != 6 || !time.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    Some((prefix.to_ascii_uppercase(), seq))
}

/// One continuous split keeps the timestamp as the file name. A gap in the
/// counter produces separate runs; those runs must not share one output path.
pub(crate) fn merged_output_name(
    key: &str,
    extension: &str,
    start_seq: u64,
    end_seq: u64,
    run_count: usize,
) -> String {
    if run_count <= 1 {
        format!("{key}{extension}")
    } else {
        // A bare `_{start}` would collide with the first segment's own file name.
        format!("{key}_{start_seq}-{end_seq}{extension}")
    }
}

fn file_name_from_relative(relative: &str) -> String {
    relative
        .rsplit(['\\', '/'])
        .next()
        .unwrap_or(relative)
        .to_owned()
}

fn merged_size_matches(actual: u64, expected: u64) -> bool {
    if expected == 0 {
        return actual == 0;
    }
    let slack = expected / 20;
    actual + slack >= expected && actual <= expected.saturating_add(slack)
}

/// The collapsed destination is a new file name. Re-read that path so a previous
/// merge is not planned again, and a same-named stranger stays a conflict.
fn refresh_merged_destinations(
    items: &mut [BackupItemPreviewDto],
    target_root: &Path,
) -> Result<(), BackupError> {
    for item in items
        .iter_mut()
        .filter(|item| !item.merge_sources.is_empty())
    {
        let Some(relative) = item.destination_relative.clone() else {
            continue;
        };
        let destination = safe_join(target_root, &relative).map_err(BackupError::Invalid)?;
        if !destination.exists() {
            item.status = BackupItemStatus::Ready;
            continue;
        }
        let actual = fs::metadata(&destination)
            .map_err(|error| BackupError::Io {
                path: destination,
                source: error,
            })?
            .len();
        if merged_size_matches(actual, item.size_bytes) {
            item.status = BackupItemStatus::AlreadyExists;
            item.reason = Some("合并后的视频已在媒体库中".to_owned());
        } else {
            item.status = BackupItemStatus::Conflict;
            item.reason = Some("合并目标已存在，且大小与分段合计不一致".to_owned());
        }
    }
    Ok(())
}

fn merge_group_summaries(
    items: &[BackupItemPreviewDto],
    conflict_policy: &ConflictPolicy,
) -> Vec<BackupMergeGroupDto> {
    items
        .iter()
        .filter(|item| {
            !item.merge_sources.is_empty()
                && (item.status == BackupItemStatus::Ready
                    || (item.status == BackupItemStatus::Conflict
                        && *conflict_policy != ConflictPolicy::SkipSame))
        })
        .map(|item| {
            let mut segments = vec![file_name_from_relative(&item.source_relative)];
            segments.extend(
                item.merge_sources
                    .iter()
                    .map(|path| file_name_from_relative(path)),
            );
            BackupMergeGroupDto {
                file_name: item.file_name.clone(),
                segments,
                size_bytes: item.size_bytes,
            }
        })
        .collect()
}

/// Collapse ready/conflict video items that share a segment key into a single
/// merge item. Already-exists/ignored files stay as independent rows.
fn collapse_segment_groups(items: Vec<BackupItemPreviewDto>) -> Vec<BackupItemPreviewDto> {
    let mut groups: BTreeMap<String, Vec<usize>> = BTreeMap::new();
    for (index, item) in items.iter().enumerate() {
        if item.kind.as_deref() != Some("视频") {
            continue;
        }
        if !matches!(item.status, BackupItemStatus::Ready | BackupItemStatus::Conflict) {
            continue;
        }
        let Some((key, _seq)) = parse_segment_key(&item.file_name) else {
            continue;
        };
        groups.entry(key).or_default().push(index);
    }

    let mut output: Vec<BackupItemPreviewDto> = Vec::with_capacity(items.len());
    let mut taken = vec![false; items.len()];

    for (key, indices) in groups {
        let keyed = indices
            .into_iter()
            .filter_map(|index| {
                parse_segment_key(&items[index].file_name).map(|(_, seq)| (seq, index))
            })
            .collect::<Vec<_>>();
        let candidate_runs = split_consecutive_runs(keyed);
        let mut accepted = Vec::new();
        for run in candidate_runs {
            if run.len() < 2 {
                continue;
            }
            let head = &items[run[0]];
            let extension = head.extension.to_ascii_lowercase();
            let dest_dir = head
                .destination_relative
                .as_ref()
                .and_then(|path| Path::new(path).parent().map(|parent| parent.to_path_buf()));
            if run.iter().any(|index| {
                let item = &items[*index];
                item.extension.to_ascii_lowercase() != extension
                    || item
                        .destination_relative
                        .as_ref()
                        .and_then(|path| Path::new(path).parent().map(|parent| parent.to_path_buf()))
                        != dest_dir
            }) {
                continue;
            }
            accepted.push((run, extension, dest_dir));
        }
        let run_count = accepted.len();
        for (run, extension, dest_dir) in accepted {
            let head = &items[run[0]];
            let segment_count = run.len();
            let size_bytes = run.iter().map(|index| items[*index].size_bytes).sum();
            let mut merge_sources = Vec::with_capacity(segment_count.saturating_sub(1));
            for index in run.iter().skip(1) {
                merge_sources.push(items[*index].source_relative.clone());
                taken[*index] = true;
            }
            let start_seq = parse_segment_key(&head.file_name)
                .map(|(_, seq)| seq)
                .unwrap_or(0);
            let end_seq = parse_segment_key(&items[*run.last().unwrap_or(&run[0])].file_name)
                .map(|(_, seq)| seq)
                .unwrap_or(start_seq);
            let file_name = merged_output_name(&key, &extension, start_seq, end_seq, run_count);
            let destination_relative = dest_dir.map(|dir| path_to_string(&dir.join(&file_name)));
            let mut head_item = head.clone();
            head_item.file_name = file_name;
            head_item.size_bytes = size_bytes;
            head_item.destination_relative = destination_relative;
            head_item.merge_sources = merge_sources;
            head_item.merge_group = Some(key.clone());
            head_item.reason = Some(format!("合并 {segment_count} 个相机分段视频"));
            output.push(head_item);
            taken[run[0]] = true;
        }
    }

    for (index, item) in items.into_iter().enumerate() {
        if !taken[index] {
            output.push(item);
        }
    }
    output
}

fn collect_items(
    source_root: &Path,
    dcim_path: &Path,
    target_root: &Path,
    ignore_extensions: &HashSet<String>,
) -> Result<Vec<BackupItemPreviewDto>, BackupError> {
    let mut files = Vec::new();
    collect_files(dcim_path, &mut files)?;
    files.sort_by(|left, right| left.file_name().cmp(&right.file_name()));

    files
        .into_iter()
        .map(|path| plan_item(source_root, &path, target_root, ignore_extensions))
        .collect()
}

fn collect_files(path: &Path, output: &mut Vec<PathBuf>) -> Result<(), BackupError> {
    let entries = fs::read_dir(path).map_err(|error| BackupError::Io {
        path: path.to_owned(),
        source: error,
    })?;
    for entry in entries {
        let entry = entry.map_err(|error| BackupError::Io {
            path: path.to_owned(),
            source: error,
        })?;
        let file_type = entry.file_type().map_err(|error| BackupError::Io {
            path: entry.path(),
            source: error,
        })?;
        if file_type.is_symlink() {
            continue;
        }
        if file_type.is_dir() {
            collect_files(&entry.path(), output)?;
        } else if file_type.is_file() {
            output.push(entry.path());
        }
    }
    Ok(())
}

fn plan_item(
    source_root: &Path,
    source_path: &Path,
    target_root: &Path,
    ignore_extensions: &HashSet<String>,
) -> Result<BackupItemPreviewDto, BackupError> {
    let metadata = fs::metadata(source_path).map_err(|error| BackupError::Io {
        path: source_path.to_owned(),
        source: error,
    })?;
    let file_name = source_path
        .file_name()
        .ok_or_else(|| BackupError::Invalid("相机文件缺少文件名".to_owned()))?
        .to_string_lossy()
        .into_owned();
    let extension = source_path
        .extension()
        .map(|extension| format!(".{}", extension.to_string_lossy().to_ascii_lowercase()))
        .unwrap_or_default();
    let source_relative = relative_path(source_root, source_path)?;
    if ignore_extensions.contains(&extension) {
        return Ok(BackupItemPreviewDto {
            source_relative,
            destination_relative: None,
            file_name,
            kind: None,
            capture_date: None,
            date_source: None,
            size_bytes: metadata.len(),
            extension,
            status: BackupItemStatus::Ignored,
            reason: Some("扩展名按备份设置忽略".to_owned()),
            merge_sources: Vec::new(),
            merge_group: None,
        });
    }
    let kind = if PHOTO_EXTENSIONS.contains(&extension.as_str()) {
        "照片"
    } else if VIDEO_EXTENSIONS.contains(&extension.as_str()) {
        "视频"
    } else {
        return Ok(BackupItemPreviewDto {
            source_relative,
            destination_relative: None,
            file_name,
            kind: None,
            capture_date: None,
            date_source: None,
            size_bytes: metadata.len(),
            extension,
            status: BackupItemStatus::Ignored,
            reason: Some("不支持的媒体扩展名".to_owned()),
            merge_sources: Vec::new(),
            merge_group: None,
        });
    };

    let (capture_date, date_source) = capture_date(&file_name, &metadata)
        .map(|(date, source)| (Some(date), Some(source)))
        .unwrap_or((None, None));
    let destination_relative = capture_date.as_ref().map(|date| {
        let year = &date[0..4];
        let month = &date[5..7];
        PathBuf::from(year)
            .join(month)
            .join(date)
            .join(kind)
            .join(&file_name)
    });
    let Some(destination_relative_path) = destination_relative else {
        return Ok(BackupItemPreviewDto {
            source_relative,
            destination_relative: None,
            file_name,
            kind: Some(kind.to_owned()),
            capture_date: None,
            date_source: None,
            size_bytes: metadata.len(),
            extension,
            status: BackupItemStatus::Ignored,
            reason: Some("无法确定拍摄日期".to_owned()),
            merge_sources: Vec::new(),
            merge_group: None,
        });
    };
    let destination_path = target_root.join(&destination_relative_path);
    // `backup_camera.ps1` wrote files to `YYYY-MM-DD\\类型` before the
    // current `YYYY\\MM\\YYYY-MM-DD\\类型` layout. Treat a byte-identical
    // file in either layout as already backed up, but never mutate the legacy
    // layout during a camera import.
    let legacy_relative_path = PathBuf::from(capture_date.as_deref().expect("date is present"))
        .join(kind)
        .join(&file_name);
    let legacy_destination_path = target_root.join(&legacy_relative_path);
    let (destination_relative_path, status) =
        if destination_path.exists() && same_size(metadata.len(), &destination_path)? {
            (destination_relative_path, BackupItemStatus::AlreadyExists)
        } else if legacy_destination_path.exists()
            && same_size(metadata.len(), &legacy_destination_path)?
        {
            (legacy_relative_path, BackupItemStatus::AlreadyExists)
        } else if destination_path.exists() {
            (destination_relative_path, BackupItemStatus::Conflict)
        } else {
            (destination_relative_path, BackupItemStatus::Ready)
        };
    Ok(BackupItemPreviewDto {
        source_relative,
        destination_relative: Some(path_to_string(&destination_relative_path)),
        file_name,
        kind: Some(kind.to_owned()),
        capture_date,
        date_source,
        size_bytes: metadata.len(),
        extension,
        status,
        reason: None,
        merge_sources: Vec::new(),
        merge_group: None,
    })
}

/// Match the original camera-backup policy: a file at the planned destination
/// with the same size is considered already backed up. Preview stays metadata
/// only, so a card containing large videos never needs to read them all again.
fn same_size(expected_size: u64, candidate: &Path) -> Result<bool, BackupError> {
    fs::metadata(candidate)
        .map(|metadata| metadata.len() == expected_size)
        .map_err(|error| BackupError::Io {
            path: candidate.to_owned(),
            source: error,
        })
}

fn capture_date(file_name: &str, metadata: &fs::Metadata) -> Option<(String, String)> {
    let bytes = file_name.as_bytes();
    for start in 0..bytes.len().saturating_sub(7) {
        if !bytes[start..start + 8].iter().all(u8::is_ascii_digit) {
            continue;
        }
        let date = std::str::from_utf8(&bytes[start..start + 8]).ok()?;
        if valid_date_digits(date) {
            return Some((
                format!("{}-{}-{}", &date[0..4], &date[4..6], &date[6..8]),
                "filename".to_owned(),
            ));
        }
    }
    let modified = metadata.modified().ok()?;
    Some((date_from_system_time(modified)?, "file_time".to_owned()))
}

fn valid_date_digits(date: &str) -> bool {
    if date.len() != 8 || !date.bytes().all(|byte| byte.is_ascii_digit()) {
        return false;
    }
    let year = date[0..4].parse::<u32>().ok();
    let month = date[4..6].parse::<u32>().ok();
    let day = date[6..8].parse::<u32>().ok();
    matches!((year, month, day), (Some(year), Some(month), Some(day)) if (1970..=2100).contains(&year) && (1..=12).contains(&month) && (1..=days_in_month(year, month)).contains(&day))
}

fn days_in_month(year: u32, month: u32) -> u32 {
    match month {
        2 if year % 400 == 0 || (year % 4 == 0 && year % 100 != 0) => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    }
}

fn date_from_system_time(time: SystemTime) -> Option<String> {
    let seconds = time.duration_since(UNIX_EPOCH).ok()?.as_secs() as i64;
    let days = seconds.div_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    Some(format!("{year:04}-{month:02}-{day:02}"))
}

// Howard Hinnant's Gregorian calendar conversion, kept local to avoid a
// heavyweight date dependency for a date-only backup planner.
fn civil_from_days(days: i64) -> (i32, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = mp + if mp < 10 { 3 } else { -9 };
    let year = y + if month <= 2 { 1 } else { 0 };
    (year as i32, month as u32, day as u32)
}

fn normalize_extensions(values: Vec<String>) -> HashSet<String> {
    values
        .into_iter()
        .map(|value| {
            let value = value.trim().to_ascii_lowercase();
            if value.starts_with('.') {
                value
            } else {
                format!(".{value}")
            }
        })
        .filter(|value| value.len() > 1)
        .collect()
}

fn sorted_extensions(values: &HashSet<String>) -> Vec<String> {
    let mut values = values.iter().cloned().collect::<Vec<_>>();
    values.sort();
    values
}

fn relative_path(root: &Path, path: &Path) -> Result<String, BackupError> {
    path.strip_prefix(root)
        .map(path_to_string)
        .map_err(|_| BackupError::Invalid(format!("源文件越过源盘边界: {}", path.display())))
}

fn path_to_string(path: &Path) -> String {
    path.to_string_lossy().replace('/', "\\")
}

fn is_same_or_child(path: &Path, root: &Path) -> bool {
    path == root || path.strip_prefix(root).is_ok()
}

fn count_status(items: &[BackupItemPreviewDto], status: BackupItemStatus) -> u64 {
    items.iter().filter(|item| item.status == status).count() as u64
}

fn volume_dto(candidate: &VolumeCandidate) -> BackupVolumeDto {
    let root_path = path_to_string(&candidate.root_path);
    let id = candidate
        .volume_id
        .clone()
        .unwrap_or_else(|| stable_id(&root_path));
    BackupVolumeDto {
        id,
        root_path,
        dcim_path: path_to_string(&candidate.dcim_path),
        volume_label: candidate.volume_label.clone(),
        drive_letter: candidate.drive_letter.clone(),
        removable: candidate.removable,
    }
}

fn stable_id(value: &str) -> String {
    let mut hash = 0xcbf29ce484222325_u64;
    for byte in value.to_ascii_lowercase().as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("volume-{hash:016x}")
}

fn next_id(prefix: &str) -> String {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!(
        "{prefix}-{stamp}-{}",
        NEXT_BACKUP.fetch_add(1, Ordering::Relaxed)
    )
}

fn timestamp_now() -> String {
    format!(
        "unix-ms:{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
    )
}

fn discover_candidates() -> Vec<VolumeCandidate> {
    #[cfg(windows)]
    {
        return windows_candidates();
    }
    #[cfg(not(windows))]
    {
        Vec::new()
    }
}

#[cfg(windows)]
fn windows_candidates() -> Vec<VolumeCandidate> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{GetDriveTypeW, GetLogicalDrives};
    let mask = unsafe { GetLogicalDrives() };
    let mut result = Vec::new();
    for index in 0..26 {
        if mask & (1 << index) == 0 {
            continue;
        }
        let letter = (b'A' + index as u8) as char;
        let root = PathBuf::from(format!("{letter}:\\"));
        let wide: Vec<u16> = root.as_os_str().encode_wide().chain(Some(0)).collect();
        if unsafe { GetDriveTypeW(wide.as_ptr()) } != 2 {
            continue;
        }
        let Ok(dcim_path) = find_dcim(&root) else {
            continue;
        };
        let (volume_label, volume_id) = windows_volume_identity(&wide);
        result.push(VolumeCandidate {
            root_path: root,
            dcim_path,
            volume_id,
            volume_label,
            drive_letter: Some(letter.to_string()),
            removable: true,
        });
    }
    result
}

#[cfg(windows)]
fn windows_volume_identity(root: &[u16]) -> (Option<String>, Option<String>) {
    use windows_sys::Win32::Storage::FileSystem::GetVolumeInformationW;
    let mut label = [0u16; 261];
    let mut serial = 0u32;
    let mut max_component = 0u32;
    let mut flags = 0u32;
    let success = unsafe {
        GetVolumeInformationW(
            root.as_ptr(),
            label.as_mut_ptr(),
            label.len() as u32,
            &mut serial,
            &mut max_component,
            &mut flags,
            std::ptr::null_mut(),
            0,
        )
    };
    if success == 0 {
        return (None, None);
    }
    let length = label
        .iter()
        .position(|value| *value == 0)
        .unwrap_or(label.len());
    (
        Some(String::from_utf16_lossy(&label[..length])),
        Some(format!("serial-{serial:08x}")),
    )
}

fn find_dcim(root: &Path) -> Result<PathBuf, BackupError> {
    let entries = fs::read_dir(root).map_err(|error| BackupError::Io {
        path: root.to_owned(),
        source: error,
    })?;
    for entry in entries {
        let entry = entry.map_err(|error| BackupError::Io {
            path: root.to_owned(),
            source: error,
        })?;
        if entry
            .file_type()
            .map_err(|error| BackupError::Io {
                path: entry.path(),
                source: error,
            })?
            .is_dir()
            && entry
                .file_name()
                .to_string_lossy()
                .eq_ignore_ascii_case("DCIM")
        {
            return Ok(entry.path());
        }
    }
    Err(BackupError::Invalid("卷中没有 DCIM 目录".to_owned()))
}

#[cfg(windows)]
fn available_space(path: &Path) -> Option<u64> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
    let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    let mut free = 0u64;
    let mut total = 0u64;
    let mut available = 0u64;
    let success =
        unsafe { GetDiskFreeSpaceExW(wide.as_ptr(), &mut available, &mut total, &mut free) };
    (success != 0).then_some(available)
}

#[cfg(not(windows))]
fn available_space(_path: &Path) -> Option<u64> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{LibraryState, NewLibrary};
    use std::fs;
    use tempfile::TempDir;

    fn library(repository: &Repository, root: &Path) {
        repository
            .create_library(NewLibrary {
                id: "library-test".to_owned(),
                root_path: root.to_string_lossy().into_owned(),
                volume_id: None,
                volume_label: Some("测试媒体库".to_owned()),
                drive_letter: None,
                state: LibraryState::Available,
                last_seen_at: None,
                last_scan_at: None,
                scan_generation: 0,
                created_at: timestamp_now(),
                updated_at: timestamp_now(),
            })
            .unwrap();
    }

    fn source_candidate(root: &Path) -> VolumeCandidate {
        VolumeCandidate {
            root_path: root.to_owned(),
            dcim_path: root.join("DCIM"),
            volume_id: Some("test-camera".to_owned()),
            volume_label: Some("TEST-CAMERA".to_owned()),
            drive_letter: None,
            removable: true,
        }
    }

    fn write(path: &Path, bytes: &[u8]) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, bytes).unwrap();
    }

    #[test]
    fn preview_classifies_duplicates_conflicts_ignored_and_filename_dates_without_writing() {
        let source = TempDir::new().unwrap();
        let target = TempDir::new().unwrap();
        let repository = Repository::open_in_memory().unwrap();
        library(&repository, target.path());
        write(
            &source.path().join("DCIM/100MEDIA/IMG_20240102_123456.JPG"),
            b"same",
        );
        write(
            &source.path().join("DCIM/100MEDIA/VID_20240102_123500.MP4"),
            b"different",
        );
        write(
            &source.path().join("DCIM/100MEDIA/RAW_20240102_123501.DNG"),
            b"raw",
        );
        write(&source.path().join("DCIM/100MEDIA/notes.txt"), b"ignored");
        write(
            &target
                .path()
                .join("2024/01/2024-01-02/照片/IMG_20240102_123456.JPG"),
            b"same",
        );
        write(
            &target
                .path()
                .join("2024/01/2024-01-02/视频/VID_20240102_123500.MP4"),
            b"other",
        );
        let source_before =
            fs::read(source.path().join("DCIM/100MEDIA/VID_20240102_123500.MP4")).unwrap();

        let preview = preview_paths(
            &repository,
            source_candidate(source.path()),
            target.path().to_string_lossy().into_owned(),
            "library-test".to_owned(),
            ConflictPolicy::SkipSame,
            None,
            Some(5),
            Some(true),
        )
        .unwrap();

        assert_eq!(preview.already_exists_files, 1);
        assert_eq!(preview.conflict_files, 1);
        assert_eq!(preview.ignored_files, 2);
        assert_eq!(preview.ready_files, 0);
        assert_eq!(preview.space_sufficient, Some(true));
        assert!(preview
            .items
            .iter()
            .any(|item| item.date_source.as_deref() == Some("filename")));
        assert_eq!(
            fs::read(source.path().join("DCIM/100MEDIA/VID_20240102_123500.MP4")).unwrap(),
            source_before
        );
        assert!(!target
            .path()
            .join("2024/01/2024-01-02/视频/RAW_20240102_123501.DNG")
            .exists());
        assert!(repository
            .get_backup_run(&preview.backup_run_id)
            .unwrap()
            .is_some());
    }

    #[test]
    fn preview_falls_back_to_file_time_and_normalizes_ignore_configuration() {
        let source = TempDir::new().unwrap();
        let target = TempDir::new().unwrap();
        let repository = Repository::open_in_memory().unwrap();
        library(&repository, target.path());
        write(&source.path().join("DCIM/NO_DATE/clip.MOV"), b"video");
        write(
            &source.path().join("DCIM/NO_DATE/IMG_20240231_120000.JPG"),
            b"photo",
        );
        let preview = preview_paths(
            &repository,
            source_candidate(source.path()),
            target.path().to_string_lossy().into_owned(),
            "library-test".to_owned(),
            ConflictPolicy::SkipSame,
            Some(vec!["LRV".to_owned()]),
            Some(u64::MAX),
            Some(false),
        )
        .unwrap();
        let item = preview
            .items
            .iter()
            .find(|item| item.file_name == "clip.MOV")
            .unwrap();
        assert_eq!(item.date_source.as_deref(), Some("file_time"));
        let invalid_date_item = preview
            .items
            .iter()
            .find(|item| item.file_name == "IMG_20240231_120000.JPG")
            .unwrap();
        assert_eq!(invalid_date_item.date_source.as_deref(), Some("file_time"));
        assert_eq!(preview.ignore_extensions, vec![".lrv"]);
        assert!(preview.space_sufficient == Some(true));
    }

    #[test]
    fn preview_recognizes_byte_identical_legacy_backup_without_migrating_it() {
        let source = TempDir::new().unwrap();
        let target = TempDir::new().unwrap();
        let repository = Repository::open_in_memory().unwrap();
        library(&repository, target.path());
        let source_file = source.path().join("DCIM/100MEDIA/IMG_20240102_123456.JPG");
        let legacy_file = target
            .path()
            .join("2024-01-02/照片/IMG_20240102_123456.JPG");
        write(&source_file, b"legacy-copy");
        write(&legacy_file, b"legacy-copy");

        let preview = preview_paths(
            &repository,
            source_candidate(source.path()),
            target.path().to_string_lossy().into_owned(),
            "library-test".to_owned(),
            ConflictPolicy::SkipSame,
            None,
            Some(u64::MAX),
            Some(false),
        )
        .unwrap();

        let item = preview
            .items
            .iter()
            .find(|item| item.file_name == "IMG_20240102_123456.JPG")
            .unwrap();
        assert_eq!(item.status, BackupItemStatus::AlreadyExists);
        assert_eq!(
            item.destination_relative.as_deref(),
            Some("2024-01-02\\照片\\IMG_20240102_123456.JPG")
        );
        assert!(legacy_file.exists());
        assert!(!target
            .path()
            .join("2024/01/2024-01-02/照片/IMG_20240102_123456.JPG")
            .exists());
    }

    #[test]
    fn same_size_matches_the_original_fast_duplicate_policy() {
        let directory = TempDir::new().unwrap();
        let candidate = directory.path().join("candidate.bin");
        write(&candidate, b"different");
        assert!(same_size(9, &candidate).unwrap());
        assert!(!same_size(8, &candidate).unwrap());
    }

    #[test]
    fn parse_segment_key_groups_same_timestamp_and_rejects_different_ones() {
        let (key_a, seq_a) = parse_segment_key("VID_20261001_153408_333.mp4").unwrap();
        let (key_b, seq_b) = parse_segment_key("VID_20261001_153408_334.mp4").unwrap();
        assert_eq!(key_a, "VID_20261001_153408");
        assert_eq!(key_a, key_b);
        assert_eq!((seq_a, seq_b), (333, 334));

        let (key_c, _) = parse_segment_key("VID_20260816_150035_122.mp4").unwrap();
        let (key_d, _) = parse_segment_key("VID_20260816_150534_123.mp4").unwrap();
        assert_ne!(key_c, key_d);

        assert!(parse_segment_key("IMG_20240102_123456.JPG").is_none());
        assert!(parse_segment_key("VID_20261001_153408.mp4").is_none());
        assert!(parse_segment_key("VID_2026101_153408_333.mp4").is_none());
    }

    #[test]
    fn ffmpeg_path_string_strips_extended_prefix_and_uses_forward_slashes() {
        assert_eq!(
            ffmpeg_path_string(Path::new(r"\\?\H:\DCIM-local\2026\视频\a.mp4")),
            "H:/DCIM-local/2026/视频/a.mp4"
        );
        assert_eq!(
            ffmpeg_path_string(Path::new(r"\\?\UNC\server\share\a.mp4")),
            "//server/share/a.mp4"
        );
        assert_eq!(
            ffmpeg_path_string(Path::new(r"H:\plain\a.mp4")),
            "H:/plain/a.mp4"
        );
    }

    #[test]
    fn output_format_for_maps_camera_containers() {
        assert_eq!(
            output_format_for(Path::new("VID_x.mp4")),
            Some("mp4")
        );
        assert_eq!(
            output_format_for(Path::new("VID_x.MOV")),
            Some("mov")
        );
        assert_eq!(output_format_for(Path::new("clip.bin")), None);
    }

    #[test]
    fn collapse_segment_groups_merges_same_timestamp_only() {
        let base = |name: &str, size: u64, dest: &str| BackupItemPreviewDto {
            source_relative: format!("DCIM\\100MEDIA\\{name}"),
            destination_relative: Some(dest.to_owned()),
            file_name: name.to_owned(),
            kind: Some("视频".to_owned()),
            capture_date: Some("2026-10-01".to_owned()),
            date_source: Some("filename".to_owned()),
            size_bytes: size,
            extension: ".mp4".to_owned(),
            status: BackupItemStatus::Ready,
            reason: None,
            merge_sources: Vec::new(),
            merge_group: None,
        };
        let items = vec![
            base(
                "VID_20261001_153408_333.mp4",
                10,
                "2026/10/2026-10-01/视频/VID_20261001_153408_333.mp4",
            ),
            base(
                "VID_20261001_153408_334.mp4",
                20,
                "2026/10/2026-10-01/视频/VID_20261001_153408_334.mp4",
            ),
            base(
                "VID_20260816_150035_122.mp4",
                5,
                "2026/08/2026-08-16/视频/VID_20260816_150035_122.mp4",
            ),
            base(
                "VID_20260816_150534_123.mp4",
                6,
                "2026/08/2026-08-16/视频/VID_20260816_150534_123.mp4",
            ),
            base(
                "VID_20261001_144056_327.mp4",
                3,
                "2026/10/2026-10-01/视频/VID_20261001_144056_327.mp4",
            ),
            base(
                "VID_20261001_144056_328.mp4",
                4,
                "2026/10/2026-10-01/视频/VID_20261001_144056_328.mp4",
            ),
        ];
        let collapsed = collapse_segment_groups(items);
        assert_eq!(collapsed.len(), 4);

        let merged = collapsed
            .iter()
            .find(|item| item.file_name == "VID_20261001_153408.mp4")
            .unwrap();
        assert_eq!(merged.size_bytes, 30);
        assert_eq!(merged.merge_sources.len(), 1);
        assert_eq!(
            merged.destination_relative.as_deref(),
            Some("2026\\10\\2026-10-01\\视频\\VID_20261001_153408.mp4")
        );

        let merged_327 = collapsed
            .iter()
            .find(|item| item.file_name == "VID_20261001_144056.mp4")
            .unwrap();
        assert_eq!(merged_327.size_bytes, 7);

        assert!(collapsed
            .iter()
            .any(|item| item.file_name == "VID_20260816_150035_122.mp4"));
        assert!(collapsed
            .iter()
            .any(|item| item.file_name == "VID_20260816_150534_123.mp4"));
    }

    #[test]
    fn merge_segment_relatives_does_not_duplicate_the_head_path() {
        let head = "DCIM\\100MEDIA\\VID_20261001_153408_333.mp4";
        let extra = "DCIM\\100MEDIA\\VID_20261001_153408_334.mp4";
        let complete = serde_json::to_string(&vec![head, extra]).unwrap();
        let extras_only = serde_json::to_string(&vec![extra]).unwrap();
        assert_eq!(
            merge_segment_relatives(head, Some(&complete)),
            vec![head.to_owned(), extra.to_owned()]
        );
        assert_eq!(
            merge_segment_relatives(head, Some(&extras_only)),
            vec![head.to_owned(), extra.to_owned()]
        );
        assert!(merge_segment_relatives(head, None).is_empty());
    }

    #[test]
    fn collapse_skips_nonconsecutive_sequence_numbers() {
        let base = |name: &str, dest: &str| BackupItemPreviewDto {
            source_relative: format!("DCIM\\100MEDIA\\{name}"),
            destination_relative: Some(dest.to_owned()),
            file_name: name.to_owned(),
            kind: Some("视频".to_owned()),
            capture_date: Some("2026-10-01".to_owned()),
            date_source: Some("filename".to_owned()),
            size_bytes: 10,
            extension: ".mp4".to_owned(),
            status: BackupItemStatus::Ready,
            reason: None,
            merge_sources: Vec::new(),
            merge_group: None,
        };
        let items = vec![
            base(
                "VID_20261001_153408_333.mp4",
                "2026/10/2026-10-01/视频/VID_20261001_153408_333.mp4",
            ),
            base(
                "VID_20261001_153408_335.mp4",
                "2026/10/2026-10-01/视频/VID_20261001_153408_335.mp4",
            ),
        ];
        let collapsed = collapse_segment_groups(items);
        assert_eq!(collapsed.len(), 2);
        assert!(collapsed.iter().all(|item| item.merge_sources.is_empty()));
    }

    #[test]
    fn collapse_joins_three_consecutive_segments_and_splits_a_counter_gap() {
        let base = |name: &str| BackupItemPreviewDto {
            source_relative: format!("DCIM\\100MEDIA\\{name}"),
            destination_relative: Some(format!("2026/10/2026-10-01/视频/{name}")),
            file_name: name.to_owned(),
            kind: Some("视频".to_owned()),
            capture_date: Some("2026-10-01".to_owned()),
            date_source: Some("filename".to_owned()),
            size_bytes: 10,
            extension: ".mp4".to_owned(),
            status: BackupItemStatus::Ready,
            reason: None,
            merge_sources: Vec::new(),
            merge_group: None,
        };
        let continuous = collapse_segment_groups(vec![
            base("VID_20261001_153408_333.mp4"),
            base("VID_20261001_153408_334.mp4"),
            base("VID_20261001_153408_335.mp4"),
        ]);
        assert_eq!(continuous.len(), 1);
        assert_eq!(continuous[0].file_name, "VID_20261001_153408.mp4");
        assert_eq!(continuous[0].merge_sources.len(), 2);
        assert_eq!(continuous[0].size_bytes, 30);

        let gapped = collapse_segment_groups(vec![
            base("VID_20261001_153408_333.mp4"),
            base("VID_20261001_153408_334.mp4"),
            base("VID_20261001_153408_336.mp4"),
            base("VID_20261001_153408_337.mp4"),
        ]);
        assert_eq!(gapped.len(), 2);
        let names = gapped
            .iter()
            .map(|item| item.file_name.as_str())
            .collect::<Vec<_>>();
        assert!(names.contains(&"VID_20261001_153408_333-334.mp4"));
        assert!(names.contains(&"VID_20261001_153408_336-337.mp4"));
        assert_ne!(
            gapped[0].destination_relative,
            gapped[1].destination_relative
        );
    }

    #[test]
    fn preview_treats_an_existing_merged_file_as_already_backed_up() {
        let source = TempDir::new().unwrap();
        let target = TempDir::new().unwrap();
        let repository = Repository::open_in_memory().unwrap();
        library(&repository, target.path());
        write(
            &source
                .path()
                .join("DCIM/100MEDIA/VID_20261001_153408_333.mp4"),
            &vec![1_u8; 10],
        );
        write(
            &source
                .path()
                .join("DCIM/100MEDIA/VID_20261001_153408_334.mp4"),
            &vec![2_u8; 20],
        );
        write(
            &target
                .path()
                .join("2026/10/2026-10-01/视频/VID_20261001_153408.mp4"),
            &vec![0_u8; 30],
        );

        let preview = preview_paths(
            &repository,
            source_candidate(source.path()),
            target.path().to_string_lossy().into_owned(),
            "library-test".to_owned(),
            ConflictPolicy::SkipSame,
            None,
            Some(u64::MAX),
            Some(true),
        )
        .unwrap();

        assert_eq!(preview.merge_group_count, 0);
        let merged = preview
            .items
            .iter()
            .find(|item| item.file_name == "VID_20261001_153408.mp4")
            .unwrap();
        assert_eq!(merged.status, BackupItemStatus::AlreadyExists);
        assert_eq!(preview.ready_files, 0);
    }

    #[test]
    fn preview_reports_merge_groups_and_persists_merge_sources() {
        let source = TempDir::new().unwrap();
        let target = TempDir::new().unwrap();
        let repository = Repository::open_in_memory().unwrap();
        library(&repository, target.path());
        write(
            &source
                .path()
                .join("DCIM/100MEDIA/VID_20261001_153408_333.mp4"),
            &vec![1_u8; 10],
        );
        write(
            &source
                .path()
                .join("DCIM/100MEDIA/VID_20261001_153408_334.mp4"),
            &vec![2_u8; 20],
        );
        write(
            &source
                .path()
                .join("DCIM/100MEDIA/VID_20260816_150035_122.mp4"),
            &vec![3_u8; 5],
        );

        let preview = preview_paths(
            &repository,
            source_candidate(source.path()),
            target.path().to_string_lossy().into_owned(),
            "library-test".to_owned(),
            ConflictPolicy::SkipSame,
            None,
            Some(u64::MAX),
            Some(true),
        )
        .unwrap();

        assert_eq!(preview.merge_segments, true);
        assert_eq!(preview.merge_group_count, 1);
        assert_eq!(preview.merge_segment_count, 2);
        assert_eq!(preview.ready_files, 2);
        assert_eq!(preview.total_bytes, 35);

        let items = repository.list_backup_items(&preview.backup_run_id).unwrap();
        let merge_item = items
            .iter()
            .find(|item| item.source_relative.contains("VID_20261001_153408_333"))
            .unwrap();
        let sources: Vec<String> =
            serde_json::from_str(merge_item.merge_sources_json.as_deref().unwrap()).unwrap();
        assert_eq!(sources.len(), 2);
        assert!(sources[0].contains("333"));
        assert!(sources[1].contains("334"));
    }

    #[test]
    fn preview_rejects_target_inside_camera_source() {
        let source = TempDir::new().unwrap();
        let repository = Repository::open_in_memory().unwrap();
        let target = source.path().join("target");
        fs::create_dir_all(&target).unwrap();
        library(&repository, &target);
        fs::create_dir_all(source.path().join("DCIM")).unwrap();
        let error = preview_paths(
            &repository,
            source_candidate(source.path()),
            source.path().join("target").to_string_lossy().into_owned(),
            "library-test".to_owned(),
            ConflictPolicy::SkipSame,
            None,
            Some(0),
            Some(true),
        )
        .unwrap_err();
        assert!(error.to_string().contains("不能位于相机源盘内"));
    }

    #[test]
    fn temp_source_and_target_execute_copy_verify_and_keep_source_read_only() {
        let source = TempDir::new().unwrap();
        let target = TempDir::new().unwrap();
        let source_file = source.path().join("DCIM/100MEDIA/IMG_20250101_000000.JPG");
        let destination = target
            .path()
            .join("2025/01/2025-01-01/照片/IMG_20250101_000000.JPG");
        let content = vec![42_u8; 2 * 1024 * 1024 + 17];
        write(&source_file, &content);
        let source_before = fs::read(&source_file).unwrap();
        let cancel = AtomicBool::new(false);
        let mut progress_calls = 0_u32;
        let copied = copy_and_verify(
            &source_file,
            &destination,
            content.len() as u64,
            &cancel,
            &mut |_| progress_calls += 1,
        )
        .unwrap();
        assert_eq!(copied, content.len() as u64);
        assert!(progress_calls > 0);
        assert_eq!(fs::read(&destination).unwrap(), content);
        assert_eq!(fs::read(&source_file).unwrap(), source_before);

        let cancelled_destination = target.path().join("cancelled/file.JPG");
        let cancelled = AtomicBool::new(true);
        assert!(matches!(
            copy_and_verify(
                &source_file,
                &cancelled_destination,
                content.len() as u64,
                &cancelled,
                &mut |_| {}
            ),
            Err(CopyError::Cancelled)
        ));
        assert!(!cancelled_destination.exists());
        assert_eq!(fs::read(&source_file).unwrap(), source_before);
    }

    #[test]
    fn rename_conflict_never_overwrites_existing_target() {
        let source = TempDir::new().unwrap();
        let target = TempDir::new().unwrap();
        let source_file = source.path().join("source.JPG");
        let destination = target.path().join("photo.JPG");
        write(&source_file, b"new");
        write(&destination, b"old");
        let renamed = unique_destination(&destination).unwrap();
        copy_and_verify(
            &source_file,
            &renamed,
            3,
            &AtomicBool::new(false),
            &mut |_| {},
        )
        .unwrap();
        assert_eq!(fs::read(&destination).unwrap(), b"old");
        assert_eq!(fs::read(renamed).unwrap(), b"new");
    }
}
