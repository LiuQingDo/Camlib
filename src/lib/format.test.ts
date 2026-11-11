import { describe, expect, it } from "vitest";
import {
  formatCaptureAt,
  formatCount,
  formatDuration,
  formatEtaSeconds,
  formatRangeLabel,
  formatSize,
  formatSpeed,
  truncatePath,
} from "./format";

describe("formatSize", () => {
  it("renders zero and sub-KB byte counts verbatim", () => {
    expect(formatSize(0)).toBe("0 B");
    expect(formatSize(1)).toBe("1 B");
    expect(formatSize(1023)).toBe("1023 B");
  });

  it("rejects negative and non-finite input", () => {
    expect(formatSize(-1)).toBe("未知");
    expect(formatSize(-1024)).toBe("未知");
    expect(formatSize(Number.NaN)).toBe("未知");
    expect(formatSize(Number.POSITIVE_INFINITY)).toBe("未知");
  });

  it("rounds to the nearest unit without losing the floor", () => {
    // 1023.6 rounds up into the next unit's digits but stays a B string.
    expect(formatSize(1023.6)).toBe("1024 B");
    expect(formatSize(1024)).toBe("1 KB");
    expect(formatSize(1536)).toBe("2 KB");
    expect(formatSize(1024 * 1024 * 1.5)).toBe("1.5 MB");
    expect(formatSize(1024 ** 3)).toBe("1.00 GB");
  });

  it("handles the >1TB range and the GB/TB boundary", () => {
    expect(formatSize(1024 ** 4 - 1)).toBe("1024.00 GB");
    expect(formatSize(1024 ** 4)).toBe("1.00 TB");
    expect(formatSize(5 * 1024 ** 4)).toBe("5.00 TB");
    expect(formatSize(1024 ** 5)).toBe("1024.00 TB");
  });
});

describe("formatSpeed", () => {
  it("keeps the estimating label for zero, negative and non-finite speeds", () => {
    expect(formatSpeed(0)).toBe("估算中");
    expect(formatSpeed(-2048)).toBe("估算中");
    expect(formatSpeed(Number.NaN)).toBe("估算中");
  });

  it("appends the per-second suffix to a formatted size", () => {
    expect(formatSpeed(1024)).toBe("1 KB/秒");
    expect(formatSpeed(2.5 * 1024 * 1024)).toBe("2.5 MB/秒");
  });
});

describe("formatEtaSeconds", () => {
  it("keeps the estimating label for null, undefined, negative and non-finite", () => {
    expect(formatEtaSeconds(null)).toBe("估算中");
    expect(formatEtaSeconds(undefined)).toBe("估算中");
    expect(formatEtaSeconds(-1)).toBe("估算中");
    expect(formatEtaSeconds(Number.NaN)).toBe("估算中");
  });

  it("uses 秒 / 分 / 小时 buckets with the original rounding", () => {
    expect(formatEtaSeconds(0)).toBe("约 0 秒");
    expect(formatEtaSeconds(59.2)).toBe("约 60 秒");
    expect(formatEtaSeconds(60)).toBe("约 1 分 0 秒");
    expect(formatEtaSeconds(90)).toBe("约 1 分 30 秒");
    expect(formatEtaSeconds(3600)).toBe("约 1 小时 0 分");
    expect(formatEtaSeconds(5400)).toBe("约 1 小时 30 分");
  });
});

describe("formatDuration", () => {
  it("clamps negative durations to zero", () => {
    expect(formatDuration(0)).toBe("0:00");
    expect(formatDuration(-500)).toBe("0:00");
    expect(formatDuration(-90_000)).toBe("0:00");
  });

  it("switches to h:mm:ss past one hour", () => {
    expect(formatDuration(1000)).toBe("0:01");
    expect(formatDuration(59_999)).toBe("1:00");
    expect(formatDuration(61_000)).toBe("1:01");
    expect(formatDuration(3_599_999)).toBe("1:00:00");
    expect(formatDuration(3_661_000)).toBe("1:01:01");
  });
});

describe("formatCount", () => {
  it("groups thousands with the zh-CN separator", () => {
    expect(formatCount(0)).toBe("0");
    expect(formatCount(999)).toBe("999");
    expect(formatCount(1234)).toBe("1,234");
    expect(formatCount(1_234_567)).toBe("1,234,567");
  });
});

describe("truncatePath", () => {
  it("shows an em dash for empty input", () => {
    expect(truncatePath(null)).toBe("—");
    expect(truncatePath(undefined)).toBe("—");
    expect(truncatePath("")).toBe("—");
  });

  it("keeps short paths untouched", () => {
    expect(truncatePath("D:\\DCIM\\100CANON")).toBe("D:\\DCIM\\100CANON");
    expect(truncatePath("abcde", 5)).toBe("abcde");
  });

  it("keeps the tail and spends one character on the ellipsis", () => {
    expect(truncatePath("abcdefghij", 5)).toBe("…ghij");
    expect(truncatePath("D:\\very\\deep\\folder\\IMG_0001.CR3", 10)).toBe("…_0001.CR3");
    const tail = truncatePath("x".repeat(200));
    expect(tail.startsWith("…")).toBe(true);
    expect(tail.length).toBe(48);
  });
});

describe("formatCaptureAt", () => {
  it("returns null for missing values", () => {
    expect(formatCaptureAt(null)).toBeNull();
    expect(formatCaptureAt("")).toBeNull();
  });

  it("passes non-timestamp strings through untouched", () => {
    expect(formatCaptureAt("2025-01-02T03:04:05Z")).toBe("2025-01-02T03:04:05Z");
    // Unparseable payload falls back to the raw value instead of "Invalid Date".
    expect(formatCaptureAt("unix-ms:not-a-number")).toBe("unix-ms:not-a-number");
  });

  it("localizes unix-ms timestamps across a year boundary", () => {
    const yearsAgo = Date.UTC(1999, 11, 31, 23, 59, 59);
    const newYear = Date.UTC(2000, 0, 1, 0, 0, 1);
    expect(formatCaptureAt(`unix-ms:${yearsAgo}`)).toBe(new Date(yearsAgo).toLocaleString("zh-CN"));
    expect(formatCaptureAt(`unix-ms:${newYear}`)).toBe(new Date(newYear).toLocaleString("zh-CN"));
    expect(formatCaptureAt(`unix-ms:${newYear}`)).not.toBe(formatCaptureAt(`unix-ms:${yearsAgo}`));
  });
});

describe("formatRangeLabel", () => {
  it("renders an empty label when neither bound is set", () => {
    expect(formatRangeLabel(undefined, undefined)).toBe("");
  });

  it("renders open-ended ranges", () => {
    expect(formatRangeLabel("2025-03-01", undefined)).toBe("自 2025-03-01");
    expect(formatRangeLabel(undefined, "2025-03-31")).toBe("至 2025-03-31");
  });

  it("keeps both bounds for ranges crossing a month or a year", () => {
    expect(formatRangeLabel("2025-01-31", "2025-02-01")).toBe("2025-01-31 ~ 2025-02-01");
    expect(formatRangeLabel("2024-12-30", "2025-01-02")).toBe("2024-12-30 ~ 2025-01-02");
    expect(formatRangeLabel("1999-12-31", "2000-01-01")).toBe("1999-12-31 ~ 2000-01-01");
  });
});
