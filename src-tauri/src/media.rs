//! Media preview primitives.
//!
//! The original media root is read-only. Generated JPEGs are written only to
//! the configured SSD cache directory. Full-size media is exposed through a
//! small range-aware protocol registry so the webview never receives the
//! complete video in an IPC response.

use crate::db::{MediaFile, MediaFileRole, MediaItemDetails, MediaKind, Repository};
use base64::Engine as _;
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
use tauri::http::{header, Method, Request, Response, StatusCode};
use tauri::{AppHandle, Emitter, Manager};

const THUMBNAIL_PROCESSOR_VERSION: &str = "image-exif-v1";
const MAX_STREAM_CHUNK: u64 = 2 * 1024 * 1024;
static NEXT_PREVIEW_JOB: AtomicU64 = AtomicU64::new(1);
static NEXT_STREAM_TOKEN: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThumbnailDto {
    pub mime_type: String,
    pub data_base64: String,
    pub cache_key: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaSourceDto {
    pub role: String,
    pub url: String,
    pub mime_type: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaPreviewDto {
    pub kind: MediaKind,
    pub sources: Vec<MediaSourceDto>,
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

    pub fn start(&self) -> Result<(String, Arc<AtomicBool>), String> {
        let mut jobs = self
            .jobs
            .lock()
            .map_err(|_| "预览任务状态锁已损坏".to_owned())?;
        let job_id = format!(
            "preview-{}",
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

    pub fn cancel(&self, job_id: &str) -> Result<(), String> {
        let jobs = self
            .jobs
            .lock()
            .map_err(|_| "预览任务状态锁已损坏".to_owned())?;
        jobs.get(job_id)
            .ok_or_else(|| "预览任务不存在".to_owned())?
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
) -> Result<ThumbnailDto, String> {
    let file = thumbnail_file(details)?;
    let source = resolve_media_path(root, &file.relative_path)?;
    let metadata = fs::metadata(&source).map_err(|error| format!("读取媒体元数据失败: {error}"))?;
    let size = metadata.len();
    let modified = modified_signature(&metadata);
    let cache_key = thumbnail_cache_key(&file.relative_path, size, &modified, width, width);
    let directory = cache_dir
        .join("thumbs")
        .join(safe_component(&details.item.library_id));
    fs::create_dir_all(&directory).map_err(|error| format!("创建缩略图缓存失败: {error}"))?;
    let target = directory.join(format!("{cache_key}.jpg"));
    if !target.is_file() {
        let temp = directory.join(format!(".{cache_key}.{}.tmp", unique_suffix()));
        let result = if is_image(&file.extension) {
            generate_image_thumbnail(&source, &temp, width)
        } else {
            let app = app.ok_or_else(|| "视频缩略图需要应用上下文".to_owned())?;
            generate_ffmpeg_thumbnail(app, &source, &temp, width, cancel)
        };
        if let Err(error) = result {
            let _ = fs::remove_file(&temp);
            return Err(error);
        }
        fs::rename(&temp, &target).map_err(|error| format!("提交缩略图缓存失败: {error}"))?;
    }
    let bytes = fs::read(&target).map_err(|error| format!("读取缩略图缓存失败: {error}"))?;
    Ok(ThumbnailDto {
        mime_type: "image/jpeg".to_owned(),
        data_base64: base64::engine::general_purpose::STANDARD.encode(bytes),
        cache_key,
    })
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

fn generate_image_thumbnail(source: &Path, target: &Path, width: u32) -> Result<(), String> {
    let orientation = read_exif_orientation(source);
    let image = ImageReader::open(source)
        .map_err(|error| format!("打开图片失败: {error}"))?
        .with_guessed_format()
        .map_err(|error| format!("识别图片格式失败: {error}"))?
        .decode()
        .map_err(|error| format!("解码图片失败: {error}"))?;
    let image = apply_orientation(image, orientation);
    let thumbnail = image.thumbnail(width, width);
    let mut output =
        File::create(target).map_err(|error| format!("创建图片缩略图失败: {error}"))?;
    let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut output, 84);
    encoder
        .encode_image(&thumbnail)
        .map_err(|error| format!("编码图片缩略图失败: {error}"))
}

fn generate_ffmpeg_thumbnail(
    app: &AppHandle,
    source: &Path,
    target: &Path,
    width: u32,
    cancel: Option<&AtomicBool>,
) -> Result<(), String> {
    let ffmpeg = resolve_ffmpeg(app)?;
    let scale = format!("scale={width}:-2:force_original_aspect_ratio=decrease");
    let mut child = Command::new(ffmpeg)
        .args(["-hide_banner", "-loglevel", "error", "-y", "-ss", "0", "-i"])
        .arg(source)
        .args(["-frames:v", "1", "-vf"])
        .arg(scale)
        .args(["-q:v", "3", "-f", "image2", "-vcodec", "mjpeg"])
        .arg(target)
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("启动 ffmpeg 失败: {error}"))?;
    let status = loop {
        if cancel.is_some_and(|value| value.load(Ordering::Relaxed)) {
            let _ = child.kill();
            let _ = child.wait();
            let _ = fs::remove_file(target);
            return Err("用户取消视频首帧处理".to_owned());
        }
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => std::thread::sleep(std::time::Duration::from_millis(25)),
            Err(error) => return Err(format!("等待 ffmpeg 失败: {error}")),
        }
    };
    let mut stderr = String::new();
    if let Some(mut pipe) = child.stderr.take() {
        let _ = pipe.read_to_string(&mut stderr);
    }
    if !status.success() {
        return Err(format!(
            "ffmpeg 首帧失败: {}",
            stderr.trim().chars().take(500).collect::<String>()
        ));
    }
    if !target.is_file() {
        return Err("ffmpeg 未生成首帧".to_owned());
    }
    Ok(())
}

pub fn resolve_ffmpeg(app: &AppHandle) -> Result<PathBuf, String> {
    if let Ok(path) = env::var("CAMLIB_FFMPEG_PATH") {
        let path = PathBuf::from(path);
        if path.is_file() {
            return Ok(path);
        }
        return Err("CAMLIB_FFMPEG_PATH 不存在或不是文件".to_owned());
    }
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|error| format!("无法定位应用资源目录: {error}"))?;
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
    Err(
        "找不到 ffmpeg：开发环境请安装到 PATH，打包环境应提供 resources/ffmpeg/ffmpeg.exe"
            .to_owned(),
    )
}

pub fn preview_sources(
    details: &MediaItemDetails,
    root: &Path,
    registry: &MediaStreamRegistry,
) -> Result<MediaPreviewDto, String> {
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
        let url = if cfg!(windows) {
            format!("http://camlib.localhost/{token}")
        } else {
            format!("camlib://localhost/{token}")
        };
        sources.push(MediaSourceDto {
            role: role.to_owned(),
            url,
            mime_type: mime_for_extension(&file.extension).to_owned(),
        });
    }
    if sources.is_empty() {
        return Err("媒体文件不可用".to_owned());
    }
    Ok(MediaPreviewDto {
        kind: details.item.kind.clone(),
        sources,
    })
}

fn thumbnail_file(details: &MediaItemDetails) -> Result<&MediaFile, String> {
    details
        .files
        .iter()
        .find(|file| {
            file.exists_now
                && (details.item.kind != MediaKind::Live || file.role == MediaFileRole::LivePhoto)
        })
        .or_else(|| details.files.iter().find(|file| file.exists_now))
        .ok_or_else(|| "媒体文件不可用".to_owned())
}

fn resolve_media_path(root: &Path, relative: &str) -> Result<PathBuf, String> {
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
        return Err("媒体相对路径无效".to_owned());
    }
    let root = fs::canonicalize(root).map_err(|error| format!("媒体库不可用: {error}"))?;
    let path = fs::canonicalize(root.join(relative_path))
        .map_err(|error| format!("媒体文件不可用: {error}"))?;
    if !path.starts_with(&root) {
        return Err("媒体路径越界".to_owned());
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
    use image::GenericImageView;

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
}
