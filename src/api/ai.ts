/**
 * AI 增强（可选云端 API）：自动打标 + 语义搜索的 invoke 封装。
 *
 * 命令与 DTO 与 `src-tauri/src/ai.rs` 一一对应；错误由调用方通过
 * `toUserMessage` 转成中文提示（本层不捕获）。
 */
import { invoke, Channel } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { UnlistenFn } from "@tauri-apps/api/event";
import type { MediaItemDto } from "./media";

/** 与 Rust `AiConfig` 对齐；API key 明文存本地（个人应用，设置页回显）。 */
export interface AiConfigDto {
  enabled: boolean;
  chatBaseUrl: string;
  chatModel: string;
  chatApiKey: string;
  embeddingBaseUrl: string;
  embeddingModel: string;
  embeddingApiKey: string;
  concurrency: number;
}

export interface AiTestResultDto {
  ok: boolean;
  message: string;
  latencyMs: number;
  dimension?: number;
}

export interface AiStatsDto {
  totalPhotos: number;
  processed: number;
  failed: number;
  pending: number;
  missingEmbedding: number;
  embeddingModel: string | null;
}

export type AiRunMode = "incremental" | "full" | "retry" | "embeddings";

export interface AiProcessPreviewDto {
  mode: AiRunMode;
  totalPhotos: number;
  processed: number;
  failed: number;
  pending: number;
  missingEmbedding: number;
  chatCalls: number;
  embeddingCalls: number;
  estimatedCalls: number;
}

export interface AiProgressDto {
  jobId: string;
  kind: string;
  seq: number;
  phase: "processing" | "finalizing" | "failed" | "cancelled";
  state: "running" | "completed" | "cancelled" | "failed";
  current: string | null;
  processed: number;
  total: number;
  succeeded: number;
  failed: number;
  skipped: number;
  errors: string[];
  error: string | null;
}

/** 查询解析结果；dateFrom/dateTo 为 YYYY-MM-DD。 */
export interface AiParsedQueryDto {
  dateFrom: string | null;
  dateTo: string | null;
  kind: string | null;
  keywords: string | null;
}

export interface AiSearchResultDto {
  items: MediaItemDto[];
  total: number;
  offset: number;
  limit: number;
  /** vector = 向量检索；text = caption/tags 关键字降级；structured = 纯条件。 */
  mode: "vector" | "text" | "structured";
  parsed: AiParsedQueryDto;
}

export interface AiProcessItemDto {
  status: "success" | "skipped";
  caption: string | null;
  tags: string[];
  message: string | null;
}

export function getAiConfig(): Promise<AiConfigDto> {
  return invoke<AiConfigDto>("ai_get_config");
}

export function setAiConfig(config: AiConfigDto): Promise<AiConfigDto> {
  return invoke<AiConfigDto>("ai_set_config", { config });
}

/** target: "chat" | "embedding"；AI 未开启时也可测试连通性。 */
export function testAiConnection(target: "chat" | "embedding"): Promise<AiTestResultDto> {
  return invoke<AiTestResultDto>("ai_test_connection", { target });
}

export function getAiStats(libraryId: string): Promise<AiStatsDto> {
  return invoke<AiStatsDto>("ai_stats", { libraryId });
}

export function previewAiProcess(
  libraryId: string,
  mode: AiRunMode,
): Promise<AiProcessPreviewDto> {
  return invoke<AiProcessPreviewDto>("ai_process_preview", { libraryId, mode });
}

export function startAiProcess(libraryId: string, mode: AiRunMode): Promise<{ jobId: string }> {
  return invoke<{ jobId: string }>("ai_process_start", { libraryId, mode });
}

export function cancelAiProcess(jobId: string): Promise<void> {
  return invoke<void>("ai_process_cancel", { jobId });
}

/** 单张同步处理（失败重试 / 链路验证用）。 */
export function processAiItem(mediaItemId: string): Promise<AiProcessItemDto> {
  return invoke<AiProcessItemDto>("ai_process_item", { mediaItemId });
}

export function aiSearch(
  libraryId: string,
  query: string,
  offset?: number,
  limit?: number,
): Promise<AiSearchResultDto> {
  return invoke<AiSearchResultDto>("ai_search", {
    libraryId,
    query,
    offset,
    limit,
  });
}

export function detachAiTag(mediaItemId: string, tagId: string): Promise<void> {
  return invoke<void>("ai_tag_detach", { mediaItemId, tagId });
}

export function onAiProgress(
  callback: (progress: AiProgressDto) => void,
): Promise<UnlistenFn> {
  return listen<AiProgressDto>("ai-progress", (event) => callback(event.payload));
}

// ── AI 助手（聊天抽屉，流式回传） ────────────────────────────────────────────

/** 与 Rust `AiChatTurn` 对齐；系统提示词由 Rust 端统一构建，前端只传对话轮次。 */
export interface AiChatTurnDto {
  role: "user" | "assistant";
  content: string;
}

/** 正在预览的照片上下文；mediaId 用于 Rust 端取缩略图随消息发送。 */
export interface AiChatPreviewDto {
  mediaId: string;
  displayName: string;
  kind?: string;
  captureDate?: string;
  rating?: number;
  favorite?: boolean;
  aiCaption?: string;
  aiTags?: string[];
}

export interface AiChatSelectionDto {
  count: number;
  names: string[];
}

/** 与 Rust `AiChatContext` 对齐；view 为当前筛选条件的自由 JSON。 */
export interface AiChatContextDto {
  view?: Record<string, unknown>;
  preview?: AiChatPreviewDto;
  selection?: AiChatSelectionDto;
}

export interface AiChatResultDto {
  content: string;
  cancelled: boolean;
}

/** Rust `AiChatEvent` 的序列化形态（内部 tagged enum）。 */
export interface AiChatEventDto {
  type: "delta";
  text: string;
}

/**
 * 流式对话：delta 通过 Tauri Channel 逐段回调，Promise 在整条回复结束时
 * 兑现（含取消后的部分内容）。本层不捕获错误。
 */
export function streamAiChat(
  libraryId: string,
  history: AiChatTurnDto[],
  context: AiChatContextDto,
  onDelta: (text: string) => void,
): Promise<AiChatResultDto> {
  const channel = new Channel<AiChatEventDto>();
  channel.onmessage = (event) => onDelta(event.text);
  return invoke<AiChatResultDto>("ai_chat", {
    libraryId,
    history,
    context,
    onEvent: channel,
  });
}

/** 请求停止当前流式回复；已生成的部分内容会随命令结果返回。 */
export function cancelAiChat(): Promise<void> {
  return invoke<void>("ai_chat_cancel");
}
