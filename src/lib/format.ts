/**
 * Pure display formatters.
 *
 * Moved verbatim out of `main.ts` so the formatting rules can be unit tested
 * without a DOM. Every string produced here must stay byte-for-byte identical
 * to the previous inline implementations — the UI renders these directly.
 */

/** Video duration badge: `m:ss`, or `h:mm:ss` once past an hour. */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const mmss = `${minutes}:${String(seconds).padStart(2, "0")}`;
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}` : mmss;
}

/**
 * Capture timestamp: `unix-ms:` values become a localized datetime, everything
 * else (already-formatted strings, empty input) passes through untouched.
 */
export function formatCaptureAt(value: string | null): string | null {
  if (!value) return null;
  if (value.startsWith("unix-ms:")) {
    const ms = Number(value.slice("unix-ms:".length));
    if (Number.isFinite(ms)) {
      const date = new Date(ms);
      if (!Number.isNaN(date.getTime())) return date.toLocaleString("zh-CN");
    }
  }
  return value;
}

/** Thousands-separated counts, e.g. `1,234`. */
export function formatCount(value: number): string { return new Intl.NumberFormat("zh-CN").format(value); }

/** Human byte sizes with B/KB/MB/GB/TB steps; bad input reads `未知`. */
export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "未知";
  if (bytes < 1024) return `${Math.max(0, Math.round(bytes))} B`;
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes < 1024 ** 4) return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  return `${(bytes / 1024 ** 4).toFixed(2)} TB`;
}

/** Transfer speed; non-positive or non-finite values are still "estimating". */
export function formatSpeed(bytesPerSec: number): string {
  if (!Number.isFinite(bytesPerSec) || bytesPerSec <= 0) return "估算中";
  return `${formatSize(bytesPerSec)}/秒`;
}

/** ETA in seconds, rendered as 秒 / 分 / 小时 buckets. */
export function formatEtaSeconds(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return "估算中";
  if (seconds < 60) return `约 ${Math.ceil(seconds)} 秒`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  if (minutes < 60) return `约 ${minutes} 分 ${rest} 秒`;
  const hours = Math.floor(minutes / 60);
  return `约 ${hours} 小时 ${minutes % 60} 分`;
}

/** Keeps the tail of a path, prefixing an ellipsis once it exceeds `maxLength`. */
export function truncatePath(path: string | null | undefined, maxLength = 48): string {
  if (!path) return "—";
  if (path.length <= maxLength) return path;
  return `…${path.slice(-(maxLength - 1))}`;
}

/** Date-range chip label; either bound may be missing. */
export function formatRangeLabel(from: string | undefined, to: string | undefined): string {
  if (from && to) return `${from} ~ ${to}`;
  if (from) return `自 ${from}`;
  if (to) return `至 ${to}`;
  return "";
}
