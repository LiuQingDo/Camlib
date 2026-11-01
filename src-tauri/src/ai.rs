//! Optional AI enhancement over user-configured OpenAI-compatible endpoints.
//!
//! Two endpoint groups power both features and are configured independently:
//! ① a multimodal chat model that tags each photo thumbnail and writes a
//! one-line Chinese caption, and parses natural-language search queries into
//! structured conditions; ② a text embedding model that vectorises captions
//! (and queries) so cosine retrieval can answer "去年秋天湖边的照片".
//!
//! Privacy: the feature is off by default. Thumbnail JPEGs (~512px, reused
//! from the local cache pipeline) are only sent to the configured third-party
//! API after the user explicitly enables AI and starts a run.

use crate::db::{
    AiEmbeddingRow, AiStats, AiWorkItem, MediaAiRow, MediaAiUpsert, MediaItemDetails, MediaKind,
    MediaQuery, MediaSort, Repository,
};
use crate::errors::AppError;
use crate::media;
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::Emitter;

/// Settings key inside the existing `app_settings` table.
const CONFIG_KEY: &str = "ai_config";
const AI_TAG_PREFIX: &str = "ai-tag-";
/// Thumbnails are recompressed by the cache pipeline; 512px keeps tokens low.
const AI_THUMBNAIL_WIDTH: u32 = 512;
/// Brute-force cosine search keeps a bounded candidate list (no sqlite-vec).
const VECTOR_TOP_K: usize = 200;
const MIN_COSINE_SCORE: f32 = 0.2;
/// LIKE fallback stays bounded to keep the final SQL parameter list small.
const TEXT_FALLBACK_LIMIT: usize = 500;
const MAX_CHAT_ATTEMPTS: u32 = 3;
const MAX_TAGS_PER_PHOTO: usize = 10;
const MAX_TAG_CHARS: usize = 24;
const MAX_CAPTION_CHARS: usize = 120;
const MAX_RUN_ERRORS: usize = 20;

static NEXT_AI_JOB: AtomicU64 = AtomicU64::new(1);

// ── Configuration ───────────────────────────────────────────────────────────

/// Persisted in the `app_settings` table so worker threads (which open their
/// own `Repository`) see the same configuration as the UI.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct AiConfig {
    /// Master switch. Off means no network call is ever made.
    pub enabled: bool,
    pub chat_base_url: String,
    pub chat_model: String,
    pub chat_api_key: String,
    pub embedding_base_url: String,
    pub embedding_model: String,
    pub embedding_api_key: String,
    /// Parallel photo workers, clamped to 1..=4.
    pub concurrency: u32,
}

impl Default for AiConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            chat_base_url: String::new(),
            chat_model: String::new(),
            chat_api_key: String::new(),
            embedding_base_url: String::new(),
            embedding_model: String::new(),
            embedding_api_key: String::new(),
            concurrency: 2,
        }
    }
}

impl AiConfig {
    /// Whether the chat endpoint is complete enough for a call.
    pub fn chat_ready(&self) -> bool {
        !self.chat_model.trim().is_empty() && Self::url_ok(&self.chat_base_url)
    }

    /// Whether embeddings can be called; semantic search degrades to caption
    /// LIKE matching otherwise.
    pub fn embedding_ready(&self) -> bool {
        !self.embedding_model.trim().is_empty() && Self::url_ok(&self.embedding_base_url)
    }

    fn url_ok(url: &str) -> bool {
        let trimmed = url.trim();
        trimmed.starts_with("http://") || trimmed.starts_with("https://")
    }

    /// Trim inputs and enforce invariants. Returns the normalized copy.
    pub fn normalized(mut self) -> Result<Self, AppError> {
        self.chat_base_url = self.chat_base_url.trim().trim_end_matches('/').to_owned();
        self.chat_model = self.chat_model.trim().to_owned();
        self.chat_api_key = self.chat_api_key.trim().to_owned();
        self.embedding_base_url = self
            .embedding_base_url
            .trim()
            .trim_end_matches('/')
            .to_owned();
        self.embedding_model = self.embedding_model.trim().to_owned();
        self.embedding_api_key = self.embedding_api_key.trim().to_owned();
        self.concurrency = self.concurrency.clamp(1, 4);
        if self.enabled {
            if !Self::url_ok(&self.chat_base_url) {
                return Err(AppError::invalid_argument(
                    "对话模型 Base URL 无效，需以 http(s):// 开头（一般填到 /v1 这一级）",
                ));
            }
            if self.chat_model.is_empty() {
                return Err(AppError::invalid_argument("请填写对话模型名称"));
            }
            if !self.embedding_base_url.is_empty() && !Self::url_ok(&self.embedding_base_url) {
                return Err(AppError::invalid_argument(
                    "Embedding 模型 Base URL 无效，需以 http(s):// 开头",
                ));
            }
            if !self.embedding_base_url.is_empty() && self.embedding_model.is_empty() {
                return Err(AppError::invalid_argument(
                    "已填写 Embedding 服务地址，请同时填写模型名称（或清空地址停用语义向量检索）",
                ));
            }
        }
        Ok(self)
    }
}

pub fn load_config(repository: &Repository) -> Result<AiConfig, AppError> {
    Ok(repository
        .get_app_setting::<AiConfig>(CONFIG_KEY)
        .map_err(AppError::from)?
        .unwrap_or_default())
}

pub fn save_config(repository: &Repository, config: AiConfig) -> Result<AiConfig, AppError> {
    let config = config.normalized()?;
    repository
        .set_app_setting(CONFIG_KEY, &config, &timestamp_now())
        .map_err(AppError::from)?;
    Ok(config)
}

/// Fail fast before spawning a worker thread.
pub fn validate_config_for_run(config: &AiConfig) -> Result<(), AppError> {
    if !config.enabled {
        return Err(AppError::invalid_argument(
            "AI 增强未开启，请先在设置中启用",
        ));
    }
    if !config.chat_ready() {
        return Err(AppError::invalid_argument(
            "对话模型未配置完整（Base URL 与模型名称必填）",
        ));
    }
    Ok(())
}

// ── Transport (OpenAI-compatible HTTP) ──────────────────────────────────────

/// Abstraction over the two HTTP calls so batch logic is unit-testable.
pub trait AiTransport: Send + Sync {
    /// One chat completion. `image_jpeg` attaches the thumbnail as a data URL.
    fn chat(
        &self,
        config: &AiConfig,
        prompt: &str,
        image_jpeg: Option<&[u8]>,
    ) -> Result<String, AppError>;

    /// One text embedding vector.
    fn embed(&self, config: &AiConfig, text: &str) -> Result<Vec<f32>, AppError>;
}

/// Default `ureq` implementation; blocking by design (workers are OS threads).
#[derive(Debug, Default, Clone)]
pub struct UreqTransport;

impl UreqTransport {
    fn agent() -> ureq::Agent {
        ureq::AgentBuilder::new()
            .timeout_connect(Duration::from_secs(15))
            .build()
    }
}

/// Map HTTP/transport failures onto the shared error contract. 429/5xx and
/// network-level issues are retryable (`IoError`), config problems are not.
/// The message always carries the HTTP status and a response snippet so the
/// settings test button can show the provider's own words.
fn map_http_error(context: &str, error: ureq::Error) -> AppError {
    match error {
        ureq::Error::Status(code, response) => {
            let body = response.into_string().unwrap_or_default();
            let snippet: String = body.chars().take(300).collect();
            if (500..=599).contains(&code) || code == 429 {
                AppError::io(format!("{context} 失败（HTTP {code}，可重试）: {snippet}"))
            } else {
                let hint = match code {
                    401 | 403 => "。请检查 API Key 是否正确、是否有该模型权限",
                    404 => "。请检查 Base URL（一般填到 /v1 这一级，不要带 /chat/completions）与模型名称",
                    400 => "。请检查模型名称是否正确、该模型是否支持当前请求",
                    _ => "",
                };
                AppError::invalid_argument(format!(
                    "{context} 失败（HTTP {code}）{hint}: {snippet}"
                ))
            }
        }
        ureq::Error::Transport(transport) => {
            AppError::io(format!("{context} 网络错误（可重试）: {transport}"))
        }
    }
}

/// `Authorization: Bearer …` only when a key is configured; local compatible
/// servers may run without any key.
fn authorization_header(key: &str) -> Option<(&'static str, String)> {
    let trimmed = key.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(("Authorization", format!("Bearer {trimmed}")))
    }
}

impl AiTransport for UreqTransport {
    fn chat(
        &self,
        config: &AiConfig,
        prompt: &str,
        image_jpeg: Option<&[u8]>,
    ) -> Result<String, AppError> {
        let content = match image_jpeg {
            Some(bytes) => json!([
                {
                    "type": "image_url",
                    "image_url": {
                        "url": format!("data:image/jpeg;base64,{}", BASE64.encode(bytes))
                    }
                },
                {"type": "text", "text": prompt}
            ]),
            None => json!(prompt),
        };
        let body = json!({
            "model": config.chat_model,
            "messages": [{"role": "user", "content": content}],
            "temperature": 0.2,
            "max_tokens": 800,
        });
        let agent = Self::agent();
        let mut request = agent
            .post(format!("{}/chat/completions", config.chat_base_url).as_str())
            .timeout(Duration::from_secs(180));
        if let Some((name, value)) = authorization_header(&config.chat_api_key) {
            request = request.set(name, &value);
        }
        let response = request
            .send_json(body)
            .map_err(|error| map_http_error("对话模型请求", error))?;
        let value: serde_json::Value = response
            .into_json()
            .map_err(|error| AppError::io(format!("对话模型响应解析失败: {error}")))?;
        value
            .pointer("/choices/0/message/content")
            .and_then(|content| content.as_str())
            .map(str::to_owned)
            .ok_or_else(|| AppError::internal("对话模型响应缺少 choices[0].message.content"))
    }

    fn embed(&self, config: &AiConfig, text: &str) -> Result<Vec<f32>, AppError> {
        let body = json!({
            "model": config.embedding_model,
            "input": [text],
        });
        let agent = Self::agent();
        let mut request = agent
            .post(format!("{}/embeddings", config.embedding_base_url).as_str())
            .timeout(Duration::from_secs(60));
        if let Some((name, value)) = authorization_header(&config.embedding_api_key) {
            request = request.set(name, &value);
        }
        let response = request
            .send_json(body)
            .map_err(|error| map_http_error("Embedding 请求", error))?;
        let value: serde_json::Value = response
            .into_json()
            .map_err(|error| AppError::io(format!("Embedding 响应解析失败: {error}")))?;
        let vector = value
            .pointer("/data/0/embedding")
            .and_then(|embedding| serde_json::from_value::<Vec<f32>>(embedding.clone()).ok())
            .ok_or_else(|| AppError::internal("Embedding 响应缺少 data[0].embedding"))?;
        if vector.is_empty() {
            return Err(AppError::internal("Embedding 返回了空向量"));
        }
        Ok(vector)
    }
}

// ── LLM output parsing ──────────────────────────────────────────────────────

/// Pull the first JSON object out of a model reply that may be fenced with
/// ```json or carry surrounding prose.
fn extract_json_object(text: &str) -> Option<serde_json::Value> {
    let trimmed = text.trim();
    let start = trimmed.find('{')?;
    let end = trimmed.rfind('}')?;
    if end <= start {
        return None;
    }
    serde_json::from_str(&trimmed[start..=end]).ok()
}

fn sanitize_tags(raw: &[String]) -> Vec<String> {
    let mut tags: Vec<String> = Vec::with_capacity(raw.len());
    for tag in raw {
        let trimmed: String = tag.trim().chars().take(MAX_TAG_CHARS).collect();
        if trimmed.is_empty() || tags.iter().any(|existing| existing == &trimmed) {
            continue;
        }
        tags.push(trimmed);
        if tags.len() >= MAX_TAGS_PER_PHOTO {
            break;
        }
    }
    tags
}

fn sanitize_caption(raw: &str) -> String {
    raw.trim().chars().take(MAX_CAPTION_CHARS).collect()
}

fn truncate(text: &str, max_chars: usize) -> String {
    text.chars().take(max_chars).collect()
}

#[derive(Debug, Clone, PartialEq)]
struct PhotoDescription {
    tags: Vec<String>,
    caption: String,
}

fn parse_photo_description(content: &str) -> Result<PhotoDescription, AppError> {
    let value = extract_json_object(content).ok_or_else(|| {
        AppError::internal(format!("对话模型未返回 JSON: {}", truncate(content, 120)))
    })?;
    let tags = value
        .get("tags")
        .and_then(|tags| tags.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str().map(str::to_owned))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let caption = value
        .get("caption")
        .and_then(|caption| caption.as_str())
        .unwrap_or_default();
    let tags = sanitize_tags(&tags);
    let caption = sanitize_caption(caption);
    if tags.is_empty() || caption.is_empty() {
        return Err(AppError::internal("对话模型返回的标签或描述为空，无法写入"));
    }
    Ok(PhotoDescription { tags, caption })
}

/// Structured conditions parsed from a natural-language query.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedQuery {
    /// Inclusive `YYYY-MM-DD` lower bound, or None.
    pub date_from: Option<String>,
    /// Inclusive `YYYY-MM-DD` upper bound, or None.
    pub date_to: Option<String>,
    pub kind: Option<String>,
    /// Remaining semantic text used for embedding / LIKE retrieval.
    pub keywords: Option<String>,
}

fn is_valid_date(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 10
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes[..4].iter().all(u8::is_ascii_digit)
        && bytes[5..7].iter().all(u8::is_ascii_digit)
        && bytes[8..].iter().all(u8::is_ascii_digit)
}

impl ParsedQuery {
    fn parse(content: &str) -> Result<ParsedQuery, AppError> {
        let value = extract_json_object(content).ok_or_else(|| {
            AppError::internal(format!("查询解析未返回 JSON: {}", truncate(content, 120)))
        })?;
        let text_field = |name: &str| {
            value
                .get(name)
                .and_then(|item| item.as_str())
                .map(str::trim)
                .filter(|text| !text.is_empty())
                .map(str::to_owned)
        };
        let mut parsed = ParsedQuery {
            date_from: text_field("date_from"),
            date_to: text_field("date_to"),
            kind: text_field("kind").map(|kind| kind.to_lowercase()),
            keywords: text_field("keywords"),
        };
        // Invalid dates are dropped rather than failing the whole search.
        parsed.date_from = parsed.date_from.take().filter(|date| is_valid_date(date));
        parsed.date_to = parsed.date_to.take().filter(|date| is_valid_date(date));
        parsed.kind = parsed
            .kind
            .take()
            .filter(|kind| matches!(kind.as_str(), "photo" | "video" | "live"));
        Ok(parsed)
    }
}

// ── Prompts ─────────────────────────────────────────────────────────────────

const TAG_PROMPT: &str = "你是照片库的整理助手。观察这张照片缩略图，只输出一个 JSON 对象：\
{\"tags\": [\"3-8个简短中文标签\"], \"caption\": \"一句不超过40字的中文描述\"}。\
要求：标签覆盖主体、场景、风格、时间氛围（例如：人物、风景、美食、夜景、宠物、雪景、海滩、花卉、建筑、运动、自拍、截图）；\
caption 说明画面主体与场景。不要输出 JSON 以外的任何内容。";

fn query_parse_prompt(query: &str, today: &str) -> String {
    format!(
        "今天是 {today}。把用户的照片库搜索请求解析为 JSON：\
{{\"date_from\": \"YYYY-MM-DD 或 null\", \"date_to\": \"YYYY-MM-DD 或 null\", \
\"kind\": \"photo\" 或 \"video\" 或 null, \"keywords\": \"剩余语义描述\"}}。\
规则：相对时间（去年、上个月、今年、上周、最近三天等）按今天推算为绝对日期区间，跨年区间用 1 月 1 日到 12 月 31 日；\
\"照片/图片\"→photo，\"视频\"→video；无法判断的字段填 null；\
keywords 保留主体、场景、风格等语义信息，去掉已解析为条件的时间与类型词。只输出 JSON。\
用户请求：{query}"
    )
}

// ── Vector helpers ──────────────────────────────────────────────────────────

fn f32_slice_to_le_bytes(vector: &[f32]) -> Vec<u8> {
    vector
        .iter()
        .flat_map(|value| value.to_bits().to_le_bytes())
        .collect()
}

fn le_bytes_to_f32_slice(bytes: &[u8]) -> Vec<f32> {
    bytes
        .chunks_exact(4)
        .map(|chunk| f32::from_bits(u32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]])))
        .collect()
}

fn cosine(a: &[f32], b: &[f32]) -> Option<f32> {
    if a.is_empty() || a.len() != b.len() {
        return None;
    }
    let mut dot = 0.0f32;
    let mut norm_a = 0.0f32;
    let mut norm_b = 0.0f32;
    for (left, right) in a.iter().zip(b.iter()) {
        dot += left * right;
        norm_a += left * left;
        norm_b += right * right;
    }
    if norm_a <= f32::EPSILON || norm_b <= f32::EPSILON {
        return None;
    }
    Some(dot / (norm_a.sqrt() * norm_b.sqrt()))
}

// ── Single-item pipeline ────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq)]
pub enum AiItemOutcome {
    /// Tags + caption (+ embedding) written.
    Tagged { embedding_warning: Option<String> },
    /// Thumbnail unavailable — the item stays pending for a later run.
    Skipped,
}

/// Run the full description pipeline for one media item. Thumbnail problems
/// surface as `Ok(Skipped)` so the item stays pending instead of failed; any
/// other failure becomes an `Err` the caller persists as a failed row.
pub fn process_item(
    repository: &Repository,
    transport: &dyn AiTransport,
    config: &AiConfig,
    details: &MediaItemDetails,
    root: &Path,
    cache_dir: &Path,
) -> Result<AiItemOutcome, AppError> {
    let thumbnail =
        match media::thumbnail_for_item(details, root, cache_dir, AI_THUMBNAIL_WIDTH, None, None) {
            Ok(thumbnail) => thumbnail,
            Err(_) => return Ok(AiItemOutcome::Skipped),
        };
    let bytes = match std::fs::read(&thumbnail.cache_path) {
        Ok(bytes) => bytes,
        Err(_) => return Ok(AiItemOutcome::Skipped),
    };

    let description = chat_with_retry(transport, config, TAG_PROMPT, Some(&bytes))?;
    let tags_json = serde_json::to_string(&description.tags)
        .map_err(|error| AppError::internal(format!("标签序列化失败: {error}")))?;
    let now = timestamp_now();
    repository
        .upsert_media_ai(MediaAiUpsert {
            media_item_id: &details.item.id,
            caption: Some(&description.caption),
            tags_json: Some(&tags_json),
            embedding: None,
            embedding_model: None,
            ai_model: Some(config.chat_model.as_str()),
            embedding_dim: None,
            status: "success",
            error_message: None,
            processed_at: Some(&now),
        })
        .map_err(AppError::from)?;
    repository
        .replace_ai_tags(&details.item.id, &description.tags, AI_TAG_PREFIX, &now)
        .map_err(AppError::from)?;

    let embedding_warning = embed_caption(
        repository,
        transport,
        config,
        &details.item.id,
        &description.caption,
    )?;
    Ok(AiItemOutcome::Tagged { embedding_warning })
}

/// Embed-only refresh for rows that already carry a caption but no current-
/// model vector (first run had embeddings disabled, or the model changed).
pub fn embed_existing(
    repository: &Repository,
    transport: &dyn AiTransport,
    config: &AiConfig,
    media_item_id: &str,
) -> Result<(), AppError> {
    let row = repository
        .get_media_ai(media_item_id)
        .map_err(AppError::from)?
        .ok_or_else(|| AppError::media_missing("AI 记录不存在"))?;
    if row.status != "success" {
        return Err(AppError::invalid_argument("该条目尚未成功打标"));
    }
    let caption = row
        .caption
        .filter(|caption| !caption.trim().is_empty())
        .ok_or_else(|| AppError::invalid_argument("该条目缺少描述文本，无法生成向量"))?;
    embed_caption(repository, transport, config, media_item_id, &caption)?;
    Ok(())
}

/// Persist the caption vector. A failure here does NOT undo a successful tag
/// write; the warning is surfaced and the next run backfills the vector.
fn embed_caption(
    repository: &Repository,
    transport: &dyn AiTransport,
    config: &AiConfig,
    media_item_id: &str,
    caption: &str,
) -> Result<Option<String>, AppError> {
    if !config.embedding_ready() {
        return Ok(Some(
            "未配置 Embedding 模型，本次仅写入标签与描述".to_owned(),
        ));
    }
    match transport.embed(config, caption) {
        Ok(vector) => {
            let dim = vector.len() as i64;
            let bytes = f32_slice_to_le_bytes(&vector);
            repository
                .set_media_ai_embedding(
                    media_item_id,
                    &bytes,
                    config.embedding_model.trim(),
                    dim,
                    &timestamp_now(),
                )
                .map_err(AppError::from)?;
            Ok(None)
        }
        // Keep the tag success; report the embedding problem for the run log.
        Err(error) => Ok(Some(format!("Embedding 生成失败: {error}"))),
    }
}

/// Chat with bounded exponential backoff on retryable failures.
fn chat_with_retry(
    transport: &dyn AiTransport,
    config: &AiConfig,
    prompt: &str,
    image_jpeg: Option<&[u8]>,
) -> Result<PhotoDescription, AppError> {
    let mut delay = Duration::from_secs(1);
    let mut last_error: Option<AppError> = None;
    for attempt in 0..MAX_CHAT_ATTEMPTS {
        match transport.chat(config, prompt, image_jpeg) {
            Ok(content) => return parse_photo_description(&content),
            Err(error) => {
                let retryable = error.retryable;
                last_error = Some(error);
                if !retryable || attempt + 1 >= MAX_CHAT_ATTEMPTS {
                    break;
                }
                std::thread::sleep(delay);
                delay = (delay * 2).min(Duration::from_secs(15));
            }
        }
    }
    Err(last_error.unwrap_or_else(|| AppError::internal("对话模型调用失败，且没有记录到错误")))
}

// ── Batch runs ──────────────────────────────────────────────────────────────

/// What a run should (re)process.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AiRunMode {
    /// Items without an AI row, plus embedding backfill for captioned rows.
    Incremental,
    /// Re-tag and re-embed every eligible photo.
    Full,
    /// Only items whose last attempt failed.
    Retry,
    /// Re-embed existing captions without new chat calls.
    Embeddings,
}

impl AiRunMode {
    pub fn parse(value: &str) -> Result<Self, AppError> {
        match value {
            "incremental" => Ok(Self::Incremental),
            "full" => Ok(Self::Full),
            "retry" => Ok(Self::Retry),
            "embeddings" => Ok(Self::Embeddings),
            other => Err(AppError::invalid_argument(format!(
                "未知的处理模式: {other}"
            ))),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiJobStartDto {
    pub job_id: String,
}

#[derive(Debug, Clone)]
struct ActiveAiJob {
    cancel: Arc<AtomicBool>,
}

/// Same single-job-at-a-time manager pattern as backups.
#[derive(Debug, Clone)]
pub struct AiJobManagerState {
    jobs: Arc<Mutex<HashMap<String, ActiveAiJob>>>,
}

impl AiJobManagerState {
    pub fn new() -> Self {
        Self {
            jobs: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn start(&self) -> Result<(String, Arc<AtomicBool>), AppError> {
        let mut jobs = self
            .jobs
            .lock()
            .map_err(|_| AppError::internal("AI 任务状态锁已损坏"))?;
        if !jobs.is_empty() {
            return Err(AppError::job_already_running("已有 AI 处理任务正在运行"));
        }
        let job_id = format!(
            "ai-{}-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos(),
            NEXT_AI_JOB.fetch_add(1, Ordering::Relaxed)
        );
        let cancel = Arc::new(AtomicBool::new(false));
        jobs.insert(
            job_id.clone(),
            ActiveAiJob {
                cancel: cancel.clone(),
            },
        );
        Ok((job_id, cancel))
    }

    pub fn cancel(&self, job_id: &str) -> Result<(), AppError> {
        let jobs = self
            .jobs
            .lock()
            .map_err(|_| AppError::internal("AI 任务状态锁已损坏"))?;
        jobs.get(job_id)
            .ok_or_else(|| AppError::job_not_found("AI 任务不存在"))?
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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiProgress {
    pub job_id: String,
    pub kind: &'static str,
    pub seq: u64,
    pub phase: &'static str,
    pub state: &'static str,
    pub current: Option<String>,
    pub processed: i64,
    pub total: i64,
    pub succeeded: i64,
    pub failed: i64,
    pub skipped: i64,
    pub errors: Vec<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiProcessPreviewDto {
    pub mode: AiRunMode,
    pub total_photos: i64,
    pub processed: i64,
    pub failed: i64,
    pub pending: i64,
    /// Succeeded rows missing a current-model embedding.
    pub missing_embedding: i64,
    pub chat_calls: i64,
    pub embedding_calls: i64,
    pub estimated_calls: i64,
}

/// Aggregate counts per mode before the user confirms a run.
pub fn preview(
    repository: &Repository,
    config: &AiConfig,
    library_id: &str,
    mode: AiRunMode,
) -> Result<AiProcessPreviewDto, AppError> {
    let AiStats {
        total_photos,
        processed,
        failed,
        pending,
    } = repository.ai_stats(library_id).map_err(AppError::from)?;
    let missing_embedding = if config.embedding_ready() {
        repository
            .list_ai_missing_embeddings(library_id, config.embedding_model.trim())
            .map_err(AppError::from)?
            .len() as i64
    } else {
        0
    };
    let (chat_calls, embedding_calls) = match mode {
        AiRunMode::Incremental => (pending, pending + missing_embedding),
        AiRunMode::Full => (total_photos, total_photos),
        AiRunMode::Retry => (failed, failed),
        // Re-embeddings reuse stored captions; no chat calls.
        AiRunMode::Embeddings => (0, missing_embedding),
    };
    Ok(AiProcessPreviewDto {
        mode,
        total_photos,
        processed,
        failed,
        pending,
        missing_embedding,
        chat_calls,
        embedding_calls,
        estimated_calls: chat_calls + embedding_calls,
    })
}

/// Aggregated run counters shared across worker threads; also owns the event
/// sequence and the capped error list surfaced in progress events.
#[derive(Debug, Default)]
struct SharedProgress {
    seq: AtomicU64,
    processed: AtomicU64,
    succeeded: AtomicU64,
    failed: AtomicU64,
    skipped: AtomicU64,
    errors: Mutex<Vec<String>>,
}

impl SharedProgress {
    fn emit(
        &self,
        app: &tauri::AppHandle,
        job_id: &str,
        total: i64,
        state: &'static str,
        phase: &'static str,
        current: Option<String>,
        error: Option<String>,
    ) {
        let errors = self
            .errors
            .lock()
            .map(|errors| errors.clone())
            .unwrap_or_default();
        let _ = app.emit(
            "ai-progress",
            AiProgress {
                job_id: job_id.to_owned(),
                kind: "ai",
                seq: self.seq.fetch_add(1, Ordering::Relaxed),
                phase,
                state,
                current,
                processed: self.processed.load(Ordering::Relaxed) as i64,
                total,
                succeeded: self.succeeded.load(Ordering::Relaxed) as i64,
                failed: self.failed.load(Ordering::Relaxed) as i64,
                skipped: self.skipped.load(Ordering::Relaxed) as i64,
                errors,
                error,
            },
        );
    }

    fn record(&self, item: &WorkItem, outcome: Result<AiItemOutcome, AppError>) {
        self.processed.fetch_add(1, Ordering::Relaxed);
        match outcome {
            Ok(AiItemOutcome::Tagged { embedding_warning }) => {
                self.succeeded.fetch_add(1, Ordering::Relaxed);
                if let Some(warning) = embedding_warning {
                    self.push_error(format!("{}: {warning}", item.display_name));
                }
            }
            Ok(AiItemOutcome::Skipped) => {
                self.skipped.fetch_add(1, Ordering::Relaxed);
            }
            Err(error) => {
                self.failed.fetch_add(1, Ordering::Relaxed);
                self.push_error(format!("{}: {error}", item.display_name));
            }
        }
    }

    fn push_error(&self, message: String) {
        if let Ok(mut errors) = self.errors.lock() {
            if errors.len() < MAX_RUN_ERRORS {
                errors.push(message);
            }
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum WorkKind {
    /// Tag + caption + embedding.
    Full,
    /// Embedding backfill only.
    EmbedOnly,
}

#[derive(Debug, Clone)]
struct WorkItem {
    media_item_id: String,
    display_name: String,
    kind: WorkKind,
}

/// Spawn the background run thread. `spawn_scan` style: lib.rs only starts it.
#[allow(clippy::too_many_arguments)]
pub fn spawn_run(
    app: tauri::AppHandle,
    manager: Arc<AiJobManagerState>,
    database_path: PathBuf,
    library_root: PathBuf,
    thumbnail_cache_dir: PathBuf,
    library_id: String,
    job_id: String,
    cancel: Arc<AtomicBool>,
    mode: AiRunMode,
) {
    std::thread::spawn(move || {
        run_batch(
            &app,
            &database_path,
            &library_root,
            &thumbnail_cache_dir,
            &library_id,
            &job_id,
            &cancel,
            mode,
        );
        manager.finish(&job_id);
    });
}

#[allow(clippy::too_many_arguments)]
fn run_batch(
    app: &tauri::AppHandle,
    database_path: &Path,
    library_root: &Path,
    thumbnail_cache_dir: &Path,
    library_id: &str,
    job_id: &str,
    cancel: &AtomicBool,
    mode: AiRunMode,
) {
    let progress = Arc::new(SharedProgress::default());
    let abort = |error: String| {
        progress.emit(app, job_id, 0, "failed", "failed", None, Some(error));
    };

    let repository = match Repository::open(database_path) {
        Ok(repository) => repository,
        Err(error) => return abort(error.to_string()),
    };
    let config = match load_config(&repository).and_then(|config| {
        validate_config_for_run(&config)?;
        Ok(config)
    }) {
        Ok(config) => config,
        Err(error) => return abort(error.message),
    };
    let work = match build_work_list(&repository, &config, library_id, mode) {
        Ok(work) => work,
        Err(error) => return abort(error.message),
    };
    if work.is_empty() {
        return progress.emit(app, job_id, 0, "completed", "finalizing", None, None);
    }
    if cancel.load(Ordering::Relaxed) {
        return progress.emit(app, job_id, 0, "cancelled", "cancelled", None, None);
    }
    let total = work.len() as i64;
    progress.emit(app, job_id, total, "running", "processing", None, None);

    let queue = Arc::new(Mutex::new(VecDeque::from(work)));
    let workers = config.concurrency.clamp(1, 4) as usize;
    std::thread::scope(|scope| {
        for _ in 0..workers {
            let Ok(worker_repository) = Repository::open(database_path) else {
                abort("打开数据库失败（工作线程）".to_owned());
                break;
            };
            let transport: Arc<dyn AiTransport> = Arc::new(UreqTransport);
            let queue = Arc::clone(&queue);
            let progress = Arc::clone(&progress);
            let config = config.clone();
            let root = library_root.to_path_buf();
            let cache_dir = thumbnail_cache_dir.to_path_buf();
            scope.spawn(move || loop {
                if cancel.load(Ordering::Relaxed) {
                    break;
                }
                let next = queue.lock().ok().and_then(|mut items| items.pop_front());
                let Some(item) = next else {
                    break;
                };
                let outcome = execute_work_item(
                    &worker_repository,
                    transport.as_ref(),
                    &config,
                    &item,
                    &root,
                    &cache_dir,
                );
                progress.record(&item, outcome);
                progress.emit(
                    app,
                    job_id,
                    total,
                    "running",
                    "processing",
                    Some(item.display_name),
                    None,
                );
            });
        }
    });

    let state = if cancel.load(Ordering::Relaxed) {
        "cancelled"
    } else {
        "completed"
    };
    progress.emit(app, job_id, total, state, "finalizing", None, None);
}

fn execute_work_item(
    repository: &Repository,
    transport: &dyn AiTransport,
    config: &AiConfig,
    item: &WorkItem,
    root: &Path,
    cache_dir: &Path,
) -> Result<AiItemOutcome, AppError> {
    match item.kind {
        WorkKind::Full => {
            let details = repository
                .get_media_item_details(&item.media_item_id)
                .map_err(AppError::from)?
                .ok_or_else(|| AppError::media_missing("媒体不存在"))?;
            process_item(repository, transport, config, &details, root, cache_dir)
        }
        WorkKind::EmbedOnly => {
            embed_existing(repository, transport, config, &item.media_item_id)?;
            Ok(AiItemOutcome::Tagged {
                embedding_warning: None,
            })
        }
    }
}

/// Decide which items this run touches, honouring the mode semantics.
fn build_work_list(
    repository: &Repository,
    config: &AiConfig,
    library_id: &str,
    mode: AiRunMode,
) -> Result<Vec<WorkItem>, AppError> {
    let candidates = repository
        .list_ai_candidates(library_id)
        .map_err(AppError::from)?;
    let rows: HashMap<String, Option<MediaAiRow>> = candidates
        .iter()
        .map(|candidate| {
            let row = repository
                .get_media_ai(&candidate.media_item_id)
                .map_err(AppError::from)
                .ok()
                .flatten();
            (candidate.media_item_id.clone(), row)
        })
        .collect();
    let to_item = |candidate: &AiWorkItem, kind: WorkKind| WorkItem {
        media_item_id: candidate.media_item_id.clone(),
        display_name: candidate.display_name.clone(),
        kind,
    };

    let mut work: Vec<WorkItem> = Vec::new();
    match mode {
        AiRunMode::Full => {
            work.extend(candidates.iter().map(|item| to_item(item, WorkKind::Full)));
        }
        AiRunMode::Retry => {
            for candidate in &candidates {
                if rows
                    .get(&candidate.media_item_id)
                    .and_then(|row| row.as_ref())
                    .is_some_and(|row| row.status == "failed")
                {
                    work.push(to_item(candidate, WorkKind::Full));
                }
            }
        }
        AiRunMode::Incremental => {
            for candidate in &candidates {
                match rows
                    .get(&candidate.media_item_id)
                    .and_then(|row| row.as_ref())
                {
                    None => work.push(to_item(candidate, WorkKind::Full)),
                    Some(row) if row.status == "success" && needs_embedding(row, config) => {
                        work.push(to_item(candidate, WorkKind::EmbedOnly));
                    }
                    _ => {}
                }
            }
        }
        AiRunMode::Embeddings => {
            if !config.embedding_ready() {
                return Err(AppError::invalid_argument(
                    "未配置 Embedding 模型，无法执行向量补算",
                ));
            }
            for candidate in &candidates {
                if let Some(row) = rows
                    .get(&candidate.media_item_id)
                    .and_then(|row| row.as_ref())
                {
                    if row.status == "success" && needs_embedding(row, config) {
                        work.push(to_item(candidate, WorkKind::EmbedOnly));
                    }
                }
            }
        }
    }
    Ok(work)
}

fn needs_embedding(row: &MediaAiRow, config: &AiConfig) -> bool {
    match (&row.embedding, &row.embedding_model) {
        (Some(_), Some(model)) => model != config.embedding_model.trim(),
        _ => true,
    }
}

// ── Semantic search ─────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiSearchResult {
    pub items: Vec<crate::db::MediaItem>,
    pub total: i64,
    pub offset: i64,
    pub limit: i64,
    /// "vector" (embedding retrieval), "text" (caption/tags LIKE fallback) or
    /// "structured" (pure SQL conditions when the query carried no semantics).
    pub mode: &'static str,
    pub parsed: ParsedQuery,
}

/// Two-stage retrieval: the chat model turns the query into structured
/// conditions + remaining semantic text. Structured conditions filter via SQL
/// while the semantic text is matched by vectors (intersection), or by
/// caption/tags LIKE when no embedding model is configured. A query with
/// structured conditions but no semantic residue skips vector scoring so pure
/// time/type questions keep exact SQL semantics.
pub fn search(
    repository: &Repository,
    transport: &dyn AiTransport,
    config: &AiConfig,
    library_id: &str,
    query: &str,
    offset: i64,
    limit: i64,
) -> Result<AiSearchResult, AppError> {
    let query = query.trim();
    if query.is_empty() {
        return Err(AppError::invalid_argument("搜索内容为空"));
    }
    validate_config_for_run(config)?;
    let today = local_today();
    let content = transport.chat(config, &query_parse_prompt(query, &today), None)?;
    let parsed = ParsedQuery::parse(&content)?;
    let kind = parsed.kind.as_deref().and_then(kind_from_str);
    let semantic_text = parsed.keywords.clone().unwrap_or_default();

    // Query projection reused by all three paths below.
    let base_query = |item_ids: Vec<String>, query_offset: i64, query_limit: i64| MediaQuery {
        library_id: library_id.to_owned(),
        kind,
        favorite_only: false,
        burst_only: false,
        search: None,
        date_prefix: None,
        date_from: parsed.date_from.clone(),
        date_to: parsed.date_to.clone(),
        first_seen_from: None,
        tag_ids: Vec::new(),
        item_ids,
        rating_eq: None,
        rating_min: None,
        offset: query_offset,
        limit: query_limit,
        sort: MediaSort::Newest,
    };

    if !semantic_text.is_empty() && config.embedding_ready() {
        let query_vector = transport.embed(config, &semantic_text)?;
        let rows: Vec<AiEmbeddingRow> = repository
            .list_ai_embeddings(library_id, config.embedding_model.trim())
            .map_err(AppError::from)?;
        let mut scored: Vec<(String, f32)> = rows
            .iter()
            .filter_map(|row| {
                let vector = le_bytes_to_f32_slice(&row.embedding);
                cosine(&query_vector, &vector)
                    .filter(|score| *score >= MIN_COSINE_SCORE)
                    .map(|score| (row.media_item_id.clone(), score))
            })
            .collect();
        scored.sort_by(|left, right| {
            right
                .1
                .partial_cmp(&left.1)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        scored.truncate(VECTOR_TOP_K);
        let ids = scored.into_iter().map(|(id, _)| id).collect::<Vec<_>>();
        let items = fetch_ordered(
            repository,
            base_query(Vec::new(), 0, TEXT_FALLBACK_LIMIT as i64),
            &ids,
        )?;
        Ok(AiSearchResult {
            total: items.len() as i64,
            items,
            offset,
            limit,
            mode: "vector",
            parsed,
        })
    } else if !semantic_text.is_empty() {
        // Degraded path: LIKE over captions/tags for the semantic text.
        let mut ids = repository
            .search_media_ai_text(library_id, &semantic_text)
            .map_err(AppError::from)?;
        ids.truncate(TEXT_FALLBACK_LIMIT);
        let page = repository
            .query_media(base_query(ids, offset, limit))
            .map_err(AppError::from)?;
        Ok(AiSearchResult {
            items: page.items,
            total: page.total,
            offset: page.offset,
            limit: page.limit,
            mode: "text",
            parsed,
        })
    } else {
        // Structured-only query (pure time/type): exact SQL semantics.
        let page = repository
            .query_media(base_query(Vec::new(), offset, limit))
            .map_err(AppError::from)?;
        Ok(AiSearchResult {
            items: page.items,
            total: page.total,
            offset: page.offset,
            limit: page.limit,
            mode: "structured",
            parsed,
        })
    }
}

/// Fetch items by id, keep the ranked order, and apply structured conditions.
fn fetch_ordered(
    repository: &Repository,
    mut candidate_query: MediaQuery,
    ranked_ids: &[String],
) -> Result<Vec<crate::db::MediaItem>, AppError> {
    if ranked_ids.is_empty() {
        return Ok(Vec::new());
    }
    candidate_query.item_ids = ranked_ids.to_vec();
    let page = repository
        .query_media(candidate_query)
        .map_err(AppError::from)?;
    let order: HashMap<&str, usize> = ranked_ids
        .iter()
        .enumerate()
        .map(|(index, id)| (id.as_str(), index))
        .collect();
    let mut items = page.items;
    items.sort_by_key(|item| order.get(item.id.as_str()).copied().unwrap_or(usize::MAX));
    Ok(items)
}

fn kind_from_str(value: &str) -> Option<MediaKind> {
    match value {
        "photo" => Some(MediaKind::Photo),
        "video" => Some(MediaKind::Video),
        "live" => Some(MediaKind::Live),
        _ => None,
    }
}

fn local_today() -> String {
    // Civil date from the Unix epoch (Howard Hinnant's algorithm); avoids a
    // new dependency while giving the model the "today" anchor it needs.
    let days = (SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
        / 86_400) as i64;
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if month <= 2 { year + 1 } else { year };
    format!("{year:04}-{month:02}-{day:02}")
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

// ── Tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{LibraryState, MediaFileRole, NewLibrary, NewMediaFile, NewTag, ScanState};

    struct MockTransport {
        replies: Mutex<VecDeque<String>>,
        vector: Vec<f32>,
    }

    impl MockTransport {
        fn new(reply: &str, vector: Vec<f32>) -> Self {
            Self {
                replies: Mutex::new(VecDeque::from(vec![reply.to_owned()])),
                vector,
            }
        }
    }

    impl AiTransport for MockTransport {
        fn chat(
            &self,
            _config: &AiConfig,
            _prompt: &str,
            _image_jpeg: Option<&[u8]>,
        ) -> Result<String, AppError> {
            self.replies
                .lock()
                .unwrap()
                .pop_front()
                .ok_or_else(|| AppError::internal("mock exhausted"))
        }

        fn embed(&self, _config: &AiConfig, _text: &str) -> Result<Vec<f32>, AppError> {
            Ok(self.vector.clone())
        }
    }

    fn ready_config() -> AiConfig {
        AiConfig {
            enabled: true,
            chat_base_url: "https://api.example.com/v1".into(),
            chat_model: "vision-model".into(),
            chat_api_key: "key".into(),
            embedding_base_url: "https://api.example.com/v1".into(),
            embedding_model: "embed-model".into(),
            embedding_api_key: "key".into(),
            concurrency: 2,
        }
    }

    fn library() -> NewLibrary {
        NewLibrary {
            id: "library-1".into(),
            root_path: "C:\\media".into(),
            volume_id: Some("vol-1".into()),
            volume_label: Some("MEDIA".into()),
            drive_letter: Some("C:".into()),
            state: LibraryState::Available,
            last_seen_at: None,
            last_scan_at: None,
            scan_generation: 0,
            created_at: "2026-01-01T00:00:00Z".into(),
            updated_at: "2026-01-01T00:00:00Z".into(),
        }
    }

    fn item(id: &str, kind: MediaKind) -> crate::db::MediaItem {
        crate::db::MediaItem {
            id: id.to_owned(),
            library_id: "library-1".to_owned(),
            logical_key: format!("{id}/file"),
            kind,
            display_name: format!("{id}.jpg"),
            capture_at: Some("2025-10-20T10:00:00Z".to_owned()),
            capture_date: Some("2025-10-20".to_owned()),
            width: Some(100),
            height: Some(100),
            duration_ms: None,
            total_size_bytes: 1024,
            burst_group: None,
            metadata_json: None,
            scan_state: ScanState::Present,
            first_seen_at: "unix-ms:1".to_owned(),
            last_seen_at: "unix-ms:1".to_owned(),
            favorite: false,
            rating: 0,
        }
    }

    fn setup() -> Repository {
        let repository = Repository::open_in_memory().unwrap();
        repository.create_library(library()).unwrap();
        repository
            .upsert_media_item(item("photo-lake", MediaKind::Photo))
            .unwrap();
        repository
            .upsert_media_item(item("photo-food", MediaKind::Photo))
            .unwrap();
        repository
            .upsert_media_item(item("video-1", MediaKind::Video))
            .unwrap();
        repository
    }

    fn store_success_row(repository: &Repository, media_item_id: &str, caption: &str) {
        repository
            .upsert_media_ai(MediaAiUpsert {
                media_item_id,
                caption: Some(caption),
                tags_json: Some("[\"风景\"]"),
                embedding: None,
                embedding_model: None,
                ai_model: Some("vision-model"),
                embedding_dim: None,
                status: "success",
                error_message: None,
                processed_at: Some("unix-ms:2"),
            })
            .unwrap();
    }

    #[test]
    fn extract_json_object_handles_fences_and_prose() {
        let fenced = "```json\n{\"tags\":[\"雪景\"],\"caption\":\"雪山\"}\n```";
        let value = extract_json_object(fenced).unwrap();
        assert_eq!(value["caption"], "雪山");
        let prose = "好的，结果如下：{\"tags\":[\"美食\"],\"caption\":\"火锅\"} 以上。";
        let value = extract_json_object(prose).unwrap();
        assert_eq!(value["tags"][0], "美食");
        assert!(extract_json_object("没有对象").is_none());
    }

    #[test]
    fn sanitize_tags_dedupes_and_caps() {
        let tags = sanitize_tags(&[
            " 雪景 ".into(),
            "雪景".into(),
            "".into(),
            "a".repeat(40),
            "美食".into(),
        ]);
        assert_eq!(
            tags,
            vec!["雪景".to_owned(), "a".repeat(24), "美食".to_owned()]
        );
    }

    #[test]
    fn parse_photo_description_rejects_empty_payload() {
        let ok = parse_photo_description("{\"tags\":[\"人物\"],\"caption\":\"合影\"}").unwrap();
        assert_eq!(ok.tags, vec!["人物"]);
        assert_eq!(ok.caption, "合影");
        assert!(parse_photo_description("{\"tags\":[],\"caption\":\"\"}").is_err());
    }

    #[test]
    fn parsed_query_keeps_only_valid_values() {
        let parsed = ParsedQuery::parse(
            "{\"date_from\":\"2025-01-01\",\"date_to\":\"明天\",\"kind\":\"PHOTO\",\"keywords\":\" 湖边 \"}",
        )
        .unwrap();
        assert_eq!(parsed.date_from.as_deref(), Some("2025-01-01"));
        assert_eq!(parsed.date_to, None);
        assert_eq!(parsed.kind.as_deref(), Some("photo"));
        assert_eq!(parsed.keywords.as_deref(), Some("湖边"));
    }

    #[test]
    fn cosine_and_bytes_roundtrip() {
        let vector = vec![1.0f32, -2.5, 3.25];
        let bytes = f32_slice_to_le_bytes(&vector);
        assert_eq!(le_bytes_to_f32_slice(&bytes), vector);
        assert_eq!(cosine(&[1.0, 0.0], &[1.0, 0.0]), Some(1.0));
        assert_eq!(cosine(&[1.0, 0.0], &[0.0, 1.0]), Some(0.0));
        assert!(cosine(&[1.0], &[1.0, 2.0]).is_none());
    }

    #[test]
    fn local_today_is_a_valid_iso_date() {
        assert!(is_valid_date(&local_today()));
    }

    #[test]
    fn authorization_header_only_when_key_present() {
        assert!(authorization_header("").is_none());
        assert!(authorization_header("   ").is_none());
        let (name, value) = authorization_header(" sk-abc ").unwrap();
        assert_eq!(name, "Authorization");
        assert_eq!(value, "Bearer sk-abc");
    }

    #[test]
    fn config_normalization_enforces_chat_requirements() {
        let config = AiConfig {
            enabled: true,
            chat_base_url: "  https://api.example.com/v1/  ".into(),
            ..Default::default()
        };
        // Missing model name is rejected.
        assert!(config.clone().normalized().is_err());
        let config = AiConfig {
            chat_model: "m".into(),
            embedding_base_url: "https://embed.example.com/v1".into(),
            ..config
        };
        // Embedding address without model name is rejected.
        assert!(config.clone().normalized().is_err());
        // Trailing slash trimmed once the model name completes the pair.
        let normalized = AiConfig {
            embedding_model: "e".into(),
            ..config
        }
        .normalized()
        .unwrap();
        assert_eq!(normalized.chat_base_url, "https://api.example.com/v1");
        assert!(!AiConfig::default().enabled);
        assert_eq!(AiConfig::default().concurrency, 2);
    }

    #[test]
    fn media_ai_rows_roundtrip_and_backfill_detection() {
        let repository = setup();
        let config = ready_config();
        store_success_row(&repository, "photo-lake", "湖边秋色");

        let stats = repository.ai_stats("library-1").unwrap();
        assert_eq!(
            (
                stats.total_photos,
                stats.processed,
                stats.pending,
                stats.failed
            ),
            (2, 1, 1, 0)
        );

        // Different model counts as missing; same model does not.
        let missing = repository
            .list_ai_missing_embeddings("library-1", "embed-model")
            .unwrap();
        assert_eq!(missing.len(), 1);
        let bytes = f32_slice_to_le_bytes(&[0.1, 0.2]);
        repository
            .set_media_ai_embedding("photo-lake", &bytes, "embed-model", 2, "unix-ms:3")
            .unwrap();
        let missing = repository
            .list_ai_missing_embeddings("library-1", "embed-model")
            .unwrap();
        assert_eq!(missing.len(), 0);
        assert!(!needs_embedding(
            &repository.get_media_ai("photo-lake").unwrap().unwrap(),
            &config
        ));
    }

    #[test]
    fn ai_tags_are_isolated_from_user_tags() {
        let repository = setup();
        let now = "unix-ms:9";
        // User attaches a same-name tag first; AI must reuse it, not duplicate.
        repository
            .create_tag(NewTag {
                id: "tag-user-scenery".into(),
                name: "风景".into(),
                color: None,
                created_at: now.into(),
            })
            .unwrap();
        repository
            .attach_tag("photo-food", "tag-user-scenery", now)
            .unwrap();

        repository
            .replace_ai_tags(
                "photo-lake",
                &["风景".into(), "秋".into()],
                AI_TAG_PREFIX,
                now,
            )
            .unwrap();

        // AI tags live in media_ai_tags, never in media_tags.
        assert!(repository
            .list_tags_for_media("photo-lake")
            .unwrap()
            .is_empty());

        // Same-name reuse: exactly one 风景 tag row overall.
        let all = repository.list_tags().unwrap();
        assert_eq!(all.iter().filter(|tag| tag.name == "风景").count(), 1);
        let scenery = all.iter().find(|tag| tag.name == "风景").unwrap();
        assert!(scenery.has_ai);

        // Detaching the user tag never touches AI assignments.
        repository
            .detach_tag("photo-food", "tag-user-scenery")
            .unwrap();
        let remaining: Vec<_> = repository
            .list_tags()
            .unwrap()
            .into_iter()
            .filter(|tag| tag.has_ai)
            .collect();
        assert_eq!(remaining.len(), 2);

        // Filter by tag id matches AI-tagged media too.
        let page = repository
            .query_media(MediaQuery {
                library_id: "library-1".into(),
                kind: None,
                favorite_only: false,
                burst_only: false,
                search: None,
                date_prefix: None,
                date_from: None,
                date_to: None,
                first_seen_from: None,
                tag_ids: vec![scenery.id.clone()],
                item_ids: Vec::new(),
                rating_eq: None,
                rating_min: None,
                offset: 0,
                limit: 50,
                sort: MediaSort::Newest,
            })
            .unwrap();
        assert_eq!(page.items.len(), 1);
        assert_eq!(page.items[0].id, "photo-lake");
    }

    #[test]
    fn preview_counts_match_modes() {
        let repository = setup();
        let config = ready_config();
        store_success_row(&repository, "photo-lake", "湖边");
        repository
            .upsert_media_ai(MediaAiUpsert {
                media_item_id: "photo-food",
                caption: None,
                tags_json: None,
                embedding: None,
                embedding_model: None,
                ai_model: None,
                embedding_dim: None,
                status: "failed",
                error_message: Some("boom"),
                processed_at: Some("unix-ms:2"),
            })
            .unwrap();

        let incremental =
            preview(&repository, &config, "library-1", AiRunMode::Incremental).unwrap();
        assert_eq!(incremental.pending, 0);
        assert_eq!(incremental.chat_calls, 0);
        assert_eq!(incremental.embedding_calls, 1);
        let full = preview(&repository, &config, "library-1", AiRunMode::Full).unwrap();
        assert_eq!(full.chat_calls, 2);
        let retry = preview(&repository, &config, "library-1", AiRunMode::Retry).unwrap();
        assert_eq!(retry.chat_calls, 1);
        let embeddings = preview(&repository, &config, "library-1", AiRunMode::Embeddings).unwrap();
        assert_eq!(embeddings.chat_calls, 0);
        assert_eq!(embeddings.embedding_calls, 1);
    }

    #[test]
    fn build_work_list_honours_modes() {
        let repository = setup();
        let config = ready_config();
        store_success_row(&repository, "photo-lake", "湖边");

        let incremental =
            build_work_list(&repository, &config, "library-1", AiRunMode::Incremental).unwrap();
        assert_eq!(
            incremental
                .iter()
                .map(|item| (item.media_item_id.as_str(), item.kind))
                .collect::<Vec<_>>(),
            vec![
                ("photo-food", WorkKind::Full),
                ("photo-lake", WorkKind::EmbedOnly)
            ]
        );
        let full = build_work_list(&repository, &config, "library-1", AiRunMode::Full).unwrap();
        assert_eq!(full.len(), 2);
        let retry = build_work_list(&repository, &config, "library-1", AiRunMode::Retry).unwrap();
        assert!(retry.is_empty());
    }

    #[test]
    fn search_intersects_vectors_with_structured_conditions() {
        let repository = setup();
        let config = ready_config();
        let transport = MockTransport::new(
            "{\"date_from\":null,\"date_to\":null,\"kind\":null,\"keywords\":\"湖边秋天\"}",
            vec![1.0, 0.0],
        );
        store_success_row(&repository, "photo-lake", "湖边秋天的清晨");
        store_success_row(&repository, "photo-food", "晚餐");
        // photo-lake matches the query vector; photo-food is orthogonal and
        // excluded by the score threshold.
        repository
            .set_media_ai_embedding(
                "photo-lake",
                &f32_slice_to_le_bytes(&[1.0, 0.0]),
                "embed-model",
                2,
                "unix-ms:3",
            )
            .unwrap();
        repository
            .set_media_ai_embedding(
                "photo-food",
                &f32_slice_to_le_bytes(&[0.0, 1.0]),
                "embed-model",
                2,
                "unix-ms:3",
            )
            .unwrap();

        let result = search(
            &repository,
            &transport,
            &config,
            "library-1",
            "去年秋天湖边的照片",
            0,
            50,
        )
        .unwrap();
        assert_eq!(result.mode, "vector");
        assert_eq!(result.items.len(), 1);
        assert_eq!(result.items[0].id, "photo-lake");
    }

    #[test]
    fn search_degrades_to_text_like_without_embedding_model() {
        let repository = setup();
        let mut config = ready_config();
        config.embedding_base_url = String::new();
        config.embedding_model = String::new();
        let transport = MockTransport::new(
            "{\"date_from\":\"2025-10-01\",\"date_to\":\"2025-10-31\",\"kind\":\"photo\",\"keywords\":\"湖边\"}",
            Vec::new(),
        );
        store_success_row(&repository, "photo-lake", "湖边秋色");

        let result = search(
            &repository,
            &transport,
            &config,
            "library-1",
            "十月湖边",
            0,
            50,
        )
        .unwrap();
        assert_eq!(result.mode, "text");
        assert_eq!(result.items.len(), 1);
        assert_eq!(result.items[0].id, "photo-lake");
        assert_eq!(result.parsed.date_from.as_deref(), Some("2025-10-01"));
    }

    #[test]
    fn structured_only_queries_skip_vector_scoring() {
        let repository = setup();
        let config = ready_config();
        let transport = MockTransport::new(
            "{\"date_from\":\"2025-10-01\",\"date_to\":\"2025-10-31\",\"kind\":null,\"keywords\":null}",
            Vec::new(),
        );
        // photo-lake carries no AI row at all — the SQL path must still see it.
        let result = search(
            &repository,
            &transport,
            &config,
            "library-1",
            "2025年10月的照片",
            0,
            50,
        )
        .unwrap();
        assert_eq!(result.mode, "structured");
        // Every library item matches the date range; the key regression is
        // that items WITHOUT any AI row still appear in SQL-only results.
        assert_eq!(result.items.len(), 3);
        assert!(result.items.iter().any(|item| item.id == "photo-lake"));
    }

    #[test]
    fn process_item_skips_without_thumbnail_and_succeeds_with_one() {
        let repository = setup();
        let config = ready_config();
        let transport = MockTransport::new(
            "{\"tags\":[\"风景\",\"秋\"],\"caption\":\"湖边秋色\"}",
            vec![0.5, 0.5],
        );
        let details = repository
            .get_media_item_details("photo-lake")
            .unwrap()
            .unwrap();

        // No file on disk: report skipped (stays pending), never failed.
        let outcome = process_item(
            &repository,
            &transport,
            &config,
            &details,
            Path::new("C:\\definitely-missing"),
            Path::new("C:\\definitely-missing"),
        )
        .unwrap();
        assert_eq!(outcome, AiItemOutcome::Skipped);

        // With a real thumbnail the full chain writes caption, tags, vector.
        let dir = tempfile::tempdir().unwrap();
        let image: image::DynamicImage =
            image::RgbImage::from_pixel(16, 16, image::Rgb([128u8, 64, 32])).into();
        let mut jpeg = Vec::new();
        image
            .write_to(
                &mut std::io::Cursor::new(&mut jpeg),
                image::ImageFormat::Jpeg,
            )
            .unwrap();
        std::fs::write(dir.path().join("IMG_0001.jpg"), &jpeg).unwrap();
        repository
            .upsert_media_file(NewMediaFile {
                id: "file-lake".into(),
                media_item_id: "photo-lake".into(),
                library_id: "library-1".into(),
                role: MediaFileRole::Single,
                relative_path: "IMG_0001.jpg".into(),
                size_bytes: jpeg.len() as i64,
                modified_at: "2026-01-01T00:00:00Z".into(),
                content_hash: None,
                hash_algorithm: None,
                file_identity: None,
                exists_now: true,
                last_scanned_at: "2026-01-01T00:00:00Z".into(),
            })
            .unwrap();
        let details = repository
            .get_media_item_details("photo-lake")
            .unwrap()
            .unwrap();
        let outcome = process_item(
            &repository,
            &transport,
            &config,
            &details,
            dir.path(),
            &dir.path().join("cache"),
        )
        .unwrap();
        let AiItemOutcome::Tagged { embedding_warning } = outcome else {
            panic!("expected Tagged");
        };
        assert!(embedding_warning.is_none());

        let row = repository.get_media_ai("photo-lake").unwrap().unwrap();
        assert_eq!(row.status, "success");
        assert_eq!(row.caption.as_deref(), Some("湖边秋色"));
        assert_eq!(row.embedding_model.as_deref(), Some("embed-model"));
        assert_eq!(row.embedding_dim, Some(2));
        // Two AI tags created and flagged in the shared tag list.
        let ai_tagged = repository
            .list_tags()
            .unwrap()
            .into_iter()
            .filter(|tag| tag.has_ai)
            .collect::<Vec<_>>();
        assert_eq!(ai_tagged.len(), 2);
        let details = repository
            .get_media_item_details("photo-lake")
            .unwrap()
            .unwrap();
        assert_eq!(details.ai_caption.as_deref(), Some("湖边秋色"));
        assert_eq!(details.ai_tags, vec!["风景", "秋"]);
    }
}
