//! One-shot maintenance: join camera-split video segments already inside the
//! media library. Preview is read-only; execution writes a merged temp file,
//! verifies it, then optionally recycles the original segments.

use crate::backup::{
    merge_and_verify, merged_output_name, parse_segment_key, split_consecutive_runs, CopyError,
};
use crate::db::Repository;
use crate::deletion::send_to_recycle_bin;
use crate::media::resolve_ffmpeg;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};

static NEXT_JOB: AtomicU64 = AtomicU64::new(1);

fn next_job_id() -> String {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!(
        "library-merge-{stamp}-{}",
        NEXT_JOB.fetch_add(1, Ordering::Relaxed)
    )
}

#[derive(Debug, Clone)]
pub struct LibraryMergeManagerState {
    jobs: Arc<Mutex<Vec<Arc<AtomicBool>>>>,
}

impl LibraryMergeManagerState {
    pub fn new() -> Self {
        Self {
            jobs: Arc::new(Mutex::new(Vec::new())),
        }
    }

    pub fn start(&self) -> Result<(String, Arc<AtomicBool>), crate::errors::AppError> {
        let mut jobs = self
            .jobs
            .lock()
            .map_err(|_| crate::errors::AppError::internal("分段整理任务状态锁已损坏"))?;
        if !jobs.is_empty() {
            return Err(crate::errors::AppError::job_already_running(
                "已有分段整理任务正在运行",
            ));
        }
        let job_id = next_job_id();
        let cancel = Arc::new(AtomicBool::new(false));
        jobs.push(cancel.clone());
        Ok((job_id, cancel))
    }

    pub fn cancel(&self, _job_id: &str) -> Result<(), crate::errors::AppError> {
        let jobs = self
            .jobs
            .lock()
            .map_err(|_| crate::errors::AppError::internal("分段整理任务状态锁已损坏"))?;
        let Some(job) = jobs.first() else {
            return Err(crate::errors::AppError::job_not_found("分段整理任务不存在"));
        };
        job.store(true, Ordering::Relaxed);
        Ok(())
    }

    pub fn finish(&self) {
        if let Ok(mut jobs) = self.jobs.lock() {
            jobs.clear();
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LibraryMergeGroupDto {
    pub group_key: String,
    pub file_name: String,
    /// Source relative paths in playback order, including the first segment.
    pub sources: Vec<String>,
    pub size_bytes: u64,
    pub destination_relative: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LibraryMergePreviewDto {
    pub library_id: String,
    pub groups: Vec<LibraryMergeGroupDto>,
    pub group_count: u64,
    pub segment_count: u64,
    pub total_bytes: u64,
    /// Extra space for every merged output. Sources stay until an optional recycle,
    /// so the new files can all exist at once; only one ffmpeg temp is open at a time.
    pub required_temp_bytes: u64,
    pub free_bytes: Option<u64>,
    pub space_sufficient: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryMergeProgress {
    pub job_id: String,
    pub kind: &'static str,
    pub seq: u64,
    pub phase: &'static str,
    pub state: &'static str,
    pub current_file: Option<String>,
    pub group_processed: i64,
    pub group_total: i64,
    pub bytes_processed: i64,
    pub bytes_total: i64,
    pub speed_bytes_per_sec: u64,
    pub eta_seconds: Option<u64>,
    pub errors: Vec<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryMergeStartDto {
    pub job_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryMergeResultDto {
    pub job_id: String,
    pub groups_merged: u64,
    pub segments_recycled: u64,
    pub segments_kept: u64,
    pub failed_groups: u64,
    pub errors: Vec<String>,
    pub cancelled: bool,
}

/// Discover mergeable segment groups under the library root. Read-only.
pub fn preview(
    repository: &Repository,
    library_id: &str,
) -> Result<LibraryMergePreviewDto, crate::errors::AppError> {
    let root = library_root(repository, library_id)?;
    let groups = discover_groups(&root)?;
    let group_count = groups.len() as u64;
    let segment_count = groups.iter().map(|group| group.sources.len() as u64).sum();
    let total_bytes = groups.iter().map(|group| group.size_bytes).sum();
    let required_temp_bytes = total_bytes;
    let free_bytes = available_space(&root);
    Ok(LibraryMergePreviewDto {
        library_id: library_id.to_owned(),
        groups,
        group_count,
        segment_count,
        total_bytes,
        required_temp_bytes,
        free_bytes,
        space_sufficient: free_bytes.map(|free| free >= required_temp_bytes),
    })
}

pub fn spawn(
    app: AppHandle,
    manager: Arc<LibraryMergeManagerState>,
    scan_manager: Arc<crate::scanner::ScanManagerState>,
    database_path: PathBuf,
    library_id: String,
    job_id: String,
    cancel: Arc<AtomicBool>,
    recycle_sources: bool,
    destinations: Option<Vec<String>>,
) {
    std::thread::spawn(move || {
        let result = run(
            &app,
            &database_path,
            &library_id,
            &job_id,
            &cancel,
            recycle_sources,
            destinations.as_deref(),
        );
        match &result {
            Ok(done) => {
                if done.groups_merged > 0 {
                    if let Ok((scan_job, scan_cancel)) = scan_manager.start(&library_id) {
                        crate::scanner::spawn_scan(
                            app.clone(),
                            scan_manager.clone(),
                            database_path.clone(),
                            library_id.clone(),
                            scan_job,
                            scan_cancel,
                            false,
                        );
                    }
                }
            }
            Err(error) => {
                emit(
                    &app,
                    progress(
                        &job_id,
                        "failed",
                        None,
                        0,
                        0,
                        0,
                        0,
                        Instant::now(),
                        vec![error.clone()],
                        Some(error.clone()),
                    ),
                );
            }
        }
        manager.finish();
    });
}

fn run(
    app: &AppHandle,
    database_path: &Path,
    library_id: &str,
    job_id: &str,
    cancel: &AtomicBool,
    recycle_sources: bool,
    destinations: Option<&[String]>,
) -> Result<LibraryMergeResultDto, String> {
    let repository = Repository::open(database_path).map_err(|error| error.to_string())?;
    let root = library_root(&repository, library_id).map_err(|error| error.to_string())?;
    let groups = filter_selected_groups(
        discover_groups(&root).map_err(|error| error.to_string())?,
        destinations,
    )?;
    let group_total = groups.len() as i64;
    let bytes_total = groups.iter().map(|group| group.size_bytes).sum::<u64>();
    if let Some(free) = available_space(&root) {
        if free < bytes_total {
            return Err(format!(
                "目标盘空间不足：所选分段约需 {bytes_total} 字节，剩余 {free} 字节"
            ));
        }
    }
    let ffmpeg = resolve_ffmpeg(app).map_err(|error| error.to_string())?;

    emit(
        app,
        progress(
            job_id,
            "running",
            None,
            0,
            group_total,
            0,
            bytes_total,
            Instant::now(),
            vec![],
            None,
        ),
    );

    let started = Instant::now();
    let mut group_processed = 0_i64;
    let mut bytes_processed = 0_u64;
    let mut groups_merged = 0_u64;
    let mut segments_recycled = 0_u64;
    let mut segments_kept = 0_u64;
    let mut failed_groups = 0_u64;
    let mut errors = Vec::new();
    let mut cancelled = false;

    for group in groups {
        if cancel.load(Ordering::Relaxed) {
            cancelled = true;
            break;
        }
        let display = group.file_name.clone();
        emit(
            app,
            progress(
                job_id,
                "running",
                Some(display.clone()),
                group_processed,
                group_total,
                bytes_processed,
                bytes_total,
                started,
                errors.clone(),
                None,
            ),
        );

        let mut segment_paths = Vec::with_capacity(group.sources.len());
        let mut join_error = None;
        for relative in &group.sources {
            match resolve_inside(&root, relative) {
                Ok(path) => segment_paths.push(path),
                Err(error) => {
                    join_error = Some(error);
                    break;
                }
            }
        }
        if let Some(error) = join_error {
            failed_groups += 1;
            errors.push(format!("{display}: {error}"));
            group_processed += 1;
            bytes_processed += group.size_bytes;
            continue;
        }
        let destination = match resolve_inside(&root, &group.destination_relative) {
            Ok(path) => path,
            Err(error) => {
                failed_groups += 1;
                errors.push(format!("{display}: {error}"));
                group_processed += 1;
                bytes_processed += group.size_bytes;
                continue;
            }
        };
        if destination.exists() {
            failed_groups += 1;
            errors.push(format!("{display}: 目标已存在，跳过以免覆盖"));
            group_processed += 1;
            bytes_processed += group.size_bytes;
            continue;
        }

        let base_bytes = bytes_processed;
        let mut last_progress = Instant::now();
        let result = merge_and_verify(
            &ffmpeg,
            &segment_paths,
            &destination,
            group.size_bytes,
            cancel,
            &mut |file_bytes| {
                if last_progress.elapsed() >= Duration::from_millis(150) {
                    emit(
                        app,
                        progress(
                            job_id,
                            "running",
                            Some(display.clone()),
                            group_processed,
                            group_total,
                            base_bytes + file_bytes,
                            bytes_total,
                            started,
                            errors.clone(),
                            None,
                        ),
                    );
                    last_progress = Instant::now();
                }
            },
        );
        match result {
            Ok(_) => {
                groups_merged += 1;
                bytes_processed += group.size_bytes;
                if recycle_sources {
                    for relative in &group.sources {
                        match resolve_inside(&root, relative) {
                            Ok(path) => match send_to_recycle_bin(&path) {
                                Ok(()) => segments_recycled += 1,
                                Err(error) => {
                                    segments_kept += 1;
                                    errors.push(format!("{relative}: 移入回收站失败: {error}"));
                                }
                            },
                            Err(error) => {
                                segments_kept += 1;
                                errors.push(format!("{relative}: {error}"));
                            }
                        }
                    }
                } else {
                    segments_kept += group.sources.len() as u64;
                }
            }
            Err(CopyError::Cancelled) => {
                cancelled = true;
                break;
            }
            Err(CopyError::Message(message)) => {
                failed_groups += 1;
                errors.push(format!("{display}: {message}"));
                bytes_processed += group.size_bytes;
            }
        }
        group_processed += 1;
        emit(
            app,
            progress(
                job_id,
                "running",
                None,
                group_processed,
                group_total,
                bytes_processed,
                bytes_total,
                started,
                errors.clone(),
                None,
            ),
        );
    }

    let failed_groups_total = failed_groups;
    if !errors.is_empty() {
        if let Ok(mut log) = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(database_path.with_file_name(format!("library-merge-{job_id}.log")))
        {
            use std::io::Write as _;
            for line in &errors {
                let _ = writeln!(log, "{} {line}", crate::system::timestamp_now());
            }
        }
    }
    let result = LibraryMergeResultDto {
        job_id: job_id.to_owned(),
        groups_merged,
        segments_recycled,
        segments_kept,
        failed_groups: failed_groups_total,
        errors: errors.clone(),
        cancelled,
    };
    emit(
        app,
        progress(
            job_id,
            if cancelled {
                "cancelled"
            } else if failed_groups_total > 0 {
                "failed"
            } else {
                "completed"
            },
            None,
            group_processed,
            group_total,
            bytes_processed,
            bytes_total,
            Instant::now(),
            errors,
            if cancelled {
                Some("用户取消分段整理".to_owned())
            } else if failed_groups_total > 0 {
                Some(format!("{failed_groups_total} 组合并失败"))
            } else {
                None
            },
        ),
    );
    Ok(result)
}

/// `None` keeps every discovered group. A list keeps only those destination
/// paths, so a large library can merge a chosen subset.
fn filter_selected_groups(
    groups: Vec<LibraryMergeGroupDto>,
    destinations: Option<&[String]>,
) -> Result<Vec<LibraryMergeGroupDto>, String> {
    let Some(destinations) = destinations else {
        if groups.is_empty() {
            return Err("没有需要合并的分段视频".to_owned());
        }
        return Ok(groups);
    };
    if destinations.is_empty() {
        return Err("请至少选择一组要合并的分段".to_owned());
    }
    let selected: HashSet<&str> = destinations.iter().map(String::as_str).collect();
    let chosen: Vec<_> = groups
        .into_iter()
        .filter(|group| selected.contains(group.destination_relative.as_str()))
        .collect();
    if chosen.is_empty() {
        return Err("所选分段已不存在，请重新生成预览".to_owned());
    }
    Ok(chosen)
}

fn discover_groups(root: &Path) -> Result<Vec<LibraryMergeGroupDto>, crate::errors::AppError> {
    let mut files = Vec::new();
    collect_video_files(root, root, &mut files)?;
    files.sort_by(|left, right| left.0.cmp(&right.0));

    let mut buckets: BTreeMap<(String, String), Vec<(String, u64, u64, String)>> = BTreeMap::new();
    for (relative, file_name, size, dir) in files {
        let Some((key, seq)) = parse_segment_key(&file_name) else {
            continue;
        };
        let extension = Path::new(&file_name)
            .extension()
            .map(|value| format!(".{}", value.to_string_lossy().to_ascii_lowercase()))
            .unwrap_or_default();
        buckets
            .entry((key, extension))
            .or_default()
            .push((relative, seq, size, dir));
    }

    let mut groups = Vec::new();
    for ((key, extension), parts) in buckets {
        let keyed = parts
            .into_iter()
            .map(|(relative, seq, size, dir)| (seq, (relative, seq, size, dir)))
            .collect::<Vec<_>>();
        let runs = split_consecutive_runs(keyed);
        let mut accepted = Vec::new();
        for run in runs {
            if run.len() < 2 {
                continue;
            }
            let dir = run[0].3.clone();
            if run.iter().any(|(_, _, _, value)| *value != dir) {
                continue;
            }
            accepted.push(run);
        }
        let run_count = accepted.len();
        for run in accepted {
            let dir = run[0].3.clone();
            let end_seq = run.last().map(|part| part.1).unwrap_or(run[0].1);
            let file_name = merged_output_name(&key, &extension, run[0].1, end_seq, run_count);
            let destination_relative = if dir.is_empty() {
                file_name.clone()
            } else {
                format!("{dir}\\{file_name}")
            };
            if resolve_inside(root, &destination_relative)
                .map(|path| path.exists())
                .unwrap_or(false)
            {
                continue;
            }
            let sources = run
                .iter()
                .map(|(relative, _, _, _)| relative.clone())
                .collect::<Vec<_>>();
            let size_bytes = run.iter().map(|(_, _, size, _)| *size).sum();
            groups.push(LibraryMergeGroupDto {
                group_key: key.clone(),
                file_name,
                sources,
                size_bytes,
                destination_relative,
            });
        }
    }
    Ok(groups)
}

fn collect_video_files(
    root: &Path,
    path: &Path,
    output: &mut Vec<(String, String, u64, String)>,
) -> Result<(), crate::errors::AppError> {
    let entries = fs::read_dir(path).map_err(|error| {
        crate::errors::AppError::from(format!("读取媒体库目录失败 {}: {error}", path.display()))
    })?;
    for entry in entries {
        let entry = entry.map_err(|error| {
            crate::errors::AppError::from(format!("读取媒体库目录失败 {}: {error}", path.display()))
        })?;
        let file_type = entry
            .file_type()
            .map_err(|error| crate::errors::AppError::from(format!("读取文件类型失败: {error}")))?;
        if file_type.is_symlink() {
            continue;
        }
        let entry_path = entry.path();
        if file_type.is_dir() {
            collect_video_files(root, &entry_path, output)?;
            continue;
        }
        if !file_type.is_file() {
            continue;
        }
        let file_name = entry.file_name().to_string_lossy().into_owned();
        if file_name.to_ascii_lowercase().contains(".camlib-") {
            continue;
        }
        let extension = Path::new(&file_name)
            .extension()
            .map(|value| value.to_string_lossy().to_ascii_lowercase())
            .unwrap_or_default();
        if !matches!(
            extension.as_str(),
            "mp4" | "mov" | "avi" | "m4v" | "mts" | "m2ts" | "3gp"
        ) {
            continue;
        }
        let size = entry
            .metadata()
            .map_err(|error| {
                crate::errors::AppError::from(format!(
                    "读取文件大小失败 {}: {error}",
                    entry_path.display()
                ))
            })?
            .len();
        let relative = entry_path
            .strip_prefix(root)
            .map(|value| value.to_string_lossy().replace('/', "\\"))
            .map_err(|_| crate::errors::AppError::from("媒体路径越过媒体库根目录"))?;
        let dir = Path::new(&relative)
            .parent()
            .map(|value| value.to_string_lossy().replace('/', "\\"))
            .unwrap_or_default();
        output.push((relative, file_name, size, dir));
    }
    Ok(())
}

fn library_root(
    repository: &Repository,
    library_id: &str,
) -> Result<PathBuf, crate::errors::AppError> {
    let library = repository
        .get_library(library_id)
        .map_err(crate::errors::AppError::from)?
        .ok_or_else(|| crate::errors::AppError::from("媒体库不存在"))?;
    let root = fs::canonicalize(&library.root_path)
        .map_err(|error| crate::errors::AppError::from(format!("媒体库根目录不可用: {error}")))?;
    if !root.is_dir() {
        return Err(crate::errors::AppError::from("媒体库根目录不是目录"));
    }
    Ok(root)
}

fn resolve_inside(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let mut path = root.to_owned();
    for component in relative.replace('/', "\\").split('\\') {
        if component.is_empty() || component == "." {
            continue;
        }
        if component == ".." {
            return Err("相对路径无效".to_owned());
        }
        path.push(component);
    }
    if !path.starts_with(root) {
        return Err("路径越过媒体库根目录".to_owned());
    }
    Ok(path)
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

fn progress(
    job_id: &str,
    state: &'static str,
    current_file: Option<String>,
    group_processed: i64,
    group_total: i64,
    bytes_processed: u64,
    bytes_total: u64,
    started: Instant,
    errors: Vec<String>,
    error: Option<String>,
) -> LibraryMergeProgress {
    let speed = if started.elapsed().as_secs_f64() > 0.1 {
        (bytes_processed as f64 / started.elapsed().as_secs_f64()) as u64
    } else {
        0
    };
    LibraryMergeProgress {
        job_id: job_id.to_owned(),
        kind: "library_merge",
        seq: if matches!(state, "completed" | "cancelled" | "failed") {
            u64::MAX
        } else {
            bytes_processed
        },
        phase: "merging",
        state,
        current_file,
        group_processed,
        group_total,
        bytes_processed: bytes_processed as i64,
        bytes_total: bytes_total as i64,
        speed_bytes_per_sec: speed,
        eta_seconds: (speed > 0 && bytes_total > bytes_processed)
            .then(|| (bytes_total - bytes_processed) / speed),
        errors,
        error,
    }
}

fn emit(app: &AppHandle, progress: LibraryMergeProgress) {
    let _ = app.emit("library-merge-progress", progress);
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn write(path: &Path, bytes: &[u8]) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, bytes).unwrap();
    }

    #[test]
    fn discovers_only_same_timestamp_groups_inside_library() {
        let root = TempDir::new().unwrap();
        write(
            &root
                .path()
                .join("2026/10/2026-10-01/视频/VID_20261001_153408_333.mp4"),
            &vec![1_u8; 10],
        );
        write(
            &root
                .path()
                .join("2026/10/2026-10-01/视频/VID_20261001_153408_334.mp4"),
            &vec![2_u8; 20],
        );
        write(
            &root
                .path()
                .join("2026/08/2026-08-16/视频/VID_20260816_150035_122.mp4"),
            &vec![3_u8; 5],
        );
        write(
            &root
                .path()
                .join("2026/08/2026-08-16/视频/VID_20260816_150534_123.mp4"),
            &vec![4_u8; 6],
        );

        write(
            &root
                .path()
                .join("2026/10/2026-10-01/视频/VID_20261001_144056_327.mp4"),
            &vec![5_u8; 3],
        );
        write(
            &root
                .path()
                .join("2026/10/2026-10-01/视频/VID_20261001_144056_328.mp4"),
            &vec![6_u8; 4],
        );

        let groups = discover_groups(root.path()).unwrap();
        assert_eq!(groups.len(), 2);
        let keys = groups
            .iter()
            .map(|group| group.group_key.as_str())
            .collect::<Vec<_>>();
        assert!(keys.contains(&"VID_20261001_153408"));
        assert!(keys.contains(&"VID_20261001_144056"));
    }

    #[test]
    fn skips_already_merged_destination_and_nonconsecutive_counters() {
        let root = TempDir::new().unwrap();
        write(
            &root
                .path()
                .join("2026/10/2026-10-01/视频/VID_20261001_144056_327.mp4"),
            &vec![1_u8; 3],
        );
        write(
            &root
                .path()
                .join("2026/10/2026-10-01/视频/VID_20261001_144056_328.mp4"),
            &vec![2_u8; 4],
        );
        write(
            &root
                .path()
                .join("2026/10/2026-10-01/视频/VID_20261001_144056.mp4"),
            &vec![3_u8; 7],
        );
        write(
            &root
                .path()
                .join("2026/10/2026-10-01/视频/VID_20261001_153408_333.mp4"),
            &vec![4_u8; 10],
        );
        write(
            &root
                .path()
                .join("2026/10/2026-10-01/视频/VID_20261001_153408_335.mp4"),
            &vec![5_u8; 11],
        );

        let groups = discover_groups(root.path()).unwrap();
        assert!(groups.is_empty());
    }

    #[test]
    fn split_runs_of_one_timestamp_do_not_share_an_output_name() {
        let root = TempDir::new().unwrap();
        for name in [
            "VID_20261001_153408_333.mp4",
            "VID_20261001_153408_334.mp4",
            "VID_20261001_153408_336.mp4",
            "VID_20261001_153408_337.mp4",
        ] {
            write(
                &root.path().join(format!("2026/10/2026-10-01/视频/{name}")),
                &vec![1_u8; 8],
            );
        }
        let groups = discover_groups(root.path()).unwrap();
        assert_eq!(groups.len(), 2);
        let names = groups
            .iter()
            .map(|group| group.file_name.as_str())
            .collect::<Vec<_>>();
        assert!(names.contains(&"VID_20261001_153408_333-334.mp4"));
        assert!(names.contains(&"VID_20261001_153408_336-337.mp4"));
    }

    #[test]
    fn filter_keeps_only_chosen_destinations() {
        let sample = |dest: &str| LibraryMergeGroupDto {
            group_key: "VID_20261001_153408".to_owned(),
            file_name: "VID_20261001_153408.mp4".to_owned(),
            sources: vec!["a.mp4".to_owned(), "b.mp4".to_owned()],
            size_bytes: 10,
            destination_relative: dest.to_owned(),
        };
        let chosen = filter_selected_groups(
            vec![
                sample("2026\\a.mp4"),
                sample("2026\\b.mp4"),
                sample("2026\\c.mp4"),
            ],
            Some(&["2026\\b.mp4".to_owned(), "missing.mp4".to_owned()]),
        )
        .unwrap();
        assert_eq!(chosen.len(), 1);
        assert_eq!(chosen[0].destination_relative, "2026\\b.mp4");
        assert!(filter_selected_groups(vec![sample("2026\\a.mp4")], Some(&[])).is_err());
        assert!(filter_selected_groups(
            vec![sample("2026\\a.mp4")],
            Some(&["missing.mp4".to_owned()])
        )
        .is_err());
    }

    #[test]
    fn resolve_inside_rejects_traversal() {
        let root = Path::new("/library");
        assert!(resolve_inside(root, "..\\outside.mp4").is_err());
        assert!(resolve_inside(root, "2026\\ok.mp4").is_ok());
    }
}
