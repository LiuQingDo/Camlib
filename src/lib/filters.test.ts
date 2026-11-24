import { describe, expect, it } from "vitest";
import {
  activeFilterParts,
  extensionsToInput,
  hasAnyFilter,
  hasNonSearchFilter,
  parseExtensionsInput,
  secondaryFilterParts,
  type FilterState,
} from "./filters";

/** Neutral state: every filter is cleared. */
function baseState(overrides: Partial<FilterState> = {}): FilterState {
  return {
    search: "",
    kind: undefined,
    favoriteOnly: false,
    burstOnly: false,
    datePrefix: undefined,
    dateFrom: undefined,
    dateTo: undefined,
    firstSeenFrom: null,
    tagIds: new Set<string>(),
    ratingEq: null,
    ratingMin: null,
    semanticSearch: null,
    ...overrides,
  };
}

describe("parseExtensionsInput", () => {
  it("trims, lowercases and dots the messy input users actually type", () => {
    expect(parseExtensionsInput(".DNG, lrv ,")).toEqual([".dng", ".lrv"]);
    expect(parseExtensionsInput("JPG,.PNG,  .gif")).toEqual([".jpg", ".png", ".gif"]);
    expect(parseExtensionsInput("cr3")).toEqual([".cr3"]);
  });

  it("returns an empty list for blank input", () => {
    expect(parseExtensionsInput("")).toEqual([]);
    expect(parseExtensionsInput("   ")).toEqual([]);
    expect(parseExtensionsInput(" , ,, ")).toEqual([]);
    expect(parseExtensionsInput(",")).toEqual([]);
  });

  it("round-trips through extensionsToInput", () => {
    const parsed = parseExtensionsInput(".DNG, lrv ,");
    expect(parsed).toEqual([".dng", ".lrv"]);
    expect(extensionsToInput(parsed)).toBe(".dng, .lrv");
    expect(parseExtensionsInput(extensionsToInput(parsed))).toEqual(parsed);
  });
});

describe("extensionsToInput", () => {
  it("joins with a comma and a space, and yields an empty string when empty", () => {
    expect(extensionsToInput([])).toBe("");
    expect(extensionsToInput([".dng"])).toBe(".dng");
    expect(extensionsToInput([".dng", ".lrv", ".mov"])).toBe(".dng, .lrv, .mov");
  });
});

describe("hasAnyFilter", () => {
  it("is false only when nothing narrows the result set", () => {
    expect(hasAnyFilter(baseState())).toBe(false);
  });

  it("detects every single primary filter", () => {
    expect(hasAnyFilter(baseState({ search: "IMG" }))).toBe(true);
    expect(hasAnyFilter(baseState({ kind: "video" }))).toBe(true);
    expect(hasAnyFilter(baseState({ favoriteOnly: true }))).toBe(true);
    expect(hasAnyFilter(baseState({ burstOnly: true }))).toBe(true);
    expect(hasAnyFilter(baseState({ datePrefix: "2025-03" }))).toBe(true);
    expect(hasAnyFilter(baseState({ firstSeenFrom: "2025-03-01" }))).toBe(true);
    expect(hasAnyFilter(baseState({ semanticSearch: "海边的日落" }))).toBe(true);
  });

  it("treats rating 0 (unrated only) as an active filter", () => {
    expect(hasAnyFilter(baseState({ ratingEq: 0 }))).toBe(true);
    expect(hasAnyFilter(baseState({ ratingMin: 0 }))).toBe(true);
  });

  it("counts selected tags and open-ended date ranges", () => {
    expect(hasAnyFilter(baseState({ tagIds: new Set(["t1"]) }))).toBe(true);
    expect(hasAnyFilter(baseState({ dateFrom: "2025-01-31" }))).toBe(true);
    expect(hasAnyFilter(baseState({ dateTo: "2025-02-01" }))).toBe(true);
  });

  it("accepts a date range spanning a year boundary", () => {
    const crossYear = baseState({ dateFrom: "2024-12-30", dateTo: "2025-01-02" });
    expect(hasAnyFilter(crossYear)).toBe(true);
    expect(secondaryFilterParts(crossYear)).toEqual(["日期"]);
  });
});

describe("secondaryFilterParts", () => {
  it("is empty when no secondary filter is set", () => {
    expect(secondaryFilterParts(baseState())).toEqual([]);
  });

  it("labels each condition, in the toolbar's order", () => {
    const all = secondaryFilterParts(
      baseState({
        semanticSearch: "海浪",
        tagIds: new Set(["a", "b"]),
        dateFrom: "2024-12-30",
        dateTo: "2025-01-02",
        firstSeenFrom: "2025-01-01",
        ratingMin: 3,
      }),
    );
    expect(all).toEqual(["AI 搜索", "标签×2", "日期", "新导入", "评分"]);
  });

  it("reports rating 0 as a rating filter and counts tags exactly", () => {
    expect(secondaryFilterParts(baseState({ ratingEq: 0 }))).toEqual(["评分"]);
    expect(secondaryFilterParts(baseState({ tagIds: new Set(["a"]) }))).toEqual(["标签×1"]);
  });

  it("lists 收藏 / 连拍 so the 筛选 count matches the real query", () => {
    expect(secondaryFilterParts(baseState({ favoriteOnly: true }))).toEqual(["收藏"]);
    expect(secondaryFilterParts(baseState({ burstOnly: true }))).toEqual(["连拍"]);
    expect(secondaryFilterParts(baseState({ favoriteOnly: true, burstOnly: true }))).toEqual(["收藏", "连拍"]);
  });

  it("reads as an AND combination with the primary kind filter", () => {
    const combo = baseState({
      kind: "video",
      favoriteOnly: true,
      tagIds: new Set(["a", "b"]),
      ratingMin: 3,
    });
    const parts = secondaryFilterParts(combo);
    expect(parts).toEqual(["收藏", "标签×2", "评分"]);
    expect(parts).toHaveLength(3);
    expect(hasAnyFilter(combo)).toBe(true);
    // kind 由主行的类型 chip 表达，不重复计入「筛选 (n)」。
    expect(parts).not.toContain("视频");
  });

  it("keeps search and kind out of the collapsible-panel summary", () => {
    expect(secondaryFilterParts(baseState({ search: "x", kind: "photo" }))).toEqual([]);
  });
});

describe("hasNonSearchFilter", () => {
  it("is false for a bare search term", () => {
    expect(hasNonSearchFilter(baseState({ search: "海边" }))).toBe(false);
    expect(hasNonSearchFilter(baseState())).toBe(false);
  });

  it("is true as soon as any filter stacks on the search term", () => {
    expect(hasNonSearchFilter(baseState({ kind: "photo" }))).toBe(true);
    expect(hasNonSearchFilter(baseState({ search: "x", tagIds: new Set(["t1"]) }))).toBe(true);
    expect(hasNonSearchFilter(baseState({ search: "x", favoriteOnly: true }))).toBe(true);
    expect(hasNonSearchFilter(baseState({ search: "x", ratingEq: 0 }))).toBe(true);
    expect(hasNonSearchFilter(baseState({ search: "x", dateTo: "2026-01-01" }))).toBe(true);
  });
});

describe("activeFilterParts", () => {
  it("lists nothing when the query is unfiltered", () => {
    expect(activeFilterParts(baseState())).toEqual([]);
  });

  it("prints the search term and every stacked filter", () => {
    const parts = activeFilterParts(
      baseState({
        search: "海边",
        kind: "video",
        favoriteOnly: true,
        burstOnly: true,
        tagIds: new Set(["a", "b"]),
        dateFrom: "2025-01-01",
        dateTo: "2025-12-31",
        ratingMin: 3,
      }),
    );
    expect(parts).toEqual([
      "搜索「海边」",
      "类型：视频",
      "仅收藏",
      "仅连拍",
      "标签 2 个",
      "日期：2025-01-01 ~ 2025-12-31",
      "评分 ≥ 3 星",
    ]);
  });

  it("names the semantic query and an open-ended date range", () => {
    expect(activeFilterParts(baseState({ semanticSearch: "海边的日落" }))).toEqual(["AI 搜索「海边的日落」"]);
    expect(activeFilterParts(baseState({ datePrefix: "2025-03" }))).toEqual(["日期：2025-03"]);
    expect(activeFilterParts(baseState({ dateFrom: "2025-01-01" }))).toEqual(["日期：2025-01-01 ~ 最新"]);
  });

  it("reads rating 0 as unrated-only and keeps exact rating over the minimum", () => {
    expect(activeFilterParts(baseState({ ratingEq: 0 }))).toEqual(["未评分"]);
    expect(activeFilterParts(baseState({ ratingEq: 4, ratingMin: 3 }))).toEqual(["评分 4 星"]);
  });
});
