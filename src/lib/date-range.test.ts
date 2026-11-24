import { describe, expect, it } from "vitest";
import { matchDatePreset, presetRange } from "./date-range";

/** 2026-11-24 是周二（本地时区）。 */
const today = new Date(2026, 10, 24);

describe("presetRange", () => {
  it("starts the week on Monday", () => {
    expect(presetRange("week", today)).toEqual({ from: "2026-11-23", to: "2026-11-24" });
    // 周日属于上一周：2026-11-29 是周日。
    expect(presetRange("week", new Date(2026, 10, 29))).toEqual({ from: "2026-11-23", to: "2026-11-29" });
    // 周一本周从自己开始。
    expect(presetRange("week", new Date(2026, 10, 23))).toEqual({ from: "2026-11-23", to: "2026-11-23" });
  });

  it("runs from the first of the month / year to today", () => {
    expect(presetRange("month", today)).toEqual({ from: "2026-11-01", to: "2026-11-24" });
    expect(presetRange("year", today)).toEqual({ from: "2026-01-01", to: "2026-11-24" });
  });

  it("covers the whole previous month, including a year boundary", () => {
    expect(presetRange("last-month", today)).toEqual({ from: "2026-10-01", to: "2026-10-31" });
    expect(presetRange("last-month", new Date(2026, 0, 15))).toEqual({ from: "2025-12-01", to: "2025-12-31" });
    // 闰年二月。
    expect(presetRange("last-month", new Date(2024, 2, 10))).toEqual({ from: "2024-02-01", to: "2024-02-29" });
  });

  it("returns null for clear and unknown ids", () => {
    expect(presetRange("clear", today)).toBeNull();
    expect(presetRange("days30" as never, today)).toBeNull();
  });
});

describe("matchDatePreset", () => {
  it("recognizes the range a preset would produce", () => {
    expect(matchDatePreset("2026-11-23", "2026-11-24", today)).toBe("week");
    expect(matchDatePreset("2026-11-01", "2026-11-24", today)).toBe("month");
    expect(matchDatePreset("2026-10-01", "2026-10-31", today)).toBe("last-month");
    expect(matchDatePreset("2026-01-01", "2026-11-24", today)).toBe("year");
  });

  it("returns null when nothing (or a custom range) is set", () => {
    expect(matchDatePreset(undefined, undefined, today)).toBeNull();
    expect(matchDatePreset("2026-11-02", "2026-11-03", today)).toBeNull();
  });
});
