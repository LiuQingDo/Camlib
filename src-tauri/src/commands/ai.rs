//! AI configuration, batch tagging, single-item retries, search, and chat.

use super::ensure_library_ready;
use crate::ai::{
    self, AiChatContext, AiChatEvent, AiChatTurn, AiConfig, AiJobManagerState, AiRunMode,
    AiTransport,
};
use crate::db;
use crate::errors::AppError;
use crate::infrastructure::{self, InfrastructureError, InfrastructureState};
use crate::AiChatState;
use serde::Serialize;
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use tauri::ipc::Channel;
use tauri::{AppHandle, State};

// ── AI enhancement (optional, cloud API) ────────────────────────────────────

#[tauri::command]
pub fn ai_get_config(state: State<'_, InfrastructureState>) -> Result<AiConfig, AppError> {
    state.with_infrastructure(|infrastructure| {
        ai::load_config(infrastructure.repository()).map_err(InfrastructureError::App)
    })
}

#[tauri::command]
pub fn ai_set_config(
    config: AiConfig,
    state: State<'_, InfrastructureState>,
) -> Result<AiConfig, AppError> {
    state.with_infrastructure(|infrastructure| {
        ai::save_config(infrastructure.repository(), config).map_err(InfrastructureError::App)
    })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiTestResultDto {
    ok: bool,
    message: String,
    latency_ms: u64,
    dimension: Option<i64>,
}

/// Minimal reachability probe for one endpoint group. Works while AI is still
/// disabled so users can validate credentials before turning the feature on.
///
/// The probe is a blocking HTTP round-trip, so the command itself only
/// snapshots the config (the `State` borrow ends before the first `await`) and
/// the network call runs on a blocking worker.
#[tauri::command]
pub async fn ai_test_connection(
    target: String,
    state: State<'_, InfrastructureState>,
) -> Result<AiTestResultDto, AppError> {
    let config = state.with_infrastructure(|infrastructure| {
        ai::load_config(infrastructure.repository()).map_err(InfrastructureError::App)
    })?;
    tauri::async_runtime::spawn_blocking(move || ai_test_connection_blocking(&target, &config))
        .await
        .map_err(|error| AppError::internal(format!("连接测试异常结束: {error}")))?
}

/// Body of `ai_test_connection` after the infrastructure lock is released.
pub fn ai_test_connection_blocking(
    target: &str,
    config: &AiConfig,
) -> Result<AiTestResultDto, AppError> {
    let transport = ai::UreqTransport;
    let started = std::time::Instant::now();
    match target {
        "chat" => {
            if !config.chat_ready() {
                return Ok(AiTestResultDto {
                    ok: false,
                    message: "请先填写对话模型 Base URL 与模型名称".to_owned(),
                    latency_ms: 0,
                    dimension: None,
                });
            }
            let reply = transport.chat(&config, "请只回复两个字：正常", None)?;
            let latency = started.elapsed().as_millis() as u64;
            Ok(AiTestResultDto {
                ok: !reply.trim().is_empty(),
                message: format!("模型 {} 已连通（{latency} ms）", config.chat_model),
                latency_ms: latency,
                dimension: None,
            })
        }
        "embedding" => {
            if !config.embedding_ready() {
                return Ok(AiTestResultDto {
                    ok: false,
                    message: "请先填写 Embedding 模型 Base URL 与模型名称".to_owned(),
                    latency_ms: 0,
                    dimension: None,
                });
            }
            let vector = transport.embed(&config, "连通性测试")?;
            let latency = started.elapsed().as_millis() as u64;
            Ok(AiTestResultDto {
                ok: true,
                message: format!(
                    "模型 {} 已连通，向量维度 {}（{latency} ms）",
                    config.embedding_model,
                    vector.len()
                ),
                latency_ms: latency,
                dimension: Some(vector.len() as i64),
            })
        }
        other => Err(AppError::invalid_argument(format!(
            "不支持的测试目标: {other}"
        ))),
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiStatsDto {
    total_photos: i64,
    processed: i64,
    failed: i64,
    pending: i64,
    missing_embedding: i64,
    embedding_model: Option<String>,
}

/// Counters for the settings AI card.
#[tauri::command]
pub fn ai_stats(
    library_id: String,
    state: State<'_, InfrastructureState>,
) -> Result<AiStatsDto, AppError> {
    state.with_infrastructure(|infrastructure| {
        let repository = infrastructure.repository();
        let config = ai::load_config(repository).map_err(InfrastructureError::App)?;
        let stats = repository
            .ai_stats(&library_id)
            .map_err(infrastructure::InfrastructureError::database)?;
        let missing_embedding = if config.embedding_ready() {
            repository
                .list_ai_missing_embeddings(&library_id, config.embedding_model.trim())
                .map_err(infrastructure::InfrastructureError::database)?
                .len() as i64
        } else {
            0
        };
        Ok(AiStatsDto {
            total_photos: stats.total_photos,
            processed: stats.processed,
            failed: stats.failed,
            pending: stats.pending,
            missing_embedding,
            embedding_model: config
                .embedding_ready()
                .then(|| config.embedding_model.clone()),
        })
    })
}

#[tauri::command]
pub fn ai_process_preview(
    library_id: String,
    mode: String,
    state: State<'_, InfrastructureState>,
) -> Result<ai::AiProcessPreviewDto, AppError> {
    let mode = AiRunMode::parse(&mode)?;
    state.with_infrastructure(|infrastructure| {
        let repository = infrastructure.repository();
        let config = ai::load_config(repository).map_err(InfrastructureError::App)?;
        ai::validate_config_for_run(&config).map_err(InfrastructureError::App)?;
        ai::preview(repository, &config, &library_id, mode).map_err(InfrastructureError::App)
    })
}

/// Start a cancellable AI batch run; progress arrives on `ai-progress`.
#[tauri::command]
pub fn ai_process_start(
    library_id: String,
    mode: String,
    app: AppHandle,
    infrastructure: State<'_, InfrastructureState>,
    jobs: State<'_, AiJobManagerState>,
) -> Result<ai::AiJobStartDto, AppError> {
    let mode = AiRunMode::parse(&mode)?;
    let (database_path, root, cache_dir) = infrastructure.with_infrastructure(|value| {
        ensure_library_ready(value, &library_id)?;
        let library = value
            .repository()
            .get_library(&library_id)
            .map_err(infrastructure::InfrastructureError::database)?
            .ok_or_else(|| {
                infrastructure::InfrastructureError::InvalidPath("媒体库不存在".to_owned())
            })?;
        let settings = value.settings()?;
        Ok((
            value.database_path(),
            PathBuf::from(&library.root_path),
            PathBuf::from(&settings.thumbnail_cache_dir),
        ))
    })?;
    {
        let repository = db::Repository::open(&database_path).map_err(AppError::from)?;
        let config = ai::load_config(&repository)?;
        ai::validate_config_for_run(&config)?;
    }
    let (job_id, cancel) = jobs.start()?;
    ai::spawn_run(
        app,
        std::sync::Arc::new(jobs.inner().clone()),
        database_path,
        root,
        cache_dir,
        library_id,
        job_id.clone(),
        cancel,
        mode,
    );
    Ok(ai::AiJobStartDto { job_id })
}

#[tauri::command]
pub fn ai_process_cancel(
    job_id: String,
    jobs: State<'_, AiJobManagerState>,
) -> Result<(), AppError> {
    jobs.cancel(&job_id)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiChatResultDto {
    content: String,
    cancelled: bool,
}

/// Streamed assistant reply for the chat drawer. Text chunks arrive on the
/// Tauri channel while the command blocks until the provider finishes (or the
/// user cancels). Context collection and streaming both run on the command's
/// own thread with an independently opened repository, so the shared
/// infrastructure lock is never held across network I/O.
#[tauri::command]
pub fn ai_chat(
    library_id: String,
    history: Vec<AiChatTurn>,
    context: AiChatContext,
    on_event: Channel<AiChatEvent>,
    state: State<'_, InfrastructureState>,
    chat: State<'_, AiChatState>,
) -> Result<AiChatResultDto, AppError> {
    let (database_path, root, cache_dir) = state.with_infrastructure(|infrastructure| {
        ensure_library_ready(infrastructure, &library_id)?;
        let library = infrastructure
            .repository()
            .get_library(&library_id)
            .map_err(infrastructure::InfrastructureError::database)?
            .ok_or_else(|| {
                infrastructure::InfrastructureError::InvalidPath("媒体库不存在".to_owned())
            })?;
        let settings = infrastructure.settings()?;
        Ok((
            infrastructure.database_path(),
            PathBuf::from(&library.root_path),
            PathBuf::from(&settings.thumbnail_cache_dir),
        ))
    })?;
    if chat.busy.swap(true, Ordering::SeqCst) {
        return Err(AppError::invalid_argument(
            "AI 助手正在回复中，请等当前回复结束",
        ));
    }
    chat.cancel.store(false, Ordering::SeqCst);
    let result = ai_chat_stream(
        database_path,
        root,
        cache_dir,
        library_id,
        history,
        context,
        &chat,
        &on_event,
    );
    chat.busy.store(false, Ordering::SeqCst);
    result
}

/// Body of `ai_chat` after the infrastructure lock is released: the network
/// stream runs against an independently opened repository.
pub fn ai_chat_stream(
    database_path: PathBuf,
    root: PathBuf,
    cache_dir: PathBuf,
    library_id: String,
    history: Vec<AiChatTurn>,
    context: AiChatContext,
    chat: &AiChatState,
    on_event: &Channel<AiChatEvent>,
) -> Result<AiChatResultDto, AppError> {
    let repository = db::Repository::open(&database_path).map_err(AppError::from)?;
    let config = ai::load_config(&repository)?;
    let transport = ai::UreqTransport;
    let outcome = ai::run_chat(
        &repository,
        &transport,
        &config,
        Some(&library_id),
        &history,
        &context,
        Some(&root),
        Some(&cache_dir),
        &chat.cancel,
        &mut |delta| {
            let _ = on_event.send(AiChatEvent::Delta {
                text: delta.to_owned(),
            });
        },
    )?;
    Ok(AiChatResultDto {
        content: outcome.content,
        cancelled: outcome.cancelled,
    })
}

/// Ask the streaming loop to stop at the next delta; the partial reply is
/// kept and returned as the command result.
#[tauri::command]
pub fn ai_chat_cancel(chat: State<'_, AiChatState>) -> Result<(), AppError> {
    chat.cancel.store(true, Ordering::SeqCst);
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiProcessItemDto {
    status: String,
    caption: Option<String>,
    tags: Vec<String>,
    message: Option<String>,
}

/// Run the full pipeline for one photo (single retry / testing).
///
/// Thumbnail rendering and the vision call take seconds to tens of seconds, so
/// the blocking body is pushed off the command thread: the sync section only
/// resolves the paths it needs and drops the `State` borrow before awaiting.
#[tauri::command]
pub async fn ai_process_item(
    media_item_id: String,
    state: State<'_, InfrastructureState>,
) -> Result<AiProcessItemDto, AppError> {
    let (database_path, root, cache_dir) = state.with_infrastructure(|infrastructure| {
        let details = infrastructure
            .repository()
            .get_media_item_details(&media_item_id)
            .map_err(infrastructure::InfrastructureError::database)?
            .ok_or_else(|| {
                infrastructure::InfrastructureError::MediaMissing("媒体不存在".to_owned())
            })?;
        let library = infrastructure
            .repository()
            .get_library(&details.item.library_id)
            .map_err(infrastructure::InfrastructureError::database)?
            .ok_or_else(|| {
                infrastructure::InfrastructureError::InvalidPath("媒体库不存在".to_owned())
            })?;
        let settings = infrastructure.settings()?;
        Ok((
            infrastructure.database_path(),
            PathBuf::from(&library.root_path),
            PathBuf::from(&settings.thumbnail_cache_dir),
        ))
    })?;
    tauri::async_runtime::spawn_blocking(move || {
        ai_process_item_blocking(&media_item_id, database_path, root, cache_dir)
    })
    .await
    .map_err(|error| AppError::internal(format!("单张打标异常结束: {error}")))?
}

/// Body of `ai_process_item` after the infrastructure lock is released: the
/// pipeline runs against an independently opened repository.
pub fn ai_process_item_blocking(
    media_item_id: &str,
    database_path: PathBuf,
    root: PathBuf,
    cache_dir: PathBuf,
) -> Result<AiProcessItemDto, AppError> {
    let repository = db::Repository::open(&database_path).map_err(AppError::from)?;
    let config = ai::load_config(&repository)?;
    ai::validate_config_for_run(&config)?;
    let details = repository
        .get_media_item_details(media_item_id)
        .map_err(AppError::from)?
        .ok_or_else(|| AppError::media_missing("媒体不存在"))?;
    let transport = ai::UreqTransport;
    match ai::process_item(
        &repository,
        &transport,
        &config,
        &details,
        &root,
        &cache_dir,
    )? {
        ai::AiItemOutcome::Tagged { .. } => {
            let row = repository
                .get_media_ai(media_item_id)
                .map_err(AppError::from)?
                .ok_or_else(|| AppError::internal("AI 结果未写入"))?;
            Ok(AiProcessItemDto {
                status: "success".to_owned(),
                caption: row.caption,
                tags: row
                    .tags_json
                    .as_deref()
                    .and_then(|json| serde_json::from_str(json).ok())
                    .unwrap_or_default(),
                message: None,
            })
        }
        ai::AiItemOutcome::Skipped => Ok(AiProcessItemDto {
            status: "skipped".to_owned(),
            caption: None,
            tags: Vec::new(),
            message: Some("缩略图不可用，已跳过".to_owned()),
        }),
    }
}

/// Natural-language semantic search over AI captions/embeddings.
///
/// Two network calls (query parsing + query embedding) sit behind this command,
/// so it is async: the sync section grabs the config and database path, then the
/// retrieval runs on a blocking worker against its own repository handle.
#[tauri::command]
pub async fn ai_search(
    library_id: String,
    query: String,
    offset: Option<i64>,
    limit: Option<i64>,
    state: State<'_, InfrastructureState>,
) -> Result<ai::AiSearchResult, AppError> {
    let (config, database_path) = state.with_infrastructure(|infrastructure| {
        let config =
            ai::load_config(infrastructure.repository()).map_err(InfrastructureError::App)?;
        Ok((config, infrastructure.database_path()))
    })?;
    tauri::async_runtime::spawn_blocking(move || {
        ai_search_blocking(database_path, config, library_id, query, offset, limit)
    })
    .await
    .map_err(|error| AppError::internal(format!("搜索任务异常结束: {error}")))?
}

/// Body of `ai_search` after the infrastructure lock is released.
pub fn ai_search_blocking(
    database_path: PathBuf,
    config: AiConfig,
    library_id: String,
    query: String,
    offset: Option<i64>,
    limit: Option<i64>,
) -> Result<ai::AiSearchResult, AppError> {
    let repository = db::Repository::open(&database_path).map_err(AppError::from)?;
    let transport = ai::UreqTransport;
    ai::search(
        &repository,
        &transport,
        &config,
        &library_id,
        &query,
        offset.unwrap_or(0),
        limit.unwrap_or(120).clamp(1, 500),
    )
}

/// Remove one AI tag from one photo (does not touch user tags).
#[tauri::command]
pub fn ai_tag_detach(
    media_item_id: String,
    tag_id: String,
    state: State<'_, InfrastructureState>,
) -> Result<(), AppError> {
    state.with_infrastructure(|infrastructure| {
        infrastructure
            .repository()
            .detach_ai_tag(&media_item_id, &tag_id)
            .map_err(infrastructure::InfrastructureError::database)
    })
}
