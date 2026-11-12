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
/// Assistant history sent to the model is capped so prompt size stays bounded
/// even after a long conversation.
const MAX_CHAT_HISTORY: usize = 16;
/// Top tags (by usage) injected into the assistant system prompt.
const CHAT_TOP_TAGS: usize = 30;
const CHAT_TEMPERATURE: f32 = 0.4;
const CHAT_MAX_TOKENS: u32 = 1200;
/// Model-side marker requesting a semantic search; the frontend strips it and
/// renders a one-click chip. The assistant itself stays read-only.
const CHAT_SEARCH_MARKER: &str = "[搜索]";

/// Timeout budget for every blocking AI call. These three numbers are the only
/// place the network budget is defined; commands never override them per call.
///
/// `ureq` 2.x semantics (see `AgentBuilder::timeout`): the overall `.timeout()`
/// takes precedence over `.timeout_read()` / `.timeout_write()`, because ureq
/// then drives the socket timeout itself — before every read it sets the
/// socket timeout to "time left until the deadline". A fourth, independent
/// idle-read timer is therefore impossible to combine with a deadline, so the
/// values that actually govern a call are:
/// * connect (incl. TLS handshake): 15 s — `.timeout_connect()`, which the
///   deadline does not supersede;
/// * whole request (DNS + connect + redirects + body): 120 s — `.timeout()`;
/// * one read that never completes: bounded by the remaining part of that same
///   120 s, so a provider that accepts the connection and then goes silent
///   fails after at most 120 s instead of hanging forever. `.timeout_read(60)`
///   is still applied as the bound for requests that deliberately run without
///   an overall deadline (the streaming path in `chat_stream`), which is where
///   the 60 s idle limit really bites.
const AI_CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const AI_READ_TIMEOUT: Duration = Duration::from_secs(60);
const AI_TOTAL_TIMEOUT: Duration = Duration::from_secs(120);

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

// ── Chat assistant DTOs ─────────────────────────────────────────────────────

/// One conversation turn as sent by the frontend (user/assistant only; the
/// system prompt is always rebuilt server-side so prompt engineering stays
/// out of the webview).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AiChatTurn {
    pub role: String,
    pub content: String,
}

/// Browsing context the frontend attaches to every chat request; all fields
/// are optional so a bare question still works.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AiChatContext {
    /// Current filter state as a small JSON object built by the frontend.
    pub view: Option<serde_json::Value>,
    /// The photo open in the preview modal, if any. Its thumbnail rides on
    /// the last user message so the model can see the picture.
    pub preview: Option<AiChatPreview>,
    /// Multi-selection summary from the grid toolbar.
    pub selection: Option<AiChatSelection>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AiChatPreview {
    pub media_id: String,
    pub display_name: String,
    pub kind: Option<String>,
    pub capture_date: Option<String>,
    pub rating: Option<i64>,
    pub favorite: Option<bool>,
    pub ai_caption: Option<String>,
    #[serde(default)]
    pub ai_tags: Vec<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AiChatSelection {
    pub count: usize,
    #[serde(default)]
    pub names: Vec<String>,
}

/// Progress event streamed to the drawer over a Tauri `Channel`.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AiChatEvent {
    Delta { text: String },
}

/// Final command result: the full reply, or the partial text after a cancel.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiChatOutcome {
    pub content: String,
    pub cancelled: bool,
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

    /// Multi-turn streaming chat over the OpenAI SSE protocol. `on_delta`
    /// receives every text chunk; return `false` to stop reading early (user
    /// cancel). Returns the accumulated text.
    fn chat_stream(
        &self,
        config: &AiConfig,
        messages: &[AiChatTurn],
        image_jpeg: Option<&[u8]>,
        on_delta: &mut dyn FnMut(&str) -> bool,
    ) -> Result<String, AppError>;

    /// One text embedding vector.
    fn embed(&self, config: &AiConfig, text: &str) -> Result<Vec<f32>, AppError>;
}

/// Default `ureq` implementation; blocking by design (workers are OS threads).
///
/// Callers must run this on a blocking thread (`spawn_blocking` or a dedicated
/// worker), never on the IPC/window thread: every method blocks for the whole
/// HTTP round-trip, and `chat_with_retry` also parks the thread during backoff.
#[derive(Debug, Default, Clone)]
pub struct UreqTransport;

impl UreqTransport {
    /// Agent shared by the single-shot calls, carrying the full timeout budget
    /// described on `AI_CONNECT_TIMEOUT`. Requests must not override it with a
    /// per-request `.timeout()`, or the numbers here stop applying.
    fn agent() -> ureq::Agent {
        ureq::AgentBuilder::new()
            .timeout_connect(AI_CONNECT_TIMEOUT)
            .timeout_read(AI_READ_TIMEOUT)
            .timeout(AI_TOTAL_TIMEOUT)
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
        // No per-request `.timeout()` here: it would replace the agent's
        // overall 120 s cap (ureq lets the request value win).
        let agent = Self::agent();
        let mut request = agent.post(format!("{}/chat/completions", config.chat_base_url).as_str());
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

    fn chat_stream(
        &self,
        config: &AiConfig,
        messages: &[AiChatTurn],
        image_jpeg: Option<&[u8]>,
        on_delta: &mut dyn FnMut(&str) -> bool,
    ) -> Result<String, AppError> {
        let mut payload: Vec<serde_json::Value> = messages
            .iter()
            .map(|turn| json!({"role": turn.role, "content": turn.content}))
            .collect();
        // The preview thumbnail rides on the last user message, same data-URL
        // shape as the single-shot `chat` path.
        if let Some(bytes) = image_jpeg {
            if let Some(turn) = payload.iter_mut().rev().find(|turn| turn["role"] == "user") {
                let text = turn["content"].as_str().unwrap_or_default().to_owned();
                turn["content"] = json!([
                    {
                        "type": "image_url",
                        "image_url": {
                            "url": format!("data:image/jpeg;base64,{}", BASE64.encode(bytes))
                        }
                    },
                    {"type": "text", "text": text}
                ]);
            }
        }
        let body = json!({
            "model": config.chat_model,
            "messages": payload,
            "temperature": CHAT_TEMPERATURE,
            "max_tokens": CHAT_MAX_TOKENS,
            "stream": true,
        });
        // Per-read idle timeout instead of an overall deadline: long replies
        // must not hit a hard cap, but a stalled connection still errors out
        // after one silent minute. Here `.timeout_read()` does bite, because
        // this request runs without the agent-level 120 s deadline.
        let agent = ureq::AgentBuilder::new()
            .timeout_connect(AI_CONNECT_TIMEOUT)
            .timeout_read(AI_READ_TIMEOUT)
            .build();
        let mut request = agent
            .post(format!("{}/chat/completions", config.chat_base_url).as_str())
            .set("Accept", "text/event-stream");
        if let Some((name, value)) = authorization_header(&config.chat_api_key) {
            request = request.set(name, &value);
        }
        let response = request
            .send_json(body)
            .map_err(|error| map_http_error("对话模型请求", error))?;
        let reader = std::io::BufReader::new(response.into_reader());
        let mut full = String::new();
        use std::io::BufRead;
        for line in reader.lines() {
            let line =
                line.map_err(|error| AppError::io(format!("对话模型流式读取失败: {error}")))?;
            let trimmed = line.trim();
            // Empty lines separate SSE events; `:` lines are keep-alive
            // comments (e.g. OpenRouter's processing pings).
            if trimmed.is_empty() || trimmed.starts_with(':') {
                continue;
            }
            let data = trimmed
                .strip_prefix("data:")
                .map(str::trim)
                .unwrap_or(trimmed);
            if data == "[DONE]" {
                break;
            }
            match parse_stream_delta(data)? {
                Some(text) if !text.is_empty() => {
                    if !on_delta(&text) {
                        // User cancelled: keep what we already streamed.
                        return Ok(full);
                    }
                    full.push_str(&text);
                }
                _ => {}
            }
        }
        Ok(full)
    }

    fn embed(&self, config: &AiConfig, text: &str) -> Result<Vec<f32>, AppError> {
        let body = json!({
            "model": config.embedding_model,
            "input": [text],
        });
        let agent = Self::agent();
        let mut request = agent.post(format!("{}/embeddings", config.embedding_base_url).as_str());
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
        .as_chunks::<4>()
        .0
        .iter()
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
///
/// The backoff below is `std::thread::sleep`, i.e. it parks the *calling*
/// thread for up to 1 + 2 s across `MAX_CHAT_ATTEMPTS`. Callers must therefore
/// be blocking contexts (`spawn_blocking` from a command, or one of the batch
/// worker threads) — never the IPC/window thread, which would freeze the UI
/// for the whole retry window.
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
    // 进度事件发射：这几个形参就是前端 AiIndexProgress 事件的字段，调用点
    // （成功/失败/跳过/收尾）逐个直传；包成结构体会让每处调用先造一次临时对象。
    #[allow(clippy::too_many_arguments)]
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
// AI 索引任务的线程启动入口：库路径、缩略图缓存、作业与取消旗标逐项透传，
// 与 commands 层收到的载荷同构；包成结构体只是把同一批字段再抄一遍。
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

// 索引批次的工作体：沿用 spawn_run 的同一组上下文（库、缓存、作业、取消），
// 逐项传入以便工作线程内按需借用，不额外制造所有权转移。
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

// ── Chat assistant (drawer) ─────────────────────────────────────────────────

/// Extract the text delta from one SSE `data:` payload. Tolerates malformed
/// keep-alive lines (skipped) but surfaces an in-stream error object.
fn parse_stream_delta(data: &str) -> Result<Option<String>, AppError> {
    if !data.starts_with('{') {
        return Ok(None);
    }
    let value: serde_json::Value = match serde_json::from_str(data) {
        Ok(value) => value,
        Err(_) => return Ok(None),
    };
    if let Some(error) = value.get("error") {
        return Err(AppError::internal(format!(
            "对话模型流式返回错误: {}",
            truncate(&error.to_string(), 200)
        )));
    }
    Ok(value
        .pointer("/choices/0/delta/content")
        .and_then(|content| content.as_str())
        .map(str::to_owned))
}

/// Keep only the last few turns, drop empty/foreign roles, and make sure the
/// sequence starts with a user message (some providers reject otherwise).
fn capped_history(history: &[AiChatTurn]) -> Vec<AiChatTurn> {
    let kept: Vec<AiChatTurn> = history
        .iter()
        .rev()
        .take(MAX_CHAT_HISTORY)
        .rev()
        .filter(|turn| {
            matches!(turn.role.as_str(), "user" | "assistant") && !turn.content.trim().is_empty()
        })
        .cloned()
        .collect();
    match kept.first() {
        Some(turn) if turn.role == "assistant" => kept[1..].to_vec(),
        _ => kept,
    }
}

fn describe_preview(preview: &AiChatPreview) -> String {
    let mut parts = vec![format!("文件名 {}", preview.display_name)];
    if let Some(kind) = &preview.kind {
        parts.push(format!("类型 {kind}"));
    }
    if let Some(date) = &preview.capture_date {
        parts.push(format!("拍摄日期 {date}"));
    }
    if let Some(rating) = preview.rating {
        parts.push(format!("评分 {rating}/5"));
    }
    if let Some(favorite) = preview.favorite {
        parts.push(format!("收藏 {favorite}"));
    }
    if let Some(caption) = &preview.ai_caption {
        parts.push(format!("AI 描述：{caption}"));
    }
    if !preview.ai_tags.is_empty() {
        parts.push(format!("AI 标签：{}", preview.ai_tags.join("、")));
    }
    parts.join("，")
}

/// System prompt grounding the assistant in local index data. Everything the
/// model knows about this library is injected here; nothing is invented.
fn build_chat_system_prompt(
    brief: Option<&crate::db::LibraryBrief>,
    top_tags: &[crate::db::Tag],
    context: &AiChatContext,
    today: &str,
) -> String {
    let mut prompt =
        format!("你是 Camlib 个人相册的 AI 助手，帮用户了解和管理本地媒体库。今天是 {today}。\n");
    match brief {
        Some(brief) => prompt.push_str(&format!(
            "\n【媒体库概况】（本地索引统计，回答数量、时间范围、容量等问题时以此为准）\n{}\n",
            serde_json::to_string(brief).unwrap_or_default()
        )),
        None => prompt.push_str("\n【媒体库概况】暂不可用。\n"),
    }
    if !top_tags.is_empty() {
        let tags = top_tags
            .iter()
            .map(|tag| {
                if tag.has_ai {
                    format!("{}×{}(AI)", tag.name, tag.media_count)
                } else {
                    format!("{}×{}", tag.name, tag.media_count)
                }
            })
            .collect::<Vec<_>>()
            .join("、");
        prompt.push_str(&format!("\n【常用标签】{tags}\n"));
    }
    match &context.view {
        Some(serde_json::Value::Object(view)) if !view.is_empty() => {
            prompt.push_str(&format!(
                "\n【当前浏览上下文】用户正在按这些条件浏览媒体：{}\n",
                context.view.as_ref().unwrap()
            ));
        }
        _ => {}
    }
    if let Some(preview) = &context.preview {
        prompt.push_str(&format!(
            "\n【正在查看的照片】{}。用户消息可能附带这张照片的缩略图，可结合画面回答。\n",
            describe_preview(preview)
        ));
    }
    if let Some(selection) = &context.selection {
        if selection.count > 0 {
            let names: String = selection
                .names
                .iter()
                .take(10)
                .cloned()
                .collect::<Vec<_>>()
                .join("、");
            prompt.push_str(&format!(
                "\n【已选中】{} 张照片（{}）。\n",
                selection.count, names
            ));
        }
    }
    prompt.push_str(&format!(
        "\n回答要求：\n\
         - 用简体中文，简洁、准确、口语化；不确定的不要编造。\n\
         - 优先回答与相册、照片、视频相关的问题，也可以聊通用摄影话题。\n\
         - 如果用户想找出某些照片或视频（例如\u{201c}去年秋天的湖边\u{201d}），在回答的最后另起一行输出 \
         `{CHAT_SEARCH_MARKER} 关键词`，关键词将用于语义搜索；一次最多一个，其他情况不要输出这个标记。\n"
    ));
    prompt
}

/// Collect grounding context, then stream one assistant reply. Thumbnail and
/// tag lookups degrade silently: a chat answer is more important than a
/// missing image or tag list.
// 一次对话所需的全部上下文（配置、历史、检索上下文、事件通道、编码器）：
// 拆成参数对象后调用点仍要逐字段填一遍，且会改变 run_chat 的对外签名。
#[allow(clippy::too_many_arguments)]
pub fn run_chat(
    repository: &Repository,
    transport: &dyn AiTransport,
    config: &AiConfig,
    library_id: Option<&str>,
    history: &[AiChatTurn],
    context: &AiChatContext,
    library_root: Option<&Path>,
    cache_dir: Option<&Path>,
    cancel: &AtomicBool,
    on_delta: &mut dyn FnMut(&str),
) -> Result<AiChatOutcome, AppError> {
    validate_config_for_run(config)?;
    let brief = library_id.and_then(|id| repository.library_brief(id).ok());
    let mut tags = repository.list_tags().unwrap_or_default();
    tags.retain(|tag| tag.media_count > 0);
    tags.sort_by(|left, right| {
        right
            .media_count
            .cmp(&left.media_count)
            .then_with(|| left.name.cmp(&right.name))
    });
    tags.truncate(CHAT_TOP_TAGS);

    let image_jpeg = match (&context.preview, library_root, cache_dir) {
        (Some(preview), Some(root), Some(cache_dir)) => repository
            .get_media_item_details(&preview.media_id)
            .map_err(AppError::from)
            .ok()
            .flatten()
            .and_then(|details| {
                media::thumbnail_for_item(&details, root, cache_dir, AI_THUMBNAIL_WIDTH, None, None)
                    .ok()
                    .and_then(|thumbnail| std::fs::read(&thumbnail.cache_path).ok())
            }),
        _ => None,
    };

    let mut messages: Vec<AiChatTurn> = Vec::with_capacity(history.len() + 1);
    messages.push(AiChatTurn {
        role: "system".to_owned(),
        content: build_chat_system_prompt(brief.as_ref(), &tags, context, &local_today()),
    });
    let history = capped_history(history);
    messages.extend(history.iter().cloned());
    if !messages.iter().any(|turn| turn.role == "user") {
        return Err(AppError::invalid_argument("消息内容为空"));
    }

    let mut interrupted = false;
    let content =
        transport.chat_stream(config, &messages, image_jpeg.as_deref(), &mut |delta| {
            if cancel.load(Ordering::Relaxed) {
                interrupted = true;
                return false;
            }
            on_delta(delta);
            true
        })?;
    let content = content.trim_end().to_owned();
    if interrupted {
        return Ok(AiChatOutcome {
            content,
            cancelled: true,
        });
    }
    if content.is_empty() {
        return Err(AppError::internal("模型未返回内容"));
    }
    Ok(AiChatOutcome {
        content,
        cancelled: false,
    })
}

/// Peek whether the reply asks for a semantic search (`[搜索] 关键词` on its
/// own line). Exposed for tests; the frontend re-implements the same marker.
#[cfg(test)]
fn extract_search_marker(content: &str) -> Option<String> {
    content.lines().rev().find_map(|line| {
        let line = line.trim();
        line.strip_prefix(CHAT_SEARCH_MARKER)
            .map(str::trim)
            .filter(|query| !query.is_empty())
            .map(str::to_owned)
    })
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

        fn chat_stream(
            &self,
            _config: &AiConfig,
            _messages: &[AiChatTurn],
            _image_jpeg: Option<&[u8]>,
            on_delta: &mut dyn FnMut(&str) -> bool,
        ) -> Result<String, AppError> {
            let reply = self
                .replies
                .lock()
                .unwrap()
                .pop_front()
                .ok_or_else(|| AppError::internal("mock exhausted"))?;
            on_delta(&reply);
            Ok(reply)
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
        // Relation-table order is name-sorted, so compare as a set.
        assert_eq!(
            details
                .ai_tags
                .iter()
                .map(|tag| tag.name.as_str())
                .collect::<std::collections::BTreeSet<_>>(),
            ["风景", "秋"]
                .into_iter()
                .collect::<std::collections::BTreeSet<_>>()
        );
    }

    #[test]
    fn parse_stream_delta_handles_sse_payloads() {
        // Regular content chunk.
        assert_eq!(
            parse_stream_delta(r#"{"choices":[{"delta":{"content":"你好"}}]}"#).unwrap(),
            Some("你好".to_owned())
        );
        // Role-only first chunk and finish chunk carry no content.
        assert_eq!(
            parse_stream_delta(r#"{"choices":[{"delta":{"role":"assistant"}}]}"#).unwrap(),
            None
        );
        assert_eq!(
            parse_stream_delta(r#"{"choices":[{"delta":{},"finish_reason":"stop"}]}"#).unwrap(),
            None
        );
        // Keep-alive noise is skipped, not fatal.
        assert_eq!(parse_stream_delta("").unwrap(), None);
        assert_eq!(parse_stream_delta("not json at all").unwrap(), None);
        assert_eq!(parse_stream_delta("{broken").unwrap(), None);
        // Provider-side in-stream errors surface.
        assert!(parse_stream_delta(r#"{"error":{"message":"quota"}}"#).is_err());
    }

    #[test]
    fn capped_history_bounds_and_starts_with_user() {
        let turn = |role: &str, content: &str| AiChatTurn {
            role: role.to_owned(),
            content: content.to_owned(),
        };
        let history: Vec<AiChatTurn> = (0..30)
            .map(|index| {
                if index % 2 == 0 {
                    turn("user", &format!("q{index}"))
                } else {
                    turn("assistant", &format!("a{index}"))
                }
            })
            .collect();
        let capped = capped_history(&history);
        assert_eq!(capped.len(), MAX_CHAT_HISTORY);
        assert_eq!(capped[0].content, "q14");
        // Odd turn counts leave an assistant turn first; it is dropped.
        let odd = vec![
            turn("assistant", "a"),
            turn("user", "q"),
            turn("assistant", "a2"),
            turn("user", "q2"),
        ];
        let capped_odd = capped_history(&odd);
        assert_eq!(capped_odd.first().unwrap().content, "q");
        // Empty and unknown roles are filtered out.
        let noisy = vec![turn("system", "should not survive"), turn("user", "")];
        assert!(capped_history(&noisy).is_empty());
    }

    #[test]
    fn library_brief_counts_present_items() {
        let repository = setup();
        let brief = repository.library_brief("library-1").unwrap();
        assert_eq!(brief.total, 3);
        assert_eq!(brief.photos, 2);
        assert_eq!(brief.videos, 1);
        assert_eq!(brief.lives, 0);
        assert_eq!(brief.favorites, 0);
        assert_eq!(brief.date_from.as_deref(), Some("2025-10-20"));
        assert_eq!(brief.date_to.as_deref(), Some("2025-10-20"));
    }

    #[test]
    fn run_chat_streams_and_injects_context() {
        let repository = setup();
        let transport = MockTransport::new(
            "你的媒体库共有 3 项，其中照片 2 张。\n[搜索] 湖边",
            Vec::new(),
        );
        let cancel = AtomicBool::new(false);
        let context = AiChatContext {
            view: Some(json!({"kind": "photo"})),
            preview: Some(AiChatPreview {
                media_id: "photo-lake".into(),
                display_name: "photo-lake.jpg".into(),
                kind: Some("photo".into()),
                capture_date: Some("2025-10-20".into()),
                rating: Some(4),
                favorite: Some(true),
                ai_caption: Some("湖边秋色".into()),
                ai_tags: vec!["风景".into()],
            }),
            selection: Some(AiChatSelection {
                count: 1,
                names: vec!["photo-food.jpg".into()],
            }),
        };
        let history = vec![
            AiChatTurn {
                role: "user".into(),
                content: "我拍过多少照片？".into(),
            },
            AiChatTurn {
                role: "assistant".into(),
                content: "2 张。".into(),
            },
            AiChatTurn {
                role: "user".into(),
                content: "帮我找湖边的照片".into(),
            },
        ];
        let mut deltas: Vec<String> = Vec::new();
        let outcome = run_chat(
            &repository,
            &transport,
            &ready_config(),
            Some("library-1"),
            &history,
            &context,
            None,
            None,
            &cancel,
            &mut |delta| deltas.push(delta.to_owned()),
        )
        .unwrap();
        assert!(!outcome.cancelled);
        assert_eq!(deltas, vec![outcome.content.clone()]);
        assert_eq!(
            extract_search_marker(&outcome.content).as_deref(),
            Some("湖边")
        );
    }

    #[test]
    fn run_chat_reports_cancel_and_rejects_empty() {
        let repository = setup();
        // Reply arrives, but the cancel flag is already set: partial output.
        let transport = MockTransport::new("未完成的回复", Vec::new());
        let cancel = AtomicBool::new(true);
        let outcome = run_chat(
            &repository,
            &transport,
            &ready_config(),
            Some("library-1"),
            &[AiChatTurn {
                role: "user".into(),
                content: "你好".into(),
            }],
            &AiChatContext::default(),
            None,
            None,
            &cancel,
            &mut |_| {},
        )
        .unwrap();
        assert!(outcome.cancelled);

        // No user turn at all → rejected before any network call.
        let transport = MockTransport::new("unused", Vec::new());
        let cancel = AtomicBool::new(false);
        let error = run_chat(
            &repository,
            &transport,
            &ready_config(),
            Some("library-1"),
            &[],
            &AiChatContext::default(),
            None,
            None,
            &cancel,
            &mut |_| {},
        )
        .unwrap_err();
        assert!(error.to_string().contains("消息内容为空"));
    }

    #[test]
    fn system_prompt_contains_brief_and_marker_rule() {
        let brief = crate::db::LibraryBrief {
            total: 12,
            photos: 10,
            videos: 2,
            lives: 0,
            favorites: 3,
            total_size_bytes: 4096,
            date_from: Some("2024-01-01".into()),
            date_to: Some("2025-12-31".into()),
        };
        let context = AiChatContext::default();
        let prompt = build_chat_system_prompt(Some(&brief), &[], &context, "2026-11-01");
        assert!(prompt.contains("2026-11-01"));
        assert!(prompt.contains("\"total\":12"));
        assert!(prompt.contains(CHAT_SEARCH_MARKER));
    }
}
