import { describe, expect, it } from "vitest";
import {
  activeFilterParts,
  extensionsToInput,
  formatDatePrefix,
  hasAnyFilter,
  hasNonSearchFilter,
  panelFilterCount,
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
    tags: [],
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

describe("formatDatePrefix", () => {
  it("renders year / month / day prefixes as Chinese labels", () => {
    expect(formatDatePrefix("2025")).toBe("2025 年");
    expect(formatDatePrefix("2025-03")).toBe("2025 年 3 月");
    expect(formatDatePrefix("2025-03-05")).toBe("2025 年 3 月 5 日");
    expect(formatDatePrefix("")).toBe("");
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
    expect(secondaryFilterParts(crossYear)).toEqual([
      { key: "date", label: "日期：2024-12-30 ~ 2025-01-02", value: "2024-12-30..2025-01-02" },
    ]);
  });
});

describe("secondaryFilterParts", () => {
  it("is empty when no secondary filter is set", () => {
    expect(secondaryFilterParts(baseState())).toEqual([]);
  });

  it("emits removable chips in the fixed order: 类型 → 收藏 → 连拍 → 标签 → 日期 → 评分 → AI", () => {
    const chips = secondaryFilterParts(
      baseState({
        kind: "video",
        favoriteOnly: true,
        burstOnly: true,
        tagIds: new Set(["t1", "t2"]),
        tags: [
          { id: "t2", name: "日落" },
          { id: "t1", name: "海边" },
        ],
        dateFrom: "2025-01-01",
        dateTo: "2025-01-31",
        ratingMin: 3,
        semanticSearch: "海浪",
      }),
    );
    expect(chips.map((chip) => chip.key)).toEqual([
      "kind",
      "favorite",
      "burst",
      "tag",
      "tag",
      "date",
      "rating",
      "semantic",
    ]);
    expect(chips.map((chip) => chip.label)).toEqual([
      "视频",
      "收藏",
      "连拍",
      "海边",
      "日落",
      "日期：2025-01-01 ~ 2025-01-31",
      "评分 ≥ 3 星",
      "AI：海浪",
    ]);
  });

  it("carries a removable value for every chip", () => {
    const [kind] = secondaryFilterParts(baseState({ kind: "photo" }));
    expect(kind).toEqual({ key: "kind", label: "照片", value: "photo" });
    const tag = secondaryFilterParts(baseState({ tagIds: new Set(["t1"]), tags: [{ id: "t1", name: "海边" }] }))[0];
    expect(tag).toEqual({ key: "tag", label: "海边", value: "t1" });
    const semantic = secondaryFilterParts(baseState({ semanticSearch: "湖边的黄昏" }))[0];
    expect(semantic).toEqual({ key: "semantic", label: "AI：湖边的黄昏", value: "湖边的黄昏" });
  });

  it("reports rating 0 as 未评分 and keeps ≥N distinct from it", () => {
    expect(secondaryFilterParts(baseState({ ratingEq: 0 }))).toEqual([
      { key: "rating", label: "未评分", value: "unrated" },
    ]);
    expect(secondaryFilterParts(baseState({ ratingMin: 4 }))).toEqual([
      { key: "rating", label: "评分 ≥ 4 星", value: "min:4" },
    ]);
  });

  it("labels a date prefix as 日期 and encodes an open-ended range", () => {
    expect(secondaryFilterParts(baseState({ datePrefix: "2025-03" }))).toEqual([
      { key: "date", label: "日期：2025 年 3 月", value: "2025-03" },
    ]);
    expect(secondaryFilterParts(baseState({ dateFrom: "2025-01-01" }))).toEqual([
      { key: "date", label: "日期：2025-01-01 ~ 最新", value: "2025-01-01.." },
    ]);
    expect(secondaryFilterParts(baseState({ dateTo: "2025-01-31" }))).toEqual([
      { key: "date", label: "日期：最早 ~ 2025-01-31", value: "..2025-01-31" },
    ]);
  });

  it("falls back to the tag id when the tag list no longer knows it", () => {
    expect(secondaryFilterParts(baseState({ tagIds: new Set(["gone"]) }))).toEqual([
      { key: "tag", label: "gone", value: "gone" },
    ]);
  });

  it("keeps the search term out (it lives in the top bar) and does not duplicate 新导入", () => {
    expect(secondaryFilterParts(baseState({ search: "x" }))).toEqual([]);
    expect(secondaryFilterParts(baseState({ firstSeenFrom: "2025-01-01" }))).toEqual([]);
  });

  it("counts exactly what the 筛选 (n) badge should show", () => {
    const combo = baseState({
      kind: "video",
      favoriteOnly: true,
      tagIds: new Set(["a", "b"]),
      ratingMin: 3,
    });
    // 类型 + 收藏 + 两个标签 + 评分 = 5 项，与 chips 数量一致。
    expect(secondaryFilterParts(combo)).toHaveLength(5);
    expect(hasAnyFilter(combo)).toBe(true);
    // 徽标只数面板内条件（标签 2 + 评分 1），不重复计主行已有的类型/收藏。
    expect(panelFilterCount(combo)).toBe(3);
  });
});

describe("panelFilterCount", () => {
  it("is zero for a clean query and ignores the primary row", () => {
    expect(panelFilterCount(baseState())).toBe(0);
    expect(panelFilterCount(baseState({ kind: "photo", favoriteOnly: true, burstOnly: true }))).toBe(0);
    expect(panelFilterCount(baseState({ search: "海边" }))).toBe(0);
  });

  it("counts tags individually and each other panel group once", () => {
    expect(panelFilterCount(baseState({ tagIds: new Set(["a", "b", "c"]) }))).toBe(3);
    expect(panelFilterCount(baseState({ datePrefix: "2025-03" }))).toBe(1);
    expect(panelFilterCount(baseState({ dateFrom: "2025-01-01", dateTo: "2025-02-01" }))).toBe(1);
    expect(panelFilterCount(baseState({ ratingEq: 0 }))).toBe(1);
    expect(panelFilterCount(baseState({ ratingMin: 4 }))).toBe(1);
    expect(panelFilterCount(baseState({ semanticSearch: "湖边" }))).toBe(1);
    expect(
      panelFilterCount(
        baseState({ tagIds: new Set(["a"]), ratingMin: 3, semanticSearch: "湖边", dateTo: "2025-01-31" }),
      ),
    ).toBe(4);
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
