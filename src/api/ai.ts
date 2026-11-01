/**
 * AI 增强（可选云端 API）：自动打标 + 语义搜索的 invoke 封装。
 *
 * 命令与 DTO 与 `src-tauri/src/ai.rs` 一一对应；错误由调用方通过
 * `toUserMessage` 转成中文提示（本层不捕获）。
 */
import { invoke } from "@tauri-apps/api/core";
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
