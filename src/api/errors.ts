/**
 * Structured error contract shared with Rust commands.
 * Shape: { code, message, retryable, details? }
 */

export type AppErrorCode =
  | "INVALID_ARGUMENT"
  | "LIBRARY_OFFLINE"
  | "PATH_OUTSIDE_ROOT"
  | "VOLUME_CHANGED"
  | "MEDIA_MISSING"
  | "CONFLICT"
  | "INSUFFICIENT_SPACE"
  | "JOB_NOT_FOUND"
  | "JOB_ALREADY_RUNNING"
  | "CANCELLED"
  | "IO_ERROR"
  | "DATABASE_ERROR"
  | "THUMBNAIL_ERROR"
  | "INTERNAL";

export interface AppErrorPayload {
  code: AppErrorCode | string;
  message: string;
  retryable?: boolean;
  details?: unknown;
}

const USER_MESSAGES: Record<string, string> = {
  INVALID_ARGUMENT: "请求参数无效，请检查后重试",
  LIBRARY_OFFLINE: "媒体库所在卷当前不可用，请连接磁盘后重试",
  PATH_OUTSIDE_ROOT: "路径超出媒体库范围，操作已拒绝",
  VOLUME_CHANGED: "当前磁盘与记录的媒体库不一致，请重新选择媒体库",
  MEDIA_MISSING: "媒体文件已离线或不存在",
  CONFLICT: "目标位置存在冲突，请调整策略后重试",
  INSUFFICIENT_SPACE: "目标盘空间不足",
  JOB_NOT_FOUND: "任务不存在或已结束",
  JOB_ALREADY_RUNNING: "已有任务正在运行，请稍候再试",
  CANCELLED: "操作已取消",
  IO_ERROR: "文件读写失败，请检查磁盘状态",
  DATABASE_ERROR: "索引数据库错误，请查看设置中的记录",
  THUMBNAIL_ERROR: "缩略图处理失败，不影响原始媒体",
  INTERNAL: "操作失败，请稍后重试",
};

export function isAppErrorPayload(value: unknown): value is AppErrorPayload {
  return (
    typeof value === "object" &&
    value !== null &&
    "code" in value &&
    typeof (value as AppErrorPayload).code === "string" &&
    "message" in value
  );
}

/** Parse whatever Tauri invoke rejects with into a structured payload. */
export function parseCommandError(error: unknown): AppErrorPayload {
  if (isAppErrorPayload(error)) return error;
  if (typeof error === "string") {
    // Legacy string errors and JSON-stringified payloads.
    if (error.startsWith("{")) {
      try {
        const parsed: unknown = JSON.parse(error);
        if (isAppErrorPayload(parsed)) return parsed;
      } catch {
        // keep as plain message
      }
    }
    return { code: "INTERNAL", message: error };
  }
  if (error instanceof Error) {
    return { code: "INTERNAL", message: error.message };
  }
  return { code: "INTERNAL", message: "未知错误" };
}

/**
 * User-facing Chinese copy. Prefers a stable code mapping, then falls back to
 * the backend message so newly added codes still surface something useful.
 */
export function toUserMessage(error: unknown, fallback?: string): string {
  const payload = parseCommandError(error);
  const base = USER_MESSAGES[payload.code];
  // Keep backend detail for codes where the message is already localizable
  // Chinese, or when there is no mapping.
  if (!base) return payload.message || fallback || "操作失败";
  if (payload.code === "LIBRARY_OFFLINE" || payload.code === "VOLUME_CHANGED") {
    return payload.message || base;
  }
  return base;
}

export function errorCodeOf(error: unknown): string {
  return parseCommandError(error).code;
}

export function isRetryableError(error: unknown): boolean {
  return Boolean(parseCommandError(error).retryable);
}
