//! Media preview primitives.
//!
//! The original media root is read-only. Generated JPEGs are written only to
//! the configured SSD cache directory. Full-size media is exposed through a
//! small range-aware protocol registry so the webview never receives the
//! complete video in an IPC response.

use crate::db::{MediaFile, MediaFileRole, MediaItemDetails, MediaKind, Repository, ScanState};
use image::{DynamicImage, ImageReader};
use serde::Serialize;
use std::collections::HashMap;
use std::env;
use std::fs::{self, File};
use std::hash::{Hash, Hasher};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Component, Path, PathBuf};
use std::process::Command;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::http::{header, Method, Request, Response, StatusCode};
use tauri::{AppHandle, Emitter, Manager};

const THUMBNAIL_PROCESSOR_VERSION: &str = "image-exif-v1";
const MAX_STREAM_CHUNK: u64 = 2 * 1024 * 1024;
static NEXT_PREVIEW_JOB: AtomicU64 = AtomicU64::new(1);
static NEXT_STREAM_TOKEN: AtomicU64 = AtomicU64::new(1);
// Camera photos can be very large. Keep full-resolution decodes serialized so
// several visible cards cannot exhaust the process memory at once.
static IMAGE_DECODE_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThumbnailDto {
    pub url: String,
    pub cache_key: String,
    #[serde(skip)]
    pub cache_path: PathBuf,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaSourceDto {
    pub role: String,
    pub url: String,
    pub mime_type: String,
}

/// Compact file row for the preview metadata panel. Relative paths only.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PreviewFileDto {
    pub role: String,
    pub file_name: String,
    pub extension: String,
    pub size_bytes: i64,
    pub relative_path: String,
    pub exists_now: bool,
}

/// Item-level facts the modal needs without a second `media_get` round-trip.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PreviewMetaDto {
    pub display_name: String,
    pub capture_at: Option<String>,
    pub capture_date: Option<String>,
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub duration_ms: Option<i64>,
    pub total_size_bytes: i64,
    pub burst_group: Option<String>,
    pub favorite: bool,
    pub rating: i64,
    pub scan_state: String,
    pub files: Vec<PreviewFileDto>,
    pub tags: Vec<crate::db::Tag>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaPreviewDto {
    pub kind: MediaKind,
    pub sources: Vec<MediaSourceDto>,
    pub meta: PreviewMetaDto,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewJobStartDto {
    pub job_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewProgress {
    pub job_id: String,
    pub kind: &'static str,
    pub seq: u64,
    pub phase: &'static str,
    pub state: &'static str,
    pub current: Option<String>,
    pub processed: i64,
    pub total: i64,
    pub errors: Vec<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone)]
struct ActivePreviewJob {
    cancel: Arc<AtomicBool>,
}

#[derive(Debug, Clone)]
pub struct PreviewJobManagerState {
    jobs: Arc<Mutex<HashMap<String, ActivePreviewJob>>>,
}

impl PreviewJobManagerState {
    pub fn new() -> Self {
        Self {
            jobs: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn start(&self) -> Result<(String, Arc<AtomicBool>), crate::errors::AppError> {
        let mut jobs = self
            .jobs
            .lock()
            .map_err(|_| crate::errors::AppError::internal("预览任务状态锁已损坏"))?;
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let job_id = format!(
            "preview-{stamp}-{}",
            NEXT_PREVIEW_JOB.fetch_add(1, Ordering::Relaxed)
        );
        let cancel = Arc::new(AtomicBool::new(false));
        jobs.insert(
            job_id.clone(),
            ActivePreviewJob {
                cancel: cancel.clone(),
            },
        );
        Ok((job_id, cancel))
    }

    pub fn cancel(&self, job_id: &str) -> Result<(), crate::errors::AppError> {
        let jobs = self
            .jobs
            .lock()
            .map_err(|_| crate::errors::AppError::internal("预览任务状态锁已损坏"))?;
        jobs.get(job_id)
            .ok_or_else(|| crate::errors::AppError::job_not_found("预览任务不存在"))?
            .cancel
            .store(true, Ordering::Relaxed);
        Ok(())
    }

    pub fn finish(&self, job_id: &str) {
        if let Ok(mut jobs) = self.jobs.lock() {
            jobs.remove(job_id);
        }
    }

    pub fn shared(&self) -> Self {
        Self {
            jobs: self.jobs.clone(),
        }
    }
}

#[derive(Debug, Clone)]
struct StreamEntry {
    path: PathBuf,
    root: PathBuf,
    mime_type: String,
}

#[derive(Debug, Clone, Default)]
pub struct MediaStreamRegistry {
    entries: Arc<Mutex<HashMap<String, StreamEntry>>>,
}

impl MediaStreamRegistry {
    pub fn register(&self, path: PathBuf, root: PathBuf, mime_type: String) -> String {
        let token = format!(
            "{}-{}",
            NEXT_STREAM_TOKEN.fetch_add(1, Ordering::Relaxed),
            unique_suffix()
        );
        if let Ok(mut entries) = self.entries.lock() {
            entries.insert(
                token.clone(),
                StreamEntry {
                    path,
                    root,
                    mime_type,
                },
            );
        }
        token
    }

    fn get(&self, token: &str) -> Option<StreamEntry> {
        self.entries.lock().ok()?.get(token).cloned()
    }
}

fn unique_suffix() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos()
}

/// Serve `camlib://localhost/<token>` with bounded range reads. Browsers use
/// Range requests for seeking and playback, so only one small chunk is held in
/// memory at a time.
pub fn serve_stream(
    registry: &MediaStreamRegistry,
    request: Request<Vec<u8>>,
) -> Response<Vec<u8>> {
    let token = request.uri().path().trim_matches('/');
    let Some(entry) = registry.get(token) else {
        return response(StatusCode::NOT_FOUND, "text/plain", Vec::new());
    };
    let Ok(path) = fs::canonicalize(&entry.path) else {
        return response(StatusCode::NOT_FOUND, "text/plain", Vec::new());
    };
    let Ok(root) = fs::canonicalize(&entry.root) else {
        return response(StatusCode::NOT_FOUND, "text/plain", Vec::new());
    };
    if !path.starts_with(&root) {
        return response(StatusCode::FORBIDDEN, "text/plain", Vec::new());
    }
    let Ok(metadata) = fs::metadata(&path) else {
        return response(StatusCode::NOT_FOUND, "text/plain", Vec::new());
    };
    let length = metadata.len();
    if length == 0 {
        return response(
            StatusCode::RANGE_NOT_SATISFIABLE,
            &entry.mime_type,
            Vec::new(),
        );
    }
    let (start, requested_end, mut partial) = match request
        .headers()
        .get(header::RANGE)
        .and_then(|value| value.to_str().ok())
    {
        Some(value) => match parse_range(value, length) {
            Some((start, end)) => (start, end, true),
            None => {
                return response(
                    StatusCode::RANGE_NOT_SATISFIABLE,
                    &entry.mime_type,
                    Vec::new(),
                )
            }
        },
        // A video request without Range must still be bounded. The browser
        // will continue with subsequent ranges after this initial 206.
        None if entry.mime_type.starts_with("video/") => {
            (0, length.saturating_sub(1).min(MAX_STREAM_CHUNK - 1), true)
        }
        None => (0, length.saturating_sub(1), false),
    };
    let end = requested_end.min(start.saturating_add(MAX_STREAM_CHUNK - 1));
    partial = partial || end + 1 < length;
    let count = end.saturating_sub(start).saturating_add(1);
    let Ok(mut file) = File::open(&path) else {
        return response(StatusCode::NOT_FOUND, "text/plain", Vec::new());
    };
    if file.seek(SeekFrom::Start(start)).is_err() {
        return response(StatusCode::INTERNAL_SERVER_ERROR, "text/plain", Vec::new());
    }
    let mut body = vec![0; count as usize];
    if file.read_exact(&mut body).is_err() {
        return response(StatusCode::INTERNAL_SERVER_ERROR, "text/plain", Vec::new());
    }
    let status = if partial {
        StatusCode::PARTIAL_CONTENT
    } else {
        StatusCode::OK
    };
    let mut builder = Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, entry.mime_type)
        // Every registry token points at one immutable version of a file. Let
        // WebView2 retain decoded thumbnails across DOM redraws and navigation.
        .header(header::CACHE_CONTROL, "public, max-age=31536000, immutable")
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CONTENT_LENGTH, body.len().to_string());
    if partial {
        builder = builder.header(
            header::CONTENT_RANGE,
            format!("bytes {start}-{end}/{length}"),
        );
    }
    if request.method() == Method::HEAD {
        builder
            .body(Vec::new())
            .unwrap_or_else(|_| Response::new(Vec::new()))
    } else {
        builder
            .body(body)
            .unwrap_or_else(|_| Response::new(Vec::new()))
    }
}

fn response(status: StatusCode, mime_type: &str, body: Vec<u8>) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, mime_type)
        .body(body)
        .unwrap_or_else(|_| Response::new(Vec::new()))
}

fn parse_range(value: &str, length: u64) -> Option<(u64, u64)> {
    if length == 0 || !value.starts_with("bytes=") {
        return None;
    }
    let range = value[6..].split(',').next()?.trim();
    let (start, end) = range.split_once('-')?;
    if start.is_empty() {
        let suffix = end.parse::<u64>().ok()?.min(length);
        return Some((length - suffix, length - 1));
    }
    let start = start.parse::<u64>().ok()?;
    if start >= length {
        return None;
    }
    let end = if end.is_empty() {
        length - 1
    } else {
        end.parse::<u64>().ok()?.min(length - 1)
    };
    (start <= end).then_some((start, end))
}

pub fn thumbnail_for_item(
    details: &MediaItemDetails,
    root: &Path,
    cache_dir: &Path,
    width: u32,
    app: Option<&AppHandle>,
    cancel: Option<&AtomicBool>,
) -> Result<ThumbnailDto, crate::errors::AppError> {
    let file = thumbnail_file(details)?;
    let source = resolve_media_path(root, &file.relative_path)?;
    let metadata = fs::metadata(&source)
        .map_err(|error| crate::errors::AppError::from(format!("读取媒体元数据失败: {error}")))?;
    let size = metadata.len();
    let modified = modified_signature(&metadata);
    let cache_key = thumbnail_cache_key(&file.relative_path, size, &modified, width, width);
    let directory = cache_dir
        .join("thumbs")
        .join(safe_component(&details.item.library_id));
    fs::create_dir_all(&directory)
        .map_err(|error| crate::errors::AppError::from(format!("创建缩略图缓存失败: {error}")))?;
    let target = directory.join(format!("{cache_key}.jpg"));
    if !target.is_file() {
        let temp = directory.join(format!(".{cache_key}.{}.tmp", unique_suffix()));
        // The previous H-drive viewer may already have a fresh 480px JPEG for
        // this exact source. Importing its small cache file is dramatically
        // faster than reopening the original on a mechanical disk, and keeps
        // Camlib independent after the one-time copy into its SSD cache.
        let result = if import_legacy_thumbnail(root, &file.relative_path, &source, &temp) {
            Ok(())
        } else if is_image(&file.extension) {
            generate_image_thumbnail(&source, &temp, width)
        } else {
            let app =
                app.ok_or_else(|| crate::errors::AppError::thumbnail("视频缩略图需要应用上下文"))?;
            generate_ffmpeg_thumbnail(app, &source, &temp, width, cancel)
        };
        if let Err(error) = result {
            let _ = fs::remove_file(&temp);
            return Err(error);
        }
        fs::rename(&temp, &target).map_err(|error| {
            crate::errors::AppError::from(format!("提交缩略图缓存失败: {error}"))
        })?;
    }
    Ok(ThumbnailDto {
        url: String::new(),
        cache_key,
        cache_path: target,
    })
}

fn import_legacy_thumbnail(root: &Path, relative_path: &str, source: &Path, target: &Path) -> bool {
    let parts = Path::new(relative_path)
        .components()
        .filter_map(|part| match part {
            Component::Normal(value) => value.to_str(),
            _ => None,
        })
        .collect::<Vec<_>>();
    let Some(year_index) = parts
        .iter()
        .position(|part| part.len() == 4 && part.bytes().all(|value| value.is_ascii_digit()))
    else {
        return false;
    };
    let Some(month) = parts
        .get(year_index + 1)
        .filter(|part| part.len() == 2 && part.bytes().all(|value| value.is_ascii_digit()))
    else {
        return false;
    };
    let Some(stem) = Path::new(relative_path).file_stem() else {
        return false;
    };
    let Some(library_parent) = root.parent() else {
        return false;
    };
    let legacy_root = library_parent
        .join("media-viewer")
        .join("assets")
        .join("thumbs");
    let candidate = legacy_root
        .join(format!("{}-{month}", parts[year_index]))
        .join(stem)
        .with_extension("jpg");
    let (Ok(candidate_path), Ok(legacy_root_path)) =
        (fs::canonicalize(&candidate), fs::canonicalize(&legacy_root))
    else {
        return false;
    };
    if !candidate_path.starts_with(legacy_root_path) {
        return false;
    }
    let (Ok(source_meta), Ok(thumb_meta)) = (fs::metadata(source), fs::metadata(&candidate_path))
    else {
        return false;
    };
    if thumb_meta.len() == 0
        || matches!(
            (thumb_meta.modified(), source_meta.modified()),
            (Ok(thumb_time), Ok(source_time)) if thumb_time < source_time
        )
    {
        return false;
    }
    fs::copy(candidate_path, target).is_ok()
}

pub fn stream_url(token: &str) -> String {
    if cfg!(windows) {
        format!("http://camlib.localhost/{token}")
    } else {
        format!("camlib://localhost/{token}")
    }
}

pub fn thumbnail_cache_key(
    relative_path: &str,
    size: u64,
    modified: &str,
    width: u32,
    height: u32,
) -> String {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    relative_path.hash(&mut hasher);
    size.hash(&mut hasher);
    modified.hash(&mut hasher);
    let path_part = safe_component(relative_path);
    let path_part = if path_part.len() > 96 {
        path_part[..96].to_owned()
    } else {
        path_part
    };
    format!(
        "{path_part}-size{size}-mtime{}-{width}x{height}-v{THUMBNAIL_PROCESSOR_VERSION}-{:016x}",
        safe_component(modified),
        hasher.finish()
    )
}

fn generate_image_thumbnail(
    source: &Path,
    target: &Path,
    width: u32,
) -> Result<(), crate::errors::AppError> {
    let _decode_guard = IMAGE_DECODE_LOCK
        .lock()
        .map_err(|_| crate::errors::AppError::thumbnail("图片解码锁已损坏"))?;
    let orientation = read_exif_orientation(source);
    let image = ImageReader::open(source)
        .map_err(|error| crate::errors::AppError::from(format!("打开图片失败: {error}")))?
        .with_guessed_format()
        .map_err(|error| crate::errors::AppError::from(format!("识别图片格式失败: {error}")))?
        .decode()
        .map_err(|error| crate::errors::AppError::from(format!("解码图片失败: {error}")))?;
    let image = apply_orientation(image, orientation);
    let thumbnail = image.thumbnail(width, width);
    let mut output = File::create(target)
        .map_err(|error| crate::errors::AppError::from(format!("创建图片缩略图失败: {error}")))?;
    let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut output, 84);
    encoder
        .encode_image(&thumbnail)
        .map_err(|error| crate::errors::AppError::from(format!("编码图片缩略图失败: {error}")))
}

fn generate_ffmpeg_thumbnail(
    app: &AppHandle,
    source: &Path,
    target: &Path,
    width: u32,
    cancel: Option<&AtomicBool>,
) -> Result<(), crate::errors::AppError> {
    let ffmpeg = resolve_ffmpeg(app)?;
    let scale = format!("scale={width}:-2:force_original_aspect_ratio=decrease");
    let mut child = Command::new(ffmpeg)
        .args([
            "-nostdin",
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-ss",
            "0",
            "-i",
        ])
        .arg(source)
        .args(["-frames:v", "1", "-vf"])
        .arg(scale)
        .args(["-q:v", "3", "-f", "image2", "-vcodec", "mjpeg"])
        .arg(target)
        .stdout(Stdio::null())
        // Do not pipe stderr without draining it while waiting. A malformed
        // media file can fill the pipe and leave ffmpeg waiting forever.
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| crate::errors::AppError::from(format!("启动 ffmpeg 失败: {error}")))?;
    let deadline = Instant::now() + Duration::from_secs(30);
    let status = loop {
        if cancel.is_some_and(|value| value.load(Ordering::Relaxed)) {
            let _ = child.kill();
            let _ = child.wait();
            let _ = fs::remove_file(target);
            return Err(crate::errors::AppError::cancelled("用户取消视频首帧处理"));
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            let _ = fs::remove_file(target);
            return Err(crate::errors::AppError::thumbnail("视频首帧处理超时"));
        }
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => std::thread::sleep(std::time::Duration::from_millis(25)),
            Err(error) => {
                return Err(crate::errors::AppError::from(format!(
                    "等待 ffmpeg 失败: {error}"
                )))
            }
        }
    };
    if !status.success() {
        return Err(crate::errors::AppError::thumbnail("ffmpeg 首帧失败"));
    }
    if !target.is_file() {
        return Err(crate::errors::AppError::thumbnail("ffmpeg 未生成首帧"));
    }
    Ok(())
}

pub fn resolve_ffmpeg(app: &AppHandle) -> Result<PathBuf, crate::errors::AppError> {
    if let Ok(path) = env::var("CAMLIB_FFMPEG_PATH") {
        let path = PathBuf::from(path);
        if path.is_file() {
            return Ok(path);
        }
        return Err(crate::errors::AppError::thumbnail(
            "CAMLIB_FFMPEG_PATH 不存在或不是文件",
        ));
    }
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|error| crate::errors::AppError::from(format!("无法定位应用资源目录: {error}")))?;
    let packaged = [
        resource_dir.join("ffmpeg").join(if cfg!(windows) {
            "ffmpeg.exe"
        } else {
            "ffmpeg"
        }),
        resource_dir.join(if cfg!(windows) {
            "ffmpeg.exe"
        } else {
            "ffmpeg"
        }),
    ];
    if let Some(path) = packaged.into_iter().find(|path| path.is_file()) {
        return Ok(path);
    }
    // Development uses the ffmpeg executable installed on PATH.
    if Command::new(if cfg!(windows) {
        "ffmpeg.exe"
    } else {
        "ffmpeg"
    })
    .arg("-version")
    .output()
    .is_ok()
    {
        return Ok(PathBuf::from(if cfg!(windows) {
            "ffmpeg.exe"
        } else {
            "ffmpeg"
        }));
    }
    // Windows GUI applications can keep the environment inherited from
    // Explorer, which may predate a WinGet installation and therefore omit
    // the newly-added user PATH entry. Resolve the package directly as a
    // fallback so preview generation does not depend on an Explorer restart.
    #[cfg(windows)]
    if let Some(path) = find_winget_ffmpeg() {
        return Ok(path);
    }
    Err(crate::errors::AppError::thumbnail(
        "找不到 ffmpeg：开发环境请安装到 PATH，打包环境应提供 resources/ffmpeg/ffmpeg.exe",
    ))
}

#[cfg(windows)]
fn find_winget_ffmpeg() -> Option<PathBuf> {
    let packages = PathBuf::from(env::var_os("LOCALAPPDATA")?)
        .join("Microsoft")
        .join("WinGet")
        .join("Packages");
    let package = fs::read_dir(packages)
        .ok()?
        .filter_map(Result::ok)
        .find(|entry| {
            entry
                .file_name()
                .to_string_lossy()
                .starts_with("Gyan.FFmpeg_")
        })?;
    fs::read_dir(package.path())
        .ok()?
        .filter_map(Result::ok)
        .map(|entry| entry.path().join("bin").join("ffmpeg.exe"))
        .find(|path| path.is_file())
}

pub fn preview_meta(details: &MediaItemDetails) -> PreviewMetaDto {
    PreviewMetaDto {
        display_name: details.item.display_name.clone(),
        capture_at: details.item.capture_at.clone(),
        capture_date: details.item.capture_date.clone(),
        width: details.item.width,
        height: details.item.height,
        duration_ms: details.item.duration_ms,
        total_size_bytes: details.item.total_size_bytes,
        burst_group: details.item.burst_group.clone(),
        favorite: details.favorite,
        rating: details.item.rating,
        scan_state: match details.item.scan_state {
            ScanState::Present => "present",
            ScanState::Missing => "missing",
            ScanState::Ambiguous => "ambiguous",
            ScanState::Error => "error",
        }
        .to_owned(),
        files: details
            .files
            .iter()
            .map(|file| PreviewFileDto {
                role: match file.role {
                    MediaFileRole::LivePhoto => "live_photo",
                    MediaFileRole::LiveVideo => "live_video",
                    MediaFileRole::Single => "single",
                }
                .to_owned(),
                file_name: file.file_name.clone(),
                extension: file.extension.clone(),
                size_bytes: file.size_bytes,
                relative_path: file.relative_path.clone(),
                exists_now: file.exists_now,
            })
            .collect(),
        tags: details.tags.clone(),
    }
}

pub fn preview_sources(
    details: &MediaItemDetails,
    root: &Path,
    registry: &MediaStreamRegistry,
) -> Result<MediaPreviewDto, crate::errors::AppError> {
    let mut sources = Vec::new();
    for file in &details.files {
        if !file.exists_now {
            continue;
        }
        let path = resolve_media_path(root, &file.relative_path)?;
        let role = match file.role {
            MediaFileRole::LivePhoto => "photo",
            MediaFileRole::LiveVideo => "video",
            MediaFileRole::Single => "single",
        };
        let token = registry.register(
            path,
            root.to_path_buf(),
            mime_for_extension(&file.extension).to_owned(),
        );
        let url = stream_url(&token);
        sources.push(MediaSourceDto {
            role: role.to_owned(),
            url,
            mime_type: mime_for_extension(&file.extension).to_owned(),
        });
    }
    if sources.is_empty() {
        return Err(crate::errors::AppError::media_missing("媒体文件不可用"));
    }
    Ok(MediaPreviewDto {
        kind: details.item.kind.clone(),
        sources,
        meta: preview_meta(details),
    })
}

fn thumbnail_file(details: &MediaItemDetails) -> Result<&MediaFile, crate::errors::AppError> {
    details
        .files
        .iter()
        .find(|file| {
            file.exists_now
                && (details.item.kind != MediaKind::Live || file.role == MediaFileRole::LivePhoto)
        })
        .or_else(|| details.files.iter().find(|file| file.exists_now))
        .ok_or_else(|| crate::errors::AppError::media_missing("媒体文件不可用"))
}

fn resolve_media_path(root: &Path, relative: &str) -> Result<PathBuf, crate::errors::AppError> {
    let relative_path = Path::new(relative);
    if relative.is_empty()
        || relative_path.is_absolute()
        || relative_path.components().any(|component| {
            matches!(
                component,
                Component::ParentDir
                    | Component::CurDir
                    | Component::RootDir
                    | Component::Prefix(_)
            )
        })
    {
        return Err(crate::errors::AppError::path_outside_root(
            "媒体相对路径无效",
        ));
    }
    let root = fs::canonicalize(root).map_err(|error| {
        crate::errors::AppError::library_offline(format!("媒体库不可用: {error}"))
    })?;
    let path = fs::canonicalize(root.join(relative_path)).map_err(|error| {
        crate::errors::AppError::media_missing(format!("媒体文件不可用: {error}"))
    })?;
    // Component-aware starts_with: `C:\DCIM-local-evil` must not pass as
    // contained under `C:\DCIM-local`.
    if !path.starts_with(&root) {
        return Err(crate::errors::AppError::path_outside_root("媒体路径越界"));
    }
    Ok(path)
}

fn modified_signature(metadata: &fs::Metadata) -> String {
    metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis().to_string())
        .unwrap_or_else(|| "0".to_owned())
}

fn safe_component(value: &str) -> String {
    value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.') {
                character
            } else {
                '_'
            }
        })
        .collect()
}

fn is_image(extension: &str) -> bool {
    matches!(
        extension.to_ascii_lowercase().as_str(),
        "jpg" | "jpeg" | "png" | "webp" | "gif"
    )
}

fn read_exif_orientation(path: &Path) -> u16 {
    let Ok(file) = File::open(path) else {
        return 1;
    };
    let mut reader = std::io::BufReader::new(file);
    let Ok(exif) = exif::Reader::new().read_from_container(&mut reader) else {
        return 1;
    };
    exif.get_field(exif::Tag::Orientation, exif::In::PRIMARY)
        .and_then(|field| match &field.value {
            exif::Value::Short(values) => values.first().copied(),
            _ => None,
        })
        .unwrap_or(1)
}

fn apply_orientation(image: DynamicImage, orientation: u16) -> DynamicImage {
    match orientation {
        2 => image.fliph(),
        3 => image.rotate180(),
        4 => image.flipv(),
        5 => image.rotate90().fliph(),
        6 => image.rotate90(),
        7 => image.rotate90().flipv(),
        8 => image.rotate270(),
        _ => image,
    }
}

pub fn mime_for_extension(extension: &str) -> &'static str {
    match extension.to_ascii_lowercase().as_str() {
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "heic" => "image/heic",
        "heif" => "image/heif",
        "mp4" => "video/mp4",
        "mov" => "video/quicktime",
        "m4v" => "video/x-m4v",
        "webm" => "video/webm",
        "avi" => "video/x-msvideo",
        _ => "application/octet-stream",
    }
}

pub fn run_thumbnail_job(
    app: &AppHandle,
    repository: &Repository,
    root: &Path,
    cache_dir: &Path,
    library_id: &str,
    job_id: &str,
    cancel: &AtomicBool,
) {
    let items = match repository.query_media(crate::db::MediaQuery {
        library_id: library_id.to_owned(),
        offset: 0,
        limit: 100_000,
        ..Default::default()
    }) {
        Ok(page) => page.items,
        Err(error) => {
            emit_terminal(
                app,
                job_id,
                "failed",
                0,
                0,
                vec![error.to_string()],
                Some(error.to_string()),
            );
            return;
        }
    };
    let total = items.len() as i64;
    let mut errors = Vec::new();
    for (index, item) in items.iter().enumerate() {
        if cancel.load(Ordering::Relaxed) {
            emit_terminal(app, job_id, "cancelled", index as i64, total, errors, None);
            return;
        }
        let details = match repository.get_media_item_details(&item.id) {
            Ok(Some(details)) => details,
            Ok(None) => {
                errors.push("媒体不存在".to_owned());
                continue;
            }
            Err(error) => {
                errors.push(error.to_string());
                continue;
            }
        };
        if let Err(error) =
            thumbnail_for_item(&details, root, cache_dir, 320, Some(app), Some(cancel))
        {
            errors.push(format!("{}: {error}", item.display_name));
        }
        if cancel.load(Ordering::Relaxed) {
            emit_terminal(
                app,
                job_id,
                "cancelled",
                index as i64 + 1,
                total,
                errors,
                None,
            );
            return;
        }
        emit_progress(
            app,
            PreviewProgress {
                job_id: job_id.to_owned(),
                kind: "thumbnail",
                seq: index as u64,
                phase: "thumbnailing",
                state: "running",
                current: Some(item.display_name.clone()),
                processed: index as i64 + 1,
                total,
                errors: vec![],
                error: None,
            },
        );
    }
    let state = if errors.is_empty() {
        "completed"
    } else {
        "failed"
    };
    emit_terminal(
        app,
        job_id,
        state,
        total,
        total,
        errors.clone(),
        errors.first().cloned(),
    );
}

fn emit_progress(app: &AppHandle, progress: PreviewProgress) {
    let _ = app.emit("preview-progress", progress);
}
fn emit_terminal(
    app: &AppHandle,
    job_id: &str,
    state: &'static str,
    processed: i64,
    total: i64,
    errors: Vec<String>,
    error: Option<String>,
) {
    emit_progress(
        app,
        PreviewProgress {
            job_id: job_id.to_owned(),
            kind: "thumbnail",
            seq: u64::MAX,
            phase: "finalizing",
            state,
            current: None,
            processed,
            total,
            errors,
            error,
        },
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{MediaFile, MediaItem, Tag};
    use image::GenericImageView;

    fn sample_item(kind: MediaKind, display_name: &str) -> MediaItem {
        MediaItem {
            id: "item-1".to_owned(),
            library_id: "lib-1".to_owned(),
            logical_key: "2026/01/IMG_0001".to_owned(),
            kind,
            display_name: display_name.to_owned(),
            capture_at: Some("unix-ms:1700000000000".to_owned()),
            capture_date: Some("2026-01-15".to_owned()),
            width: Some(4032),
            height: Some(3024),
            duration_ms: Some(3200),
            total_size_bytes: 4_500_000,
            burst_group: None,
            metadata_json: None,
            scan_state: ScanState::Present,
            first_seen_at: "unix-ms:1".to_owned(),
            last_seen_at: "unix-ms:2".to_owned(),
            favorite: true,
            rating: 4,
        }
    }

    fn sample_file(role: MediaFileRole, relative: &str, extension: &str, size: i64) -> MediaFile {
        MediaFile {
            id: format!("file-{relative}"),
            media_item_id: "item-1".to_owned(),
            library_id: "lib-1".to_owned(),
            role,
            relative_path: relative.to_owned(),
            file_name: Path::new(relative)
                .file_name()
                .unwrap()
                .to_string_lossy()
                .into_owned(),
            extension: extension.to_owned(),
            size_bytes: size,
            modified_at: "unix-ms:3".to_owned(),
            content_hash: None,
            hash_algorithm: None,
            file_identity: None,
            exists_now: true,
            last_scanned_at: "unix-ms:4".to_owned(),
        }
    }

    #[test]
    fn cache_key_contains_path_size_mtime_and_dimensions() {
        let key = thumbnail_cache_key("2026/01/IMG_0001.JPG", 42, "unix-ms:123", 320, 320);
        assert!(key.contains("2026_01_IMG_0001.JPG"));
        assert!(key.contains("42"));
        assert!(key.contains("unix-ms_123"));
        assert!(key.contains("320x320"));
    }

    #[test]
    fn range_parser_handles_open_and_suffix_ranges() {
        assert_eq!(parse_range("bytes=10-", 100), Some((10, 99)));
        assert_eq!(parse_range("bytes=-10", 100), Some((90, 99)));
        assert_eq!(parse_range("bytes=100-", 100), None);
    }

    #[test]
    fn image_fixture_is_rotated_before_thumbnail_encoding_and_writes_only_cache_output() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("portrait.jpg");
        let target = temp.path().join("cache.jpg");
        let image =
            image::RgbImage::from_fn(2, 4, |x, y| image::Rgb([x as u8 * 80, y as u8 * 40, 12]));
        image.save(&source).unwrap();
        let rotated = apply_orientation(DynamicImage::ImageRgb8(image), 6);
        assert_eq!(rotated.dimensions(), (4, 2));
        generate_image_thumbnail(&source, &target, 320).unwrap();
        assert!(source.is_file());
        assert!(target.is_file());
    }

    #[test]
    fn fresh_legacy_thumbnail_is_imported_into_the_app_cache() {
        let temp = tempfile::tempdir().unwrap();
        let library = temp.path().join("DCIM-local");
        let relative = "2026/08/2026-08-11/视频/VID_001.mp4";
        let source = library.join(relative);
        fs::create_dir_all(source.parent().unwrap()).unwrap();
        fs::write(&source, b"video").unwrap();

        let legacy = temp
            .path()
            .join("media-viewer/assets/thumbs/2026-08/VID_001.jpg");
        fs::create_dir_all(legacy.parent().unwrap()).unwrap();
        fs::write(&legacy, b"jpeg thumbnail").unwrap();
        let target = temp.path().join("cache.jpg");

        assert!(import_legacy_thumbnail(
            &library, relative, &source, &target
        ));
        assert_eq!(fs::read(target).unwrap(), b"jpeg thumbnail");
    }

    #[test]
    fn preview_sources_expose_meta_and_live_roles_from_temp_media() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("library");
        let photo_rel = "2026/01/IMG_0001.HEIC";
        let video_rel = "2026/01/IMG_0001.MOV";
        for relative in [photo_rel, video_rel] {
            let path = root.join(relative);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(&path, b"media-bytes").unwrap();
        }

        let details = MediaItemDetails {
            item: sample_item(MediaKind::Live, "IMG_0001"),
            files: vec![
                sample_file(MediaFileRole::LivePhoto, photo_rel, "HEIC", 2_000_000),
                sample_file(MediaFileRole::LiveVideo, video_rel, "MOV", 2_500_000),
            ],
            favorite: true,
            tags: vec![Tag {
                id: "tag-1".to_owned(),
                name: "旅行".to_owned(),
                color: None,
                created_at: "unix-ms:5".to_owned(),
                media_count: 1,
            }],
        };

        let registry = MediaStreamRegistry::default();
        let dto = preview_sources(&details, &root, &registry).expect("preview should succeed");
        assert_eq!(dto.kind, MediaKind::Live);
        assert_eq!(dto.sources.len(), 2);
        assert_eq!(dto.sources[0].role, "photo");
        assert_eq!(dto.sources[1].role, "video");
        assert!(dto.sources[0].url.contains("http") || dto.sources[0].url.contains("camlib://"));
        assert_eq!(dto.meta.display_name, "IMG_0001");
        assert_eq!(dto.meta.width, Some(4032));
        assert_eq!(dto.meta.height, Some(3024));
        assert_eq!(dto.meta.duration_ms, Some(3200));
        assert_eq!(dto.meta.total_size_bytes, 4_500_000);
        assert_eq!(dto.meta.capture_date.as_deref(), Some("2026-01-15"));
        assert!(dto.meta.favorite);
        assert_eq!(dto.meta.rating, 4);
        assert_eq!(dto.meta.scan_state, "present");
        assert_eq!(dto.meta.files.len(), 2);
        assert_eq!(dto.meta.files[0].role, "live_photo");
        assert_eq!(dto.meta.files[1].role, "live_video");
        assert_eq!(dto.meta.tags.len(), 1);
        assert_eq!(dto.meta.tags[0].name, "旅行");
        assert_eq!(dto.meta.tags[0].id, "tag-1");
        // Metadata panel must never leak an absolute filesystem path.
        for file in &dto.meta.files {
            assert!(!file.relative_path.contains(':'));
            assert!(Path::new(&file.relative_path).is_relative());
        }
    }

    #[test]
    fn preview_sources_fail_when_all_files_missing() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("library");
        fs::create_dir_all(&root).unwrap();
        let mut details = MediaItemDetails {
            item: sample_item(MediaKind::Photo, "IMG_x"),
            files: vec![sample_file(
                MediaFileRole::Single,
                "2026/01/gone.jpg",
                "jpg",
                10,
            )],
            favorite: false,
            tags: vec![],
        };
        details.files[0].exists_now = false;
        let registry = MediaStreamRegistry::default();
        assert!(preview_sources(&details, &root, &registry).is_err());
    }
}
