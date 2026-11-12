//! Merge user-selected library videos into one new copy.
//!
//! The media grid lets the user multi-select videos and order them; this
//! module joins them into `{first_stem}_merged{ext}` beside the first source.
//! `copy` mode reuses the lossless concat demuxer from backup.rs and needs
//! matching codecs; `reencode` normalizes every segment to the first
//! segment's frame (letterboxed) and re-encodes H.264/AAC so mixed formats
//! still join. Sources are read-only unless recycling is on. The output joins
//! the library via the incremental scan, exactly like save-on-copy edits.

use crate::backup::{ffmpeg_path_string, merge_and_verify, CopyError, TempGuard};
use crate::db::{LibraryState, Repository};
use crate::deletion::send_to_recycle_bin;
use crate::editing::{spawn_progress_reader, video_source_file};
use crate::media::{hide_console_window, resolve_ffmpeg, resolve_media_path};
use serde::{Deserialize, Serialize};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};

static NEXT_MERGE_JOB: AtomicU64 = AtomicU64::new(1);

const MERGE_PROGRESS_EVENT: &str = "media-merge-progress";
/// Upper bound so a pathological name search can never spin forever.
const MAX_MERGE_COPIES: u32 = 1000;

fn next_job_id() -> String {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!(
        "video-merge-{stamp}-{}",
        NEXT_MERGE_JOB.fetch_add(1, Ordering::Relaxed)
    )
}

/// Single-slot job manager shared with the other long-running jobs: `start()`
/// rejects a second job while one is running, `cancel()` flips the flag the
/// ffmpeg wait loops poll.
#[derive(Debug, Clone)]
pub struct VideoMergeManagerState {
    jobs: Arc<Mutex<Vec<Arc<AtomicBool>>>>,
}

impl VideoMergeManagerState {
    pub fn new() -> Self {
        Self {
            jobs: Arc::new(Mutex::new(Vec::new())),
        }
    }

    pub fn start(&self) -> Result<(String, Arc<AtomicBool>), crate::errors::AppError> {
        let mut jobs = self
            .jobs
            .lock()
            .map_err(|_| crate::errors::AppError::internal("视频合并任务状态锁已损坏"))?;
        if !jobs.is_empty() {
            return Err(crate::errors::AppError::job_already_running(
                "已有视频合并任务正在运行",
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
            .map_err(|_| crate::errors::AppError::internal("视频合并任务状态锁已损坏"))?;
        let Some(job) = jobs.first() else {
            return Err(crate::errors::AppError::job_not_found("视频合并任务不存在"));
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum VideoMergeMode {
    /// Lossless concat demuxer stream copy; requires matching codecs.
    Copy,
    /// Re-encode every segment (H.264/AAC) so mixed formats join.
    Reencode,
}

#[derive(Debug, Clone)]
pub struct VideoMergeParams {
    /// Ordered media item ids; the array order is the playback order.
    pub media_item_ids: Vec<String>,
    pub mode: VideoMergeMode,
    pub recycle_sources: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoMergeStartDto {
    pub job_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoMergeResultDto {
    pub file_name: String,
    pub relative_path: String,
    pub size_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoMergeProgress {
    pub job_id: String,
    pub kind: &'static str,
    pub phase: &'static str,
    pub state: &'static str,
    /// 0..100 when measurable: byte ratio for stream copy, decoded-time ratio
    /// for re-encode. `None` keeps the UI's indeterminate bar.
    pub percent: Option<f64>,
    pub bytes_processed: i64,
    /// 0 while re-encoding (output size is unknown up front).
    pub bytes_total: i64,
    pub speed_bytes_per_sec: u64,
    pub eta_seconds: Option<u64>,
    pub error: Option<String>,
    pub result: Option<VideoMergeResultDto>,
}

fn emit(app: &AppHandle, progress: VideoMergeProgress) {
    let _ = app.emit(MERGE_PROGRESS_EVENT, progress);
}

// 进度快照构造器：入参是构造 VideoMergeProgress 所需的原始计数与起止状态，
// 保持扁平直读；包成结构体后字段还要再拆一次才能用。
#[allow(clippy::too_many_arguments)]
fn progress(
    job_id: &str,
    state: &'static str,
    phase: &'static str,
    percent: Option<f64>,
    bytes_processed: u64,
    bytes_total: u64,
    started: Instant,
    error: Option<String>,
    result: Option<VideoMergeResultDto>,
) -> VideoMergeProgress {
    let speed = if started.elapsed().as_secs_f64() > 0.1 {
        (bytes_processed as f64 / started.elapsed().as_secs_f64()) as u64
    } else {
        0
    };
    VideoMergeProgress {
        job_id: job_id.to_owned(),
        kind: "merge",
        phase,
        state,
        percent,
        bytes_processed: bytes_processed as i64,
        bytes_total: bytes_total as i64,
        speed_bytes_per_sec: speed,
        eta_seconds: (speed > 0 && bytes_total > bytes_processed)
            .then(|| (bytes_total - bytes_processed) / speed),
        error,
        result,
    }
}

/// One resolved, probe-checked input of the merge, in playback order.
struct SourceVideo {
    path: PathBuf,
    /// Library-relative forward-slash path for index cleanup.
    relative_path: String,
    display_name: String,
    size_bytes: u64,
    duration_ms: u64,
    width: u32,
    height: u32,
    video_codec: String,
    has_audio: bool,
}

/// Launch a merge job on a background thread. Emits `media-merge-progress`
/// and triggers an incremental scan once the merged copy is committed.
// 合并任务的线程启动入口：命令层已解析好的上下文（库、作业、取消旗标、
// 合并参数）逐项透传，包一层只是把同样字段再抄一遍。
#[allow(clippy::too_many_arguments)]
pub fn spawn(
    app: AppHandle,
    manager: Arc<VideoMergeManagerState>,
    scan_manager: Arc<crate::scanner::ScanManagerState>,
    database_path: PathBuf,
    library_id: String,
    job_id: String,
    cancel: Arc<AtomicBool>,
    params: VideoMergeParams,
) {
    std::thread::spawn(move || {
        let result = run(&app, &database_path, &library_id, &job_id, &cancel, &params);
        match &result {
            Ok(done) => {
                emit(
                    &app,
                    progress(
                        &job_id,
                        "completed",
                        "finalizing",
                        Some(100.0),
                        done.size_bytes,
                        done.size_bytes,
                        Instant::now(),
                        None,
                        Some(done.clone()),
                    ),
                );
                // Bring the merged copy into the index; a busy scan never
                // fails an otherwise successful merge.
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
            Err(error) => {
                let cancelled = cancel.load(Ordering::Relaxed);
                emit(
                    &app,
                    progress(
                        &job_id,
                        if cancelled { "cancelled" } else { "failed" },
                        "merging",
                        None,
                        0,
                        0,
                        Instant::now(),
                        Some(error.clone()),
                        None,
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
    params: &VideoMergeParams,
) -> Result<VideoMergeResultDto, String> {
    if params.media_item_ids.len() < 2 {
        return Err("合并至少需要两个视频".to_owned());
    }
    let repository = Repository::open(database_path).map_err(|error| error.to_string())?;
    let library = repository
        .get_library(library_id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "媒体库不存在".to_owned())?;
    if library.state != LibraryState::Available {
        return Err("媒体库当前不可用".to_owned());
    }
    let root = PathBuf::from(library.root_path);
    let ffmpeg = resolve_ffmpeg(app).map_err(|error| error.to_string())?;

    emit(
        app,
        progress(
            job_id,
            "running",
            "preparing",
            None,
            0,
            0,
            Instant::now(),
            None,
            None,
        ),
    );

    // Resolve every selected item to its playable video file, in the exact
    // order the user arranged in the merge dialog.
    let mut sources: Vec<SourceVideo> = Vec::with_capacity(params.media_item_ids.len());
    for media_item_id in &params.media_item_ids {
        let details = repository
            .get_media_item_details(media_item_id)
            .map_err(|error| error.to_string())?
            .ok_or_else(|| format!("媒体不存在: {media_item_id}"))?;
        if details.item.library_id != library_id {
            return Err(format!(
                "媒体不属于当前媒体库: {}",
                details.item.display_name
            ));
        }
        let file = video_source_file(&details)
            .ok_or_else(|| format!("没有可合并的视频文件: {}", details.item.display_name))?;
        let path =
            resolve_media_path(&root, &file.relative_path).map_err(|error| error.to_string())?;
        let size_bytes = fs::metadata(&path)
            .map_err(|error| format!("读取源文件失败 {}: {error}", path.display()))?
            .len();
        sources.push(SourceVideo {
            path,
            relative_path: file.relative_path.clone(),
            display_name: details.item.display_name.clone(),
            size_bytes,
            duration_ms: 0,
            width: 0,
            height: 0,
            video_codec: String::new(),
            has_audio: false,
        });
    }

    // Probe up front: re-encode needs durations/resolutions, and an unreadable
    // input should fail before ffmpeg starts writing the output.
    for source in &mut sources {
        let probe = probe_video(&ffmpeg, &source.path)?;
        source.duration_ms = probe.duration_ms;
        source.width = probe.width;
        source.height = probe.height;
        source.video_codec = probe.video_codec;
        source.has_audio = probe.has_audio;
    }

    let total_bytes: u64 = sources.iter().map(|source| source.size_bytes).sum();
    let total_duration_ms: u64 = sources.iter().map(|source| source.duration_ms).sum();

    let destination = match params.mode {
        VideoMergeMode::Copy => {
            let extension = Path::new(&sources[0].path)
                .extension()
                .map(|value| value.to_string_lossy().to_ascii_lowercase())
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| "mp4".to_owned());
            merged_destination(&sources[0].path, &extension)?
        }
        VideoMergeMode::Reencode => merged_destination(&sources[0].path, "mp4")?,
    };

    let started = Instant::now();
    emit(
        app,
        progress(
            job_id,
            "running",
            "merging",
            Some(0.0),
            0,
            total_bytes,
            started,
            None,
            None,
        ),
    );

    match params.mode {
        VideoMergeMode::Copy => {
            let paths: Vec<PathBuf> = sources.iter().map(|source| source.path.clone()).collect();
            let mut last_emit = Instant::now();
            let result = merge_and_verify(
                &ffmpeg,
                &paths,
                &destination,
                total_bytes,
                cancel,
                &mut |file_bytes| {
                    if last_emit.elapsed() >= Duration::from_millis(150) {
                        last_emit = Instant::now();
                        let percent = if total_bytes == 0 {
                            None
                        } else {
                            Some((file_bytes as f64 / total_bytes as f64 * 100.0).clamp(0.0, 100.0))
                        };
                        emit(
                            app,
                            progress(
                                job_id,
                                "running",
                                "merging",
                                percent,
                                file_bytes,
                                total_bytes,
                                started,
                                None,
                                None,
                            ),
                        );
                    }
                },
            );
            match result {
                Ok(_) => {}
                Err(CopyError::Cancelled) => return Err("合并已取消".to_owned()),
                Err(CopyError::Message(message)) | Err(CopyError::Integrity(message)) => {
                    return Err(message)
                }
            }
        }
        VideoMergeMode::Reencode => {
            merge_reencode(
                app,
                job_id,
                &ffmpeg,
                &sources,
                &destination,
                total_duration_ms,
                cancel,
                started,
            )?;
        }
    }

    let metadata =
        fs::metadata(&destination).map_err(|error| format!("读取合并结果失败: {error}"))?;
    let file_name = destination
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .into_owned();
    let relative_path = destination
        .strip_prefix(&root)
        .map(|value| value.to_string_lossy().replace('\\', "/"))
        .map_err(|_| "输出文件越出媒体库根目录".to_owned())?;

    if params.recycle_sources {
        // The source cards must leave the media list instead of turning into
        // permanent offline rows: the merged file now carries their content,
        // so drop the index rows for every source that made it into the bin.
        // A single failure keeps that source (the merge itself already
        // succeeded), matching the tolerant per-group behavior of the
        // library segment maintenance.
        let mut recycled_paths = Vec::with_capacity(sources.len());
        for source in &sources {
            if let Err(error) = send_to_recycle_bin(&source.path) {
                eprintln!("camlib: 移入回收站失败 {}: {error}", source.display_name);
                continue;
            }
            recycled_paths.push(source.relative_path.replace('\\', "/"));
        }
        if !recycled_paths.is_empty() {
            repository
                .purge_files_and_empty_items(library_id, &recycled_paths)
                .map_err(|error| format!("清理原视频索引失败: {error}"))?;
        }
    }

    Ok(VideoMergeResultDto {
        file_name,
        relative_path,
        size_bytes: metadata.len(),
    })
}

/// `{stem}_merged{ext}`, then `_merged_2`, `_merged_3` … never overwrites.
/// Merging a previous merge chains onto the same stem instead of growing it.
fn merged_destination(source: &Path, output_extension: &str) -> Result<PathBuf, String> {
    let parent = source.parent().ok_or_else(|| "源文件路径无效".to_owned())?;
    let stem = source
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy()
        .into_owned();
    let base_stem = stem.strip_suffix("_merged").unwrap_or(&stem).to_owned();
    let extension = format!(".{output_extension}");
    for index in 1..MAX_MERGE_COPIES {
        let suffix = if index == 1 {
            "_merged".to_owned()
        } else {
            format!("_merged_{index}")
        };
        let candidate = parent.join(format!("{base_stem}{suffix}{extension}"));
        if !candidate.exists() {
            return Ok(candidate);
        }
    }
    Err("同名合并副本过多，无法生成新文件名".to_owned())
}

/// What `ffmpeg -i` prints for one input and the merge needs up front.
struct VideoProbe {
    duration_ms: u64,
    width: u32,
    height: u32,
    video_codec: String,
    has_audio: bool,
}

/// Probe a video by asking ffmpeg to read it with no output file. ffmpeg then
/// exits non-zero but still prints the stream summary we parse on stderr —
/// the codebase has no ffprobe, and this avoids bundling one.
fn probe_video(ffmpeg: &Path, source: &Path) -> Result<VideoProbe, String> {
    let mut command = Command::new(ffmpeg);
    command
        .args(["-nostdin", "-hide_banner", "-i"])
        .arg(ffmpeg_path_string(source))
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    hide_console_window(&mut command);
    let output = command
        .output()
        .map_err(|error| format!("启动 ffmpeg 探测失败: {error}"))?;
    let text = String::from_utf8_lossy(&output.stderr).into_owned();
    if text.is_empty() {
        return Err(format!("无法读取视频信息: {}", source.display()));
    }
    let (video_codec, width, height) =
        parse_video_stream(&text).ok_or_else(|| format!("无法识别视频流: {}", source.display()))?;
    Ok(VideoProbe {
        duration_ms: parse_duration_ms(&text),
        width,
        height,
        video_codec,
        has_audio: has_audio_track(&text),
    })
}

/// First `Duration: HH:MM:SS.ms` line in ffmpeg's input summary; 0 if absent.
fn parse_duration_ms(text: &str) -> u64 {
    for line in text.lines() {
        let Some(rest) = line.trim().strip_prefix("Duration:") else {
            continue;
        };
        let token = rest.split(',').next().unwrap_or("").trim();
        let mut total_ms = 0_u64;
        let mut valid = true;
        for (index, part) in token.split(':').enumerate() {
            let Ok(value) = part.parse::<f64>() else {
                valid = false;
                break;
            };
            total_ms += match index {
                0 => (value * 3600.0) as u64 * 1000,
                1 => (value * 60.0) as u64 * 1000,
                2 => (value * 1000.0) as u64,
                _ => {
                    valid = false;
                    break;
                }
            };
        }
        if valid {
            return total_ms;
        }
    }
    0
}

/// Codec name plus frame size of the first video stream line.
fn parse_video_stream(text: &str) -> Option<(String, u32, u32)> {
    for line in text.lines() {
        let Some(position) = line.find(": Video:") else {
            continue;
        };
        // Search only after the "Video:" marker: the stream id prefix contains
        // hex tokens like `0x1` that look like dimensions.
        let rest = &line[position + ": Video:".len()..];
        let trimmed = rest.trim_start();
        let codec_end = trimmed.find([' ', '(']).unwrap_or(trimmed.len());
        let codec = trimmed[..codec_end].to_owned();
        if codec.is_empty() {
            continue;
        }
        for chunk in rest.split(',') {
            if let Some((width, height)) = parse_wxh(chunk) {
                return Some((codec, width, height));
            }
        }
    }
    None
}

/// Parse a comma-separated stream-summary chunk shaped like `1920x1080 …`.
/// Hex tokens (`0x31637661`) are rejected by the plausible-dimension bound.
fn parse_wxh(chunk: &str) -> Option<(u32, u32)> {
    let chunk = chunk.trim();
    let x_index = chunk.find('x')?;
    let width_text = &chunk[..x_index];
    if width_text.is_empty() || !width_text.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    let rest = &chunk[x_index + 1..];
    let height_end = rest
        .find(|character: char| !character.is_ascii_digit())
        .unwrap_or(rest.len());
    let height_text = &rest[..height_end];
    if height_text.is_empty() {
        return None;
    }
    let width: u32 = width_text.parse().ok()?;
    let height: u32 = height_text.parse().ok()?;
    if !(16..=8192).contains(&width) || !(16..=8192).contains(&height) {
        return None;
    }
    Some((width, height))
}

fn has_audio_track(text: &str) -> bool {
    text.lines().any(|line| line.contains(": Audio:"))
}

/// Re-encoding merge: every segment is normalized to the first segment's
/// frame (letterboxed, yuv420p) and 44.1 kHz stereo audio, then joined with
/// the concat filter. Segments without an audio track get a silent
/// `anullsrc` stand-in sized to their duration so the graph always completes.
// 重编码合并的 ffmpeg 调用上下文（源列表、目标、总时长、取消与进度），
// 正是拼 filter graph 与回报进度要用的全套。
#[allow(clippy::too_many_arguments)]
fn merge_reencode(
    app: &AppHandle,
    job_id: &str,
    ffmpeg: &Path,
    sources: &[SourceVideo],
    destination: &Path,
    total_duration_ms: u64,
    cancel: &AtomicBool,
    started: Instant,
) -> Result<(), String> {
    let parent = destination
        .parent()
        .ok_or_else(|| "目标路径无效".to_owned())?;
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
    let extension = destination
        .extension()
        .map(|value| format!(".{}", value.to_string_lossy()))
        .unwrap_or_default();
    // Same scratch naming family as the backup merges: dot-prefixed `.camlib-`
    // files are skipped by the scanner and removed by the guards on failure.
    let temp = parent.join(format!(".{dest_stem}.camlib-merge{extension}"));
    let log_path = parent.join(format!(".{dest_name}.camlib-ffmpeg.log"));
    let _ = fs::remove_file(&temp);
    let _ = fs::remove_file(&log_path);
    let mut temp_guard = TempGuard::new(temp.clone());
    let mut log_guard = TempGuard::new(log_path.clone());

    let (target_width, target_height) = (sources[0].width, sources[0].height);
    // Only rescale when sizes actually differ; identical segments keep their
    // pixels untouched (a same-size scale would still be a no-op visually).
    let normalize = target_width > 0
        && target_height > 0
        && sources
            .iter()
            .any(|source| source.width != target_width || source.height != target_height);
    let with_audio = sources.iter().any(|source| source.has_audio);

    let mut command = Command::new(ffmpeg);
    command.args([
        "-nostdin",
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        // Machine-readable progress on stdout for the percent meter.
        "-progress",
        "pipe:1",
        "-nostats",
    ]);
    for source in sources {
        command.arg("-i").arg(ffmpeg_path_string(&source.path));
    }
    // Silent audio stand-ins for segments lacking a track, appended after the
    // file inputs. Each ends at its segment's duration so the concat filter
    // can advance to the next segment once both pads reach EOF. Skipped
    // entirely when no input has audio — the graph then runs video-only.
    let mut lavfi_index = sources.len();
    let mut silent_for: Vec<Option<usize>> = Vec::with_capacity(sources.len());
    for source in sources {
        if source.has_audio {
            silent_for.push(None);
        } else if with_audio {
            silent_for.push(Some(lavfi_index));
            lavfi_index += 1;
            let duration = format!("{:.3}", (source.duration_ms.max(1) as f64) / 1000.0);
            command.args([
                "-f",
                "lavfi",
                "-t",
                &duration,
                "-i",
                "anullsrc=r=44100:cl=stereo",
            ]);
        } else {
            silent_for.push(None);
        }
    }

    let mut filters = String::new();
    for (index, _) in sources.iter().enumerate() {
        if normalize {
            filters.push_str(&format!(
                "[{index}:v]scale={target_width}:{target_height}:force_original_aspect_ratio=decrease,pad={target_width}:{target_height}:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p[v{index}];"
            ));
        } else {
            filters.push_str(&format!("[{index}:v]setsar=1,format=yuv420p[v{index}];"));
        }
    }
    if with_audio {
        for (index, _) in sources.iter().enumerate() {
            if let Some(lavfi) = silent_for[index] {
                filters.push_str(&format!(
                    "[{lavfi}:a]aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo[a{index}];"
                ));
            } else {
                filters.push_str(&format!(
                    "[{index}:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo[a{index}];"
                ));
            }
        }
        let inputs: String = (0..sources.len())
            .map(|index| format!("[v{index}][a{index}]"))
            .collect();
        filters.push_str(&format!("{inputs}concat=n={}:v=1:a=1[v][a]", sources.len()));
    } else {
        let inputs: String = (0..sources.len())
            .map(|index| format!("[v{index}]"))
            .collect();
        filters.push_str(&format!("{inputs}concat=n={}:v=1:a=0[v]", sources.len()));
    }
    command.args(["-filter_complex", &filters, "-map", "[v]"]);
    if with_audio {
        command.args(["-map", "[a]", "-c:a", "aac", "-b:a", "192k"]);
    }
    command.args(["-c:v", "libx264", "-preset", "veryfast", "-crf", "18"]);
    command.args(["-movflags", "+faststart"]);
    command.arg(ffmpeg_path_string(&temp));

    let mut log_file = OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .open(&log_path)
        .map_err(|error| format!("创建合并日志失败: {error}"))?;
    command.stdout(Stdio::piped());
    command.stderr(Stdio::from(
        log_file
            .try_clone()
            .map_err(|error| format!("打开合并日志失败: {error}"))?,
    ));
    hide_console_window(&mut command);
    let mut child = command
        .spawn()
        .map_err(|error| format!("启动 ffmpeg 合并失败: {error}"))?;

    // A reader thread turns ffmpeg's progress stream into a shared value so
    // the wait loop below only handles cancel/exit/emit.
    let percent_micros = Arc::new(AtomicU64::new(0));
    let reader = spawn_progress_reader(&mut child, percent_micros.clone());
    let mut last_emit = Instant::now();
    let mut last_bytes = 0_u64;
    let outcome = loop {
        if cancel.load(Ordering::Relaxed) {
            let _ = child.kill();
            let _ = child.wait();
            break Err("合并已取消".to_owned());
        }
        match child.try_wait() {
            Ok(Some(status)) => {
                if !status.success() {
                    let _ = log_file.flush();
                    let detail = fs::read_to_string(&log_path)
                        .unwrap_or_default()
                        .trim()
                        .to_owned();
                    break Err(if detail.is_empty() {
                        format!("ffmpeg 退出码 {status}")
                    } else {
                        format!("ffmpeg 重编码合并失败: {detail}")
                    });
                }
                break Ok(());
            }
            Ok(None) => {
                if last_emit.elapsed() >= Duration::from_millis(200) {
                    last_emit = Instant::now();
                    // out_time_ms is microseconds despite the name.
                    let done_ms = percent_micros.load(Ordering::Relaxed) / 1000;
                    let percent = if total_duration_ms == 0 {
                        None
                    } else {
                        Some((done_ms as f64 / total_duration_ms as f64 * 100.0).clamp(0.0, 100.0))
                    };
                    let bytes = fs::metadata(&temp)
                        .map(|meta| meta.len())
                        .unwrap_or(last_bytes);
                    last_bytes = bytes;
                    emit(
                        app,
                        progress(
                            job_id, "running", "merging", percent, bytes, 0, started, None, None,
                        ),
                    );
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                break Err(format!("等待 ffmpeg 合并失败: {error}"));
            }
        }
    };
    if let Some(handle) = reader {
        let _ = handle.join();
    }
    outcome?;

    let merged = fs::metadata(&temp)
        .map_err(|error| format!("校验合并结果失败: {error}"))?
        .len();
    if merged == 0 {
        return Err("合并结果为空".to_owned());
    }
    if destination.exists() {
        fs::remove_file(destination).map_err(|error| format!("替换冲突文件失败: {error}"))?;
    }
    fs::rename(&temp, destination).map_err(|error| format!("提交合并文件失败: {error}"))?;
    temp_guard.disarm();
    log_guard.disarm();
    Ok(())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merged_destination_numbers_collisions_and_chains_suffix() {
        let dir = tempfile::TempDir::new().unwrap();
        let first = dir.path().join("VID_20260101_001.mp4");
        assert_eq!(
            merged_destination(&first, "mp4").unwrap(),
            dir.path().join("VID_20260101_001_merged.mp4")
        );
        fs::write(dir.path().join("VID_20260101_001_merged.mp4"), b"x").unwrap();
        assert_eq!(
            merged_destination(&first, "mp4").unwrap(),
            dir.path().join("VID_20260101_001_merged_2.mp4")
        );
        // Merging a previous merge reuses the same stem instead of growing it.
        let previous = dir.path().join("VID_20260101_001_merged.mp4");
        assert_eq!(
            merged_destination(&previous, "mp4").unwrap(),
            dir.path().join("VID_20260101_001_merged_2.mp4")
        );
    }

    #[test]
    fn probe_parsers_read_duration_resolution_and_audio() {
        let sample = "\
Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'VID.mp4':\n\
  Duration: 00:01:02.35, start: 0.000000, bitrate: 23897 kb/s\n\
    Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p(progressive), 1920x1080 [SAR 1:1 DAR 16:9], 30 tbr\n\
    Stream #0:1[0x2](und): Audio: aac (LC), 44100 Hz, stereo, fltp, 128 kb/s\n";
        assert_eq!(parse_duration_ms(sample), 62_350);
        assert_eq!(
            parse_video_stream(sample).unwrap(),
            ("h264".to_owned(), 1920, 1080)
        );
        assert!(has_audio_track(sample));
    }

    #[test]
    fn probe_parsers_reject_hex_tokens_and_missing_audio() {
        let sample = "\
Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'VID.mov':\n\
  Duration: 00:00:05.00, start: 0.000000, bitrate: 512 kb/s\n\
    Stream #0:0[0x1](und): Video: hevc (Main) (hvc1 / 0x31637668), hev1, 3840x2160 [SAR 1:1 DAR 16:9], 30 tbr\n";
        assert_eq!(parse_duration_ms("no duration here"), 0);
        assert_eq!(
            parse_video_stream(sample).unwrap(),
            ("hevc".to_owned(), 3840, 2160)
        );
        assert!(!has_audio_track(sample));
    }
}
