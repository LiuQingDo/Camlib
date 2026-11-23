// 由 main.ts 拆分而来：从「横幅式提示」改成 toast 的薄封装。
import { clearToasts, showToast } from "./toast";

/**
 * 批量操作的成功 / 失败提示。
 *
 * 保留旧签名（paint 门面与十几个调用点都按它调），内部走 toast：
 * 固定在右下角、不随内容滚动；同一条文案用同一个 key 合并，连续点收藏
 * 只会刷新那一条，而不是排队把它顶掉。
 */
export function showTransientNotice(message: string, kind: "success" | "error" = "success"): void {
  if (!message) return;
  showToast(message, { kind, key: `${kind}:${message}` });
}

/** 兼容旧入口：一次性清掉屏上的 toast。 */
export function clearTransientNotice(): void {
  clearToasts();
}
