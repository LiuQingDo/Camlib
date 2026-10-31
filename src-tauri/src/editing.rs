//! Media editing: save-on-copy photo edits and video trims.
//!
//! Originals are never modified (see docs/architecture.md). An edit renders a
//! NEW file beside its source (`{stem}_edited{ext}`, collisions numbered) and
//! triggers an incremental scan so the result joins the library as its own
//! media item. Photo edits run inside the invoking command; video trims run as
//! a cancellable background job that reports `edit-progress` events, following
//! the library-merge job pattern.

use crate::backup::{ffmpeg_path_string, merge_and_verify, CopyError, TempGuard};
use crate::db::{LibraryState, MediaFile, MediaFileRole, Repository};
use crate::media::{hide_console_window, resolve_ffmpeg, resolve_media_path};
use image::imageops::crop_imm;
use image::{DynamicImage, ImageReader, Pixel, RgbImage, RgbaImage};
use serde::{Deserialize, Serialize};
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};

use crate::db::MediaItemDetails;
use crate::errors::AppError;

static NEXT_EDIT_JOB: AtomicU64 = AtomicU64::new(1);

const EDIT_PROGRESS_EVENT: &str = "edit-progress";
/// JPEG quality for rendered photo copies (0-100).
const EDITED_JPEG_QUALITY: u8 = 92;
/// Upper bound so a pathological name search can never spin forever.
const MAX_EDIT_COPIES: u32 = 1000;

fn next_job_id() -> String {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!(
        "edit-{stamp}-{}",
        NEXT_EDIT_JOB.fetch_add(1, Ordering::Relaxed)
    )
}

#[derive(Debug, Clone)]
pub struct EditJobManagerState {
    jobs: Arc<Mutex<Vec<Arc<AtomicBool>>>>,
}

impl EditJobManagerState {
    pub fn new() -> Self {
        Self {
            jobs: Arc::new(Mutex::new(Vec::new())),
        }
    }

    pub fn start(&self) -> Result<(String, Arc<AtomicBool>), AppError> {
        let mut jobs = self
            .jobs
            .lock()
            .map_err(|_| AppError::internal("编辑任务状态锁已损坏"))?;
        if !jobs.is_empty() {
            return Err(AppError::job_already_running("已有剪辑任务正在运行"));
        }
        let job_id = next_job_id();
        let cancel = Arc::new(AtomicBool::new(false));
        jobs.push(cancel.clone());
        Ok((job_id, cancel))
    }

    pub fn cancel(&self, _job_id: &str) -> Result<(), AppError> {
        let jobs = self
            .jobs
            .lock()
            .map_err(|_| AppError::internal("编辑任务状态锁已损坏"))?;
        let Some(job) = jobs.first() else {
            return Err(AppError::job_not_found("剪辑任务不存在"));
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

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CropRect {
    /// Relative 0..1 coordinates on the EXIF-oriented image, i.e. the space
    /// the browser shows when it renders the original file.
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
}

/// Flat parameter bundle for photo edits so the command keeps a simple
/// argument list while tests can build the whole struct at once.
#[derive(Debug, Clone, Copy)]
pub struct CropParams {
    pub crop: CropRect,
    /// Quarter turns clockwise applied to the cropped result: 0..=3.
    pub rotate90: i32,
    pub flip_h: bool,
    pub flip_v: bool,
    /// CSS-filter semantics: 1.0 = neutral.
    pub brightness: f32,
    pub contrast: f32,
    pub saturation: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrimParams {
    pub media_item_id: String,
    /// Keep [in_ms, out_ms) of the video. The frontend reads both off the
    /// loaded `<video>` element because the index does not store durations.
    pub in_ms: i64,
    pub out_ms: i64,
    /// false = stream copy (lossless, seconds); true = re-encode (exact cut).
    pub precise: bool,
}

/// Upper bound on segments per cut job so a bad call can never spawn
/// hundreds of ffmpeg runs.
pub const MAX_CUT_SEGMENTS: usize = 100;

/// One requested cut range of a multi-segment cut job; `merge` flags the
/// segment for the extra merged copy.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CutSegmentSpec {
    pub in_ms: i64,
    pub out_ms: i64,
    pub merge: bool,
}

#[derive(Debug, Clone)]
pub struct CutSegmentsParams {
    pub media_item_id: String,
    pub segments: Vec<CutSegmentSpec>,
    /// false = stream copy (lossless, seconds); true = re-encode (exact cut).
    pub precise: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditResultDto {
    pub file_name: String,
    pub relative_path: String,
    pub size_bytes: u64,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditJobStartDto {
    pub job_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditProgress {
    pub job_id: String,
    /// "trim" for single trims and multi-segment cuts alike.
    pub kind: &'static str,
    pub phase: &'static str,
    pub state: &'static str,
    /// 0..100, mapped over the whole job when a cut has several segments.
    pub percent: Option<f64>,
    pub error: Option<String>,
    pub result: Option<EditResultDto>,
    /// Multi-segment cuts only; omitted for plain trims.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub segment_index: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub segment_count: Option<usize>,
    /// Completed multi-segment cuts: every produced segment copy.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub results: Option<Vec<EditResultDto>>,
    /// Completed multi-segment cuts: the merged copy, when segments were flagged.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub merged_result: Option<EditResultDto>,
}

fn emit(app: &AppHandle, progress: EditProgress) {
    let _ = app.emit(EDIT_PROGRESS_EVENT, progress);
}

// ---------------------------------------------------------------------------
// Source selection
// ---------------------------------------------------------------------------

/// Image extensions the `image` crate can decode with the enabled features.
fn is_decodable_image(extension: &str) -> bool {
    matches!(
        extension.to_ascii_lowercase().as_str(),
        "jpg" | "jpeg" | "png" | "webp"
    )
}

/// HEIC/HEIF stills cannot be decoded by the `image` crate, but the bundled
/// ffmpeg usually extracts the primary still fine.
fn is_ffmpeg_image(extension: &str) -> bool {
    matches!(extension.to_ascii_lowercase().as_str(), "heic" | "heif")
}

fn is_editable_video(extension: &str) -> bool {
    matches!(
        extension.to_ascii_lowercase().as_str(),
        "mp4" | "mov" | "m4v" | "avi" | "mkv" | "webm"
    )
}

fn image_source_file(details: &MediaItemDetails) -> Option<&MediaFile> {
    details.files.iter().find(|file| {
        matches!(file.role, MediaFileRole::Single | MediaFileRole::LivePhoto)
            && (is_decodable_image(&file.extension) || is_ffmpeg_image(&file.extension))
    })
}

pub(crate) fn video_source_file(details: &MediaItemDetails) -> Option<&MediaFile> {
    details.files.iter().find(|file| {
        matches!(file.role, MediaFileRole::Single | MediaFileRole::LiveVideo)
            && is_editable_video(&file.extension)
    })
}

// ---------------------------------------------------------------------------
// Photo editing
// ---------------------------------------------------------------------------

/// Render an edited COPY of a photo beside the original. The original file is
/// never touched.
pub fn edit_image(
    app: &AppHandle,
    details: &MediaItemDetails,
    root: &Path,
    params: &CropParams,
) -> Result<EditResultDto, AppError> {
    let file = image_source_file(details)
        .ok_or_else(|| AppError::media_missing("没有可编辑的照片文件"))?;
    let source = resolve_media_path(root, &file.relative_path)?;
    let oriented = decode_edited_image(app, &source, &file.extension)?;
    let rendered = render_edit(&oriented, params)?;

    let extension = file.extension.to_ascii_lowercase();
    // PNG keeps its alpha channel; everything else (incl. HEIC) lands as JPEG
    // so output stays predictable and widely readable.
    let output_extension = if extension == "png" { "png" } else { "jpg" };
    let destination = edited_destination(&source, output_extension)?;
    let width = rendered.width();
    let height = rendered.height();
    let size_bytes = write_edited_image(&rendered, &destination, output_extension)?;

    let relative_path = destination
        .strip_prefix(root)
        .map(|value| value.to_string_lossy().replace('\\', "/"))
        .map_err(|_| AppError::path_outside_root("输出文件越出媒体库根目录"))?;
    Ok(EditResultDto {
        file_name: destination
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned(),
        relative_path,
        size_bytes,
        width,
        height,
    })
}

fn decode_edited_image(
    app: &AppHandle,
    source: &Path,
    extension: &str,
) -> Result<DynamicImage, AppError> {
    let _decode_guard = crate::media::IMAGE_DECODE_LOCK
        .lock()
        .map_err(|_| AppError::thumbnail("图片解码锁已损坏"))?;
    if is_decodable_image(extension) {
        return ImageReader::open(source)
            .map_err(|error| AppError::from(format!("打开图片失败: {error}")))?
            .with_guessed_format()
            .map_err(|error| AppError::from(format!("识别图片格式失败: {error}")))?
            .decode()
            .map_err(|error| AppError::from(format!("解码图片失败: {error}")));
    }
    if is_ffmpeg_image(extension) {
        return decode_with_ffmpeg(app, source);
    }
    Err(AppError::invalid_argument(format!(
        "{extension} 格式暂不支持编辑"
    )))
}

/// Extract the primary still of a HEIC/HEIF via ffmpeg into a temp PNG.
fn decode_with_ffmpeg(app: &AppHandle, source: &Path) -> Result<DynamicImage, AppError> {
    let ffmpeg = resolve_ffmpeg(app)?;
    let temp = std::env::temp_dir().join(format!("camlib-edit-{}.png", unique_suffix()));
    let guard = TempGuard::new(temp.clone());
    let mut command = Command::new(&ffmpeg);
    command
        .args(["-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i"])
        .arg(ffmpeg_path_string(source))
        .args(["-frames:v", "1"])
        .arg(ffmpeg_path_string(&temp))
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    hide_console_window(&mut command);
    let output = command
        .output()
        .map_err(|error| AppError::from(format!("启动 ffmpeg 解码失败: {error}")))?;
    if !output.status.success() || !temp.is_file() {
        return Err(AppError::thumbnail(
            "无法解码该图片（HEIC），内置解码器不支持此文件",
        ));
    }
    let image = ImageReader::open(&temp)
        .map_err(|error| AppError::from(format!("打开解码结果失败: {error}")))?
        .with_guessed_format()
        .map_err(|error| AppError::from(format!("识别解码格式失败: {error}")))?
        .decode()
        .map_err(|error| AppError::from(format!("解码图片失败: {error}")))?;
    drop(guard);
    Ok(image)
}

fn unique_suffix() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos()
}

/// Crop (relative rect on the oriented image) → rotate/flip → CSS-equivalent
/// adjustments. This mirrors the editor pipeline exactly: the crop rect is
/// drawn on the upright photo, rotation happens on the cropped result.
fn render_edit(oriented: &DynamicImage, params: &CropParams) -> Result<RgbaImage, AppError> {
    let (x0, y0, crop_w, crop_h) = crop_pixels(params.crop, oriented.width(), oriented.height())?;
    let cropped = crop_imm(oriented, x0, y0, crop_w, crop_h).to_image();
    let mut image = DynamicImage::ImageRgba8(cropped);
    for _ in 0..params.rotate90.rem_euclid(4) {
        image = image.rotate90();
    }
    if params.flip_h {
        image = image.fliph();
    }
    if params.flip_v {
        image = image.flipv();
    }
    let mut buffer = image.to_rgba8();
    apply_css_adjustments(
        &mut buffer,
        params.brightness,
        params.contrast,
        params.saturation,
    );
    Ok(buffer)
}

/// Resolve the relative crop rect to clamped integer pixels.
fn crop_pixels(rect: CropRect, width: u32, height: u32) -> Result<(u32, u32, u32, u32), AppError> {
    if !rect.x.is_finite()
        || !rect.y.is_finite()
        || !rect.w.is_finite()
        || !rect.h.is_finite()
        || rect.w <= 0.0
        || rect.h <= 0.0
    {
        return Err(AppError::invalid_argument("裁剪区域无效"));
    }
    let x = rect.x.clamp(0.0, 1.0);
    let y = rect.y.clamp(0.0, 1.0);
    let w = rect.w.clamp(0.0, 1.0 - x);
    let h = rect.h.clamp(0.0, 1.0 - y);
    let x0 = (x * width as f32).round() as u32;
    let y0 = (y * height as f32).round() as u32;
    let crop_w = ((w * width as f32).round() as u32).min(width.saturating_sub(x0));
    let crop_h = ((h * height as f32).round() as u32).min(height.saturating_sub(y0));
    if crop_w == 0 || crop_h == 0 {
        return Err(AppError::invalid_argument("裁剪区域过小，请重新调整"));
    }
    Ok((x0, y0, crop_w, crop_h))
}

/// Mirror the CSS filter list `brightness() contrast() saturate()` so the
/// saved pixels match what the editor preview showed. Alpha is preserved.
fn apply_css_adjustments(image: &mut RgbaImage, brightness: f32, contrast: f32, saturation: f32) {
    let brightness = clamp_adjust(brightness);
    let contrast = clamp_adjust(contrast);
    let saturation = clamp_adjust(saturation);
    let neutral = (brightness - 1.0).abs() < f32::EPSILON
        && (contrast - 1.0).abs() < f32::EPSILON
        && (saturation - 1.0).abs() < f32::EPSILON;
    if neutral {
        return;
    }
    for pixel in image.pixels_mut() {
        let channels = pixel.channels_mut();
        // CSS filters touch color channels only, never alpha.
        let mut rgb: [f32; 3] = [
            channels[0] as f32 * brightness,
            channels[1] as f32 * brightness,
            channels[2] as f32 * brightness,
        ];
        for value in &mut rgb {
            *value = (*value - 127.5) * contrast + 127.5;
        }
        // Standard CSS saturate() reduces to a luma blend (Rec. 709 weights).
        let luma = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
        for value in &mut rgb {
            *value = luma + (*value - luma) * saturation;
        }
        channels[0] = clamp_u8(rgb[0]);
        channels[1] = clamp_u8(rgb[1]);
        channels[2] = clamp_u8(rgb[2]);
    }
}

fn clamp_adjust(value: f32) -> f32 {
    if value.is_finite() {
        value.clamp(0.0, 3.0)
    } else {
        1.0
    }
}

fn clamp_u8(value: f32) -> u8 {
    value.round().clamp(0.0, 255.0) as u8
}

/// `{stem}_edited{ext}`, then `_edited_2`, `_edited_3` … never overwrites.
/// Editing an existing copy chains `_edited_N` instead of growing the stem.
fn edited_destination(source: &Path, output_extension: &str) -> Result<PathBuf, AppError> {
    let parent = source
        .parent()
        .ok_or_else(|| AppError::io("源文件路径无效"))?;
    let stem = source
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy()
        .into_owned();
    let base_stem = stem.strip_suffix("_edited").unwrap_or(&stem).to_owned();
    let extension = format!(".{output_extension}");
    for index in 1..MAX_EDIT_COPIES {
        let suffix = if index == 1 {
            "_edited".to_owned()
        } else {
            format!("_edited_{index}")
        };
        let candidate = parent.join(format!("{base_stem}{suffix}{extension}"));
        if !candidate.exists() {
            return Ok(candidate);
        }
    }
    Err(AppError::io("同名编辑副本过多，无法生成新文件名"))
}

/// Destination names for a multi-segment cut: `{stem}_edited_1..N`, plus
/// `{stem}_edited_merged` when flagged segments will be joined into one copy.
/// Names are chosen as a family — if any candidate is taken, the whole family
/// bumps to `…_2`, `…_3` … so segment numbers stay consistent and nothing is
/// ever overwritten. Re-cutting a copy chains on its base stem, matching
/// `edited_destination`.
fn cut_destinations(
    source: &Path,
    output_extension: &str,
    count: usize,
    want_merged: bool,
) -> Result<(Vec<PathBuf>, Option<PathBuf>), AppError> {
    let parent = source
        .parent()
        .ok_or_else(|| AppError::io("源文件路径无效"))?;
    let stem = source
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy()
        .into_owned();
    let base_stem = stem.strip_suffix("_edited").unwrap_or(&stem).to_owned();
    let extension = format!(".{output_extension}");
    for version in 1..MAX_EDIT_COPIES {
        let suffix = if version == 1 {
            String::new()
        } else {
            format!("_{version}")
        };
        let segments: Vec<PathBuf> = (1..=count)
            .map(|index| parent.join(format!("{base_stem}_edited_{index}{suffix}{extension}")))
            .collect();
        let merged = want_merged.then(|| {
            parent.join(format!("{base_stem}_edited_merged{suffix}{extension}"))
        });
        if segments.iter().chain(merged.iter()).all(|path| !path.exists()) {
            return Ok((segments, merged));
        }
    }
    Err(AppError::io("同名剪辑片段过多，无法生成新文件名"))
}

fn write_edited_image(
    image: &RgbaImage,
    destination: &Path,
    output_extension: &str,
) -> Result<u64, AppError> {
    use image::ImageEncoder;
    let file_name = destination
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .into_owned();
    // The dot prefix plus `.camlib-` keeps the scratch file out of the scan.
    let temp = destination.with_file_name(format!(".{file_name}.camlib-edit"));
    let mut guard = TempGuard::new(temp.clone());
    {
        let mut output = File::create(&temp)
            .map_err(|error| AppError::io(format!("创建编辑输出失败: {error}")))?;
        if output_extension == "png" {
            image::codecs::png::PngEncoder::new(&mut output)
                .write_image(
                    image.as_raw(),
                    image.width(),
                    image.height(),
                    image::ExtendedColorType::Rgba8,
                )
                .map_err(|error| AppError::from(format!("编码 PNG 失败: {error}")))?;
        } else {
            // JPEG has no alpha; camera photos are opaque so dropping it is safe.
            let rgb = RgbImage::from_fn(image.width(), image.height(), |x, y| {
                let pixel = image.get_pixel(x, y);
                image::Rgb([pixel.0[0], pixel.0[1], pixel.0[2]])
            });
            let encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(
                &mut output,
                EDITED_JPEG_QUALITY,
            );
            encoder
                .write_image(
                    rgb.as_raw(),
                    rgb.width(),
                    rgb.height(),
                    image::ExtendedColorType::Rgb8,
                )
                .map_err(|error| AppError::from(format!("编码 JPEG 失败: {error}")))?;
        }
        output
            .sync_all()
            .map_err(|error| AppError::io(format!("写入编辑输出失败: {error}")))?;
    }
    fs::rename(&temp, destination)
        .map_err(|error| AppError::io(format!("提交编辑输出失败: {error}")))?;
    guard.disarm();
    let metadata = fs::metadata(destination)
        .map_err(|error| AppError::io(format!("读取输出信息失败: {error}")))?;
    Ok(metadata.len())
}

// ---------------------------------------------------------------------------
// Video trimming
// ---------------------------------------------------------------------------

fn library_root(repository: &Repository, library_id: &str) -> Result<PathBuf, String> {
    let library = repository
        .get_library(library_id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "媒体库不存在".to_owned())?;
    if library.state != LibraryState::Available {
        return Err("媒体库当前不可用".to_owned());
    }
    Ok(PathBuf::from(library.root_path))
}

/// Kick off the incremental scan that brings freshly committed copies into
/// the index; a busy scan never fails the edit that produced them.
fn start_edit_scan(
    app: &AppHandle,
    scan_manager: &Arc<crate::scanner::ScanManagerState>,
    database_path: &Path,
    library_id: &str,
) {
    if let Ok((scan_job, scan_cancel)) = scan_manager.start(library_id) {
        crate::scanner::spawn_scan(
            app.clone(),
            scan_manager.clone(),
            database_path.to_path_buf(),
            library_id.to_owned(),
            scan_job,
            scan_cancel,
            false,
        );
    }
}

/// Launch a trim job on a background thread. Emits `edit-progress` and
/// triggers an incremental scan once the trimmed copy is committed.
pub fn spawn(
    app: AppHandle,
    manager: Arc<EditJobManagerState>,
    scan_manager: Arc<crate::scanner::ScanManagerState>,
    database_path: PathBuf,
    library_id: String,
    job_id: String,
    cancel: Arc<AtomicBool>,
    params: TrimParams,
) {
    std::thread::spawn(move || {
        let result = run_trim(&app, &database_path, &library_id, &job_id, &cancel, &params);
        match &result {
            Ok(done) => {
                emit(
                    &app,
                    EditProgress {
                        job_id: job_id.clone(),
                        kind: "trim",
                        phase: "finalizing",
                        state: "completed",
                        percent: Some(100.0),
                        error: None,
                        result: Some(done.clone()),
                        segment_index: None,
                        segment_count: None,
                        results: None,
                        merged_result: None,
                    },
                );
                // Bring the new copy into the index; a busy scan never fails
                // an otherwise successful trim.
                start_edit_scan(&app, &scan_manager, &database_path, &library_id);
            }
            Err(error) => {
                let cancelled = cancel.load(Ordering::Relaxed);
                emit(
                    &app,
                    EditProgress {
                        job_id: job_id.clone(),
                        kind: "trim",
                        phase: "trimming",
                        state: if cancelled { "cancelled" } else { "failed" },
                        percent: None,
                        error: Some(error.clone()),
                        result: None,
                        segment_index: None,
                        segment_count: None,
                        results: None,
                        merged_result: None,
                    },
                );
            }
        }
        manager.finish();
    });
}

fn run_trim(
    app: &AppHandle,
    database_path: &Path,
    library_id: &str,
    job_id: &str,
    cancel: &AtomicBool,
    params: &TrimParams,
) -> Result<EditResultDto, String> {
    let repository = Repository::open(database_path).map_err(|error| error.to_string())?;
    let root = library_root(&repository, library_id)?;
    let details = repository
        .get_media_item_details(&params.media_item_id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "媒体不存在".to_owned())?;
    let file = video_source_file(&details).ok_or_else(|| "没有可剪辑的视频文件".to_owned())?;
    if params.in_ms < 0 || params.out_ms <= params.in_ms {
        return Err("剪辑区间无效".to_owned());
    }
    let source =
        resolve_media_path(&root, &file.relative_path).map_err(|error| error.to_string())?;
    let ffmpeg = resolve_ffmpeg(app).map_err(|error| error.to_string())?;

    emit(
        app,
        EditProgress {
            job_id: job_id.to_owned(),
            kind: "trim",
            phase: "preparing",
            state: "running",
            percent: None,
            error: None,
            result: None,
            segment_index: None,
            segment_count: None,
            results: None,
            merged_result: None,
        },
    );

    let destination =
        edited_destination(&source, &file.extension).map_err(|error| error.to_string())?;
    let file_name = destination
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .into_owned();
    let extension = format!(".{}", file.extension);
    let temp = destination.with_file_name(format!(".{file_name}.camlib-edit{extension}"));
    let log_path = destination.with_file_name(format!(".{file_name}.camlib-edit.log"));
    let _ = fs::remove_file(&temp);
    let _ = fs::remove_file(&log_path);
    let mut temp_guard = TempGuard::new(temp.clone());
    let mut log_guard = TempGuard::new(log_path.clone());

    emit(
        app,
        EditProgress {
            job_id: job_id.to_owned(),
            kind: "trim",
            phase: "trimming",
            state: "running",
            percent: if params.precise { Some(0.0) } else { None },
            error: None,
            result: None,
            segment_index: None,
            segment_count: None,
            results: None,
            merged_result: None,
        },
    );

    let trim_result = run_ffmpeg_trim(
        &ffmpeg, &source, &temp, &log_path, params, cancel, job_id, app, None,
    );
    if trim_result.is_err() {
        // Guards drop here and remove the scratch files.
        let _ = (&temp_guard, &log_guard);
        return Err(trim_result.unwrap_err());
    }

    if let Err(error) = fs::rename(&temp, &destination) {
        return Err(format!("提交剪辑输出失败: {error}"));
    }
    temp_guard.disarm();
    log_guard.disarm();

    let metadata =
        fs::metadata(&destination).map_err(|error| format!("读取输出信息失败: {error}"))?;
    let relative_path = destination
        .strip_prefix(&root)
        .map(|value| value.to_string_lossy().replace('\\', "/"))
        .map_err(|_| "输出文件越出媒体库根目录".to_owned())?;
    Ok(EditResultDto {
        file_name,
        relative_path,
        size_bytes: metadata.len(),
        width: 0,
        height: 0,
    })
}

/// Progress mapping for one segment of a multi-segment cut job: the segment's
/// ffmpeg percent maps onto a whole-job percent and events carry the segment
/// position. Plain trims pass `None` and keep their per-segment percent.
#[derive(Debug, Clone, Copy)]
struct CutUnitProgress {
    /// 0-based unit index; the optional merged copy is the last unit.
    unit_index: usize,
    /// Segment count plus one when a merged copy follows.
    total_units: usize,
    /// Segment count, reported verbatim in progress events.
    segment_count: usize,
}

fn run_ffmpeg_trim(
    ffmpeg: &Path,
    source: &Path,
    temp: &Path,
    log_path: &Path,
    params: &TrimParams,
    cancel: &AtomicBool,
    job_id: &str,
    app: &AppHandle,
    unit: Option<CutUnitProgress>,
) -> Result<(), String> {
    let in_seconds = format!("{:.3}", params.in_ms as f64 / 1000.0);
    let duration_seconds = format!("{:.3}", (params.out_ms - params.in_ms) as f64 / 1000.0);
    let mut log_file = OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .open(log_path)
        .map_err(|error| format!("创建剪辑日志失败: {error}"))?;
    let mut command = Command::new(ffmpeg);
    command.args(["-nostdin", "-hide_banner", "-loglevel", "error", "-y"]);
    if params.precise {
        // Re-encode for exact cut points; -progress prints machine-readable
        // `key=value` lines on stdout for the percent meter.
        command.args(["-progress", "pipe:1", "-nostats"]);
    }
    command
        .args(["-ss", &in_seconds, "-i"])
        .arg(ffmpeg_path_string(source))
        .args(["-t", &duration_seconds, "-map", "0"]);
    if params.precise {
        command.args([
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-c:a", "aac", "-b:a", "192k",
        ]);
    } else {
        command.args(["-c", "copy", "-avoid_negative_ts", "make_zero"]);
    }
    let extension = temp
        .extension()
        .map(|value| value.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    if matches!(extension.as_str(), "mp4" | "mov" | "m4v") {
        command.args(["-movflags", "+faststart"]);
    }
    command.arg(ffmpeg_path_string(temp));
    if params.precise {
        command.stdout(Stdio::piped());
    } else {
        command.stdout(Stdio::null());
    }
    command.stderr(Stdio::from(
        log_file
            .try_clone()
            .map_err(|error| format!("打开剪辑日志失败: {error}"))?,
    ));
    hide_console_window(&mut command);
    let mut child = command
        .spawn()
        .map_err(|error| format!("启动 ffmpeg 剪辑失败: {error}"))?;

    // A reader thread turns ffmpeg's progress stream into a shared value so
    // the wait loop below only handles cancel/exit/emit.
    let percent = Arc::new(AtomicU64::new(0));
    let reader = spawn_progress_reader(&mut child, percent.clone());

    let total_ms = (params.out_ms - params.in_ms).max(0) as u64;
    let mut last_emitted = Instant::now();
    let outcome = loop {
        if cancel.load(Ordering::Relaxed) {
            let _ = child.kill();
            let _ = child.wait();
            break Err("剪辑已取消".to_owned());
        }
        match child.try_wait() {
            Ok(Some(status)) => {
                if !status.success() {
                    let _ = log_file.flush();
                    let detail = fs::read_to_string(log_path)
                        .unwrap_or_default()
                        .trim()
                        .to_owned();
                    break Err(if detail.is_empty() {
                        format!("ffmpeg 退出码 {status}")
                    } else {
                        format!("ffmpeg 剪辑失败: {detail}")
                    });
                }
                break Ok(());
            }
            Ok(None) => {
                if params.precise && last_emitted.elapsed() >= Duration::from_millis(200) {
                    last_emitted = Instant::now();
                    // ffmpeg's out_time_ms is microseconds despite the name.
                    let done_ms = percent.load(Ordering::Relaxed) / 1000;
                    let value = if total_ms == 0 {
                        0.0
                    } else {
                        (done_ms as f64 / total_ms as f64 * 100.0).clamp(0.0, 100.0)
                    };
                    let (value, segment_index, segment_count) = match unit {
                        Some(u) => (
                            ((u.unit_index as f64 + value / 100.0) / u.total_units as f64 * 100.0)
                                .clamp(0.0, 100.0),
                            Some(u.unit_index),
                            Some(u.segment_count),
                        ),
                        None => (value, None, None),
                    };
                    emit(
                        app,
                        EditProgress {
                            job_id: job_id.to_owned(),
                            kind: "trim",
                            phase: "trimming",
                            state: "running",
                            percent: Some(value),
                            error: None,
                            result: None,
                            segment_index,
                            segment_count,
                            results: None,
                            merged_result: None,
                        },
                    );
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                break Err(format!("等待 ffmpeg 剪辑失败: {error}"));
            }
        }
    };
    if let Some(handle) = reader {
        let _ = handle.join();
    }
    if outcome.is_ok() && params.precise {
        let value = match unit {
            Some(u) => ((u.unit_index + 1) as f64 / u.total_units as f64 * 100.0).clamp(0.0, 100.0),
            None => 100.0,
        };
        let (segment_index, segment_count) = match unit {
            Some(u) => (Some(u.unit_index), Some(u.segment_count)),
            None => (None, None),
        };
        emit(
            app,
            EditProgress {
                job_id: job_id.to_owned(),
                kind: "trim",
                phase: "trimming",
                state: "running",
                percent: Some(value),
                error: None,
                result: None,
                segment_index,
                segment_count,
                results: None,
                merged_result: None,
            },
        );
    }
    outcome
}

/// Launch a multi-segment cut job on a background thread. Emits
/// `edit-progress` and triggers an incremental scan once all copies are
/// committed — also after a failure, so segments committed before the error
/// still join the library instead of lingering as unindexed files.
#[allow(clippy::too_many_arguments)]
pub fn spawn_cut_segments(
    app: AppHandle,
    manager: Arc<EditJobManagerState>,
    scan_manager: Arc<crate::scanner::ScanManagerState>,
    database_path: PathBuf,
    library_id: String,
    job_id: String,
    cancel: Arc<AtomicBool>,
    params: CutSegmentsParams,
) {
    std::thread::spawn(move || {
        let result = run_cut_segments(&app, &database_path, &library_id, &job_id, &cancel, &params);
        match &result {
            Ok((results, merged)) => {
                emit(
                    &app,
                    EditProgress {
                        job_id: job_id.clone(),
                        kind: "trim",
                        phase: "finalizing",
                        state: "completed",
                        percent: Some(100.0),
                        error: None,
                        result: None,
                        segment_index: None,
                        segment_count: None,
                        results: Some(results.clone()),
                        merged_result: merged.clone(),
                    },
                );
            }
            Err(error) => {
                let cancelled = cancel.load(Ordering::Relaxed);
                emit(
                    &app,
                    EditProgress {
                        job_id: job_id.clone(),
                        kind: "trim",
                        phase: "trimming",
                        state: if cancelled { "cancelled" } else { "failed" },
                        percent: None,
                        error: Some(error.clone()),
                        result: None,
                        segment_index: None,
                        segment_count: None,
                        results: None,
                        merged_result: None,
                    },
                );
            }
        }
        start_edit_scan(&app, &scan_manager, &database_path, &library_id);
        manager.finish();
    });
}

fn run_cut_segments(
    app: &AppHandle,
    database_path: &Path,
    library_id: &str,
    job_id: &str,
    cancel: &AtomicBool,
    params: &CutSegmentsParams,
) -> Result<(Vec<EditResultDto>, Option<EditResultDto>), String> {
    let repository = Repository::open(database_path).map_err(|error| error.to_string())?;
    let root = library_root(&repository, library_id)?;
    let details = repository
        .get_media_item_details(&params.media_item_id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "媒体不存在".to_owned())?;
    let file = video_source_file(&details).ok_or_else(|| "没有可剪辑的视频文件".to_owned())?;
    if params.segments.is_empty() {
        return Err("至少需要一个剪辑片段".to_owned());
    }
    for segment in &params.segments {
        if segment.in_ms < 0 || segment.out_ms <= segment.in_ms {
            return Err("剪辑区间无效".to_owned());
        }
    }
    let merge_indices: Vec<usize> = params
        .segments
        .iter()
        .enumerate()
        .filter(|(_, segment)| segment.merge)
        .map(|(index, _)| index)
        .collect();
    // A merged copy only makes sense from two or more flagged segments.
    let want_merged = merge_indices.len() >= 2;
    let source =
        resolve_media_path(&root, &file.relative_path).map_err(|error| error.to_string())?;
    let ffmpeg = resolve_ffmpeg(app).map_err(|error| error.to_string())?;

    emit(
        app,
        EditProgress {
            job_id: job_id.to_owned(),
            kind: "trim",
            phase: "preparing",
            state: "running",
            percent: None,
            error: None,
            result: None,
            segment_index: None,
            segment_count: None,
            results: None,
            merged_result: None,
        },
    );

    let (destinations, merged_destination) = cut_destinations(
        &source,
        &file.extension,
        params.segments.len(),
        want_merged,
    )
    .map_err(|error| error.to_string())?;
    let extension = format!(".{}", file.extension);
    // The optional merged copy counts as one extra progress unit.
    let total_units = params.segments.len() + usize::from(want_merged);
    let mut results: Vec<EditResultDto> = Vec::new();

    for (index, segment) in params.segments.iter().enumerate() {
        if cancel.load(Ordering::Relaxed) {
            return Err("剪辑已取消".to_owned());
        }
        let destination = destinations[index].clone();
        let file_name = destination
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned();
        let temp = destination.with_file_name(format!(".{file_name}.camlib-edit{extension}"));
        let log_path = destination.with_file_name(format!(".{file_name}.camlib-edit.log"));
        let _ = fs::remove_file(&temp);
        let _ = fs::remove_file(&log_path);
        let mut temp_guard = TempGuard::new(temp.clone());
        let mut log_guard = TempGuard::new(log_path.clone());

        emit(
            app,
            EditProgress {
                job_id: job_id.to_owned(),
                kind: "trim",
                phase: "trimming",
                state: "running",
                percent: if params.precise { Some(0.0) } else { None },
                error: None,
                result: None,
                segment_index: Some(index),
                segment_count: Some(params.segments.len()),
                results: None,
                merged_result: None,
            },
        );

        let trim_params = TrimParams {
            media_item_id: params.media_item_id.clone(),
            in_ms: segment.in_ms,
            out_ms: segment.out_ms,
            precise: params.precise,
        };
        let unit = CutUnitProgress {
            unit_index: index,
            total_units,
            segment_count: params.segments.len(),
        };
        let trim_result = run_ffmpeg_trim(
            &ffmpeg, &source, &temp, &log_path, &trim_params, cancel, job_id, app, Some(unit),
        );
        if let Err(error) = trim_result {
            // Guards drop here and remove the scratch files.
            let _ = (&temp_guard, &log_guard);
            if cancel.load(Ordering::Relaxed) {
                return Err("剪辑已取消".to_owned());
            }
            return Err(format!("片段 {} 剪辑失败: {error}", index + 1));
        }
        if let Err(error) = fs::rename(&temp, &destination) {
            let _ = (&temp_guard, &log_guard);
            return Err(format!("提交剪辑输出失败: {error}"));
        }
        temp_guard.disarm();
        log_guard.disarm();

        let metadata =
            fs::metadata(&destination).map_err(|error| format!("读取输出信息失败: {error}"))?;
        let relative_path = destination
            .strip_prefix(&root)
            .map(|value| value.to_string_lossy().replace('\\', "/"))
            .map_err(|_| "输出文件越出媒体库根目录".to_owned())?;
        results.push(EditResultDto {
            file_name,
            relative_path,
            size_bytes: metadata.len(),
            width: 0,
            height: 0,
        });
    }

    let merged_result = if want_merged {
        cut_merged_copy(
            app,
            job_id,
            cancel,
            &ffmpeg,
            &root,
            &destinations,
            &merge_indices,
            merged_destination.expect("want_merged guarantees a destination"),
            total_units,
        )?
    } else {
        None
    };
    Ok((results, merged_result))
}

/// Join the flagged segment copies (in segment order) into one extra
/// `{stem}_edited_merged` copy via the concat demuxer. Every segment is cut
/// from the same source with the same method, so stream copy applies.
#[allow(clippy::too_many_arguments)]
fn cut_merged_copy(
    app: &AppHandle,
    job_id: &str,
    cancel: &AtomicBool,
    ffmpeg: &Path,
    root: &Path,
    destinations: &[PathBuf],
    merge_indices: &[usize],
    destination: PathBuf,
    total_units: usize,
) -> Result<Option<EditResultDto>, String> {
    if cancel.load(Ordering::Relaxed) {
        return Err("剪辑已取消".to_owned());
    }
    let paths: Vec<PathBuf> = merge_indices
        .iter()
        .map(|index| destinations[*index].clone())
        .collect();
    let expected_size: u64 = paths
        .iter()
        .filter_map(|path| fs::metadata(path).ok())
        .map(|metadata| metadata.len())
        .sum();
    let file_name = destination
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .into_owned();
    let emit_merge = |percent: Option<f64>| {
        emit(
            app,
            EditProgress {
                job_id: job_id.to_owned(),
                kind: "trim",
                phase: "finalizing",
                state: "running",
                percent,
                error: None,
                result: None,
                segment_index: None,
                segment_count: None,
                results: None,
                merged_result: None,
            },
        );
    };
    emit_merge(None);
    let segments_done = destinations.len();
    let mut last_emit = Instant::now();
    let result = merge_and_verify(
        ffmpeg,
        &paths,
        &destination,
        expected_size,
        cancel,
        &mut |bytes| {
            if last_emit.elapsed() >= Duration::from_millis(200) {
                last_emit = Instant::now();
                let percent = if expected_size == 0 {
                    None
                } else {
                    Some(
                        ((segments_done as f64 + bytes as f64 / expected_size as f64)
                            / total_units as f64
                            * 100.0)
                            .clamp(0.0, 100.0),
                    )
                };
                emit_merge(percent);
            }
        },
    );
    match result {
        Ok(_) => {}
        Err(CopyError::Cancelled) => return Err("剪辑已取消".to_owned()),
        Err(CopyError::Message(message)) => return Err(format!("片段合并失败: {message}")),
    }
    let metadata =
        fs::metadata(&destination).map_err(|error| format!("读取输出信息失败: {error}"))?;
    let relative_path = destination
        .strip_prefix(root)
        .map(|value| value.to_string_lossy().replace('\\', "/"))
        .map_err(|_| "输出文件越出媒体库根目录".to_owned())?;
    Ok(Some(EditResultDto {
        file_name,
        relative_path,
        size_bytes: metadata.len(),
        width: 0,
        height: 0,
    }))
}

/// Drain ffmpeg's `-progress` stream, keeping the latest `out_time_ms` in a
/// shared atomic. Returns `None` when the child has no piped stdout.
pub(crate) fn spawn_progress_reader(
    child: &mut Child,
    percent: Arc<AtomicU64>,
) -> Option<std::thread::JoinHandle<()>> {
    let stdout = child.stdout.take()?;
    Some(std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            let Ok(line) = line else { break };
            if let Some(micros) = parse_out_time_micros(&line) {
                percent.store(micros, Ordering::Relaxed);
            }
        }
    }))
}

pub(crate) fn parse_out_time_micros(line: &str) -> Option<u64> {
    line.strip_prefix("out_time_ms=")?
        .trim()
        .parse::<u64>()
        .ok()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn crop_pixels_maps_relative_rect_and_clamps() {
        let (x, y, w, h) = crop_pixels(
            CropRect {
                x: 0.25,
                y: 0.5,
                w: 0.5,
                h: 0.5,
            },
            100,
            80,
        )
        .unwrap();
        assert_eq!((x, y, w, h), (25, 40, 50, 40));
        // Out-of-range rect is clamped into the image.
        let (x, y, w, h) = crop_pixels(
            CropRect {
                x: -0.5,
                y: 0.0,
                w: 2.0,
                h: 2.0,
            },
            100,
            80,
        )
        .unwrap();
        assert_eq!((x, y, w, h), (0, 0, 100, 80));
        assert!(crop_pixels(
            CropRect {
                x: 0.0,
                y: 0.0,
                w: 0.0,
                h: 0.5
            },
            100,
            80
        )
        .is_err());
    }

    #[test]
    fn edited_destination_numbers_collisions_and_chains_suffix() {
        let root = TempDir::new().unwrap();
        let source = root.path().join("IMG_0001.jpg");
        fs::write(&source, b"x").unwrap();
        let first = edited_destination(&source, "jpg").unwrap();
        assert_eq!(first.file_name().unwrap(), "IMG_0001_edited.jpg");
        fs::write(&first, b"x").unwrap();
        let second = edited_destination(&source, "jpg").unwrap();
        assert_eq!(second.file_name().unwrap(), "IMG_0001_edited_2.jpg");
        fs::write(&second, b"x").unwrap();
        // Editing a copy keeps the base name tidy.
        let chained = edited_destination(&first, "jpg").unwrap();
        assert_eq!(chained.file_name().unwrap(), "IMG_0001_edited_3.jpg");
    }

    #[test]
    fn cut_destinations_numbers_family_and_bumps_on_conflicts() {
        let root = TempDir::new().unwrap();
        let source = root.path().join("IMG_0001.mp4");
        fs::write(&source, b"x").unwrap();

        let (segments, merged) = cut_destinations(&source, "mp4", 3, false).unwrap();
        let names: Vec<String> = segments
            .iter()
            .map(|path| path.file_name().unwrap().to_string_lossy().into_owned())
            .collect();
        assert_eq!(
            names,
            [
                "IMG_0001_edited_1.mp4",
                "IMG_0001_edited_2.mp4",
                "IMG_0001_edited_3.mp4"
            ]
        );
        assert!(merged.is_none());

        // One taken name bumps the whole family so segment numbers stay
        // consistent and the merged copy gets the same version suffix.
        fs::write(root.path().join("IMG_0001_edited_2.mp4"), b"x").unwrap();
        let (segments, merged) = cut_destinations(&source, "mp4", 2, true).unwrap();
        let names: Vec<String> = segments
            .iter()
            .map(|path| path.file_name().unwrap().to_string_lossy().into_owned())
            .collect();
        assert_eq!(
            names,
            ["IMG_0001_edited_1_2.mp4", "IMG_0001_edited_2_2.mp4"]
        );
        assert_eq!(
            merged.unwrap().file_name().unwrap().to_string_lossy(),
            "IMG_0001_edited_merged_2.mp4"
        );

        // Re-cutting an existing edited copy chains on its base stem.
        let copy = root.path().join("IMG_0001_edited.mp4");
        fs::write(&copy, b"x").unwrap();
        let (segments, _) = cut_destinations(&copy, "mp4", 1, false).unwrap();
        assert_eq!(
            segments[0].file_name().unwrap().to_string_lossy(),
            "IMG_0001_edited_1.mp4"
        );
    }

    #[test]
    fn render_edit_crops_and_rotates() {
        // 4x2 image: left half black, right half white.
        let mut pixels = Vec::new();
        for _y in 0..2 {
            for x in 0..4 {
                let value = if x >= 2 { 255_u8 } else { 0_u8 };
                pixels.extend_from_slice(&[value, value, value, 255]);
            }
        }
        let oriented = DynamicImage::ImageRgba8(RgbaImage::from_raw(4, 2, pixels).unwrap());
        // Crop to the right half, rotate one quarter turn clockwise.
        let rendered = render_edit(
            &oriented,
            &CropParams {
                crop: CropRect {
                    x: 0.5,
                    y: 0.0,
                    w: 0.5,
                    h: 1.0,
                },
                rotate90: 1,
                flip_h: false,
                flip_v: false,
                brightness: 1.0,
                contrast: 1.0,
                saturation: 1.0,
            },
        )
        .unwrap();
        assert_eq!(rendered.dimensions(), (2, 2));
        // After a clockwise quarter turn the top row holds the left column of
        // the source crop, which was white.
        assert_eq!(rendered.get_pixel(0, 0).0, [255, 255, 255, 255]);
        assert_eq!(rendered.get_pixel(1, 1).0, [255, 255, 255, 255]);
    }

    #[test]
    fn css_adjustments_match_filter_semantics() {
        let mut image = RgbaImage::from_raw(1, 1, vec![100, 100, 100, 255]).unwrap();
        apply_css_adjustments(&mut image, 2.0, 1.0, 1.0);
        assert_eq!(image.get_pixel(0, 0).0, [200, 200, 200, 255]);
        let mut image = RgbaImage::from_raw(1, 1, vec![200, 200, 200, 255]).unwrap();
        apply_css_adjustments(&mut image, 1.0, 2.0, 1.0);
        // (200-127.5)*2+127.5 = 272.5 → clamped to 255.
        assert_eq!(image.get_pixel(0, 0).0, [255, 255, 255, 255]);
        let mut image = RgbaImage::from_raw(1, 1, vec![100, 200, 50, 255]).unwrap();
        apply_css_adjustments(&mut image, 1.0, 1.0, 0.0);
        // Saturation 0 → Rec. 709 luma grey.
        let luma = (0.2126_f32 * 100.0 + 0.7152_f32 * 200.0 + 0.0722_f32 * 50.0).round() as u8;
        assert_eq!(image.get_pixel(0, 0).0, [luma, luma, luma, 255]);
        // Neutral values leave the pixel untouched.
        let mut image = RgbaImage::from_raw(1, 1, vec![10, 20, 30, 255]).unwrap();
        apply_css_adjustments(&mut image, 1.0, 1.0, 1.0);
        assert_eq!(image.get_pixel(0, 0).0, [10, 20, 30, 255]);
    }

    #[test]
    fn source_file_selectors_match_roles_and_extensions() {
        let make_file = |role: MediaFileRole, extension: &str| MediaFile {
            id: "f".into(),
            media_item_id: "m".into(),
            library_id: "l".into(),
            role,
            relative_path: format!("x.{extension}"),
            file_name: format!("x.{extension}"),
            extension: extension.into(),
            size_bytes: 1,
            modified_at: String::new(),
            content_hash: None,
            hash_algorithm: None,
            file_identity: None,
            exists_now: true,
            last_scanned_at: String::new(),
        };
        let details = MediaItemDetails {
            item: crate::db::MediaItem {
                id: "m".into(),
                library_id: "l".into(),
                logical_key: "k".into(),
                kind: crate::db::MediaKind::Photo,
                display_name: "x.jpg".into(),
                capture_at: None,
                capture_date: None,
                width: None,
                height: None,
                duration_ms: None,
                total_size_bytes: 1,
                burst_group: None,
                metadata_json: None,
                scan_state: crate::db::ScanState::Present,
                first_seen_at: String::new(),
                last_seen_at: String::new(),
                favorite: false,
                rating: 0,
            },
            files: vec![
                make_file(MediaFileRole::Single, "jpg"),
                make_file(MediaFileRole::Single, "mp4"),
            ],
            favorite: false,
            tags: vec![],
        };
        assert_eq!(image_source_file(&details).unwrap().extension, "jpg");
        assert_eq!(video_source_file(&details).unwrap().extension, "mp4");
    }

    #[test]
    fn parses_ffmpeg_progress_lines() {
        assert_eq!(parse_out_time_micros("out_time_ms=1234567"), Some(1234567));
        assert_eq!(parse_out_time_micros("out_time_ms= 42 "), Some(42));
        assert_eq!(parse_out_time_micros("frame=10"), None);
        // Negative timestamps (pre-roll during stream copy) are ignored.
        assert_eq!(parse_out_time_micros("out_time_ms=-500"), None);
    }

    #[test]
    fn editable_extension_tables_are_disjoint_from_unknown_types() {
        assert!(is_decodable_image("jpg"));
        assert!(is_ffmpeg_image("heic"));
        assert!(!is_decodable_image("heic"));
        assert!(!is_editable_video("jpg"));
        assert!(is_editable_video("MP4"));
    }
}
