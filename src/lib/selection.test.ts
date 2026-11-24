import { describe, expect, it } from "vitest";
import { collectRangeIds, rangeIndices } from "./selection";

const items = ["a", "b", "c", "d", "e"].map((id) => ({ id }));

describe("rangeIndices", () => {
  it("normalizes the direction of the drag", () => {
    expect(rangeIndices(1, 3)).toEqual([1, 2, 3]);
    expect(rangeIndices(3, 1)).toEqual([1, 2, 3]);
  });

  it("keeps a single row when both ends match", () => {
    expect(rangeIndices(2, 2)).toEqual([2]);
    expect(rangeIndices(0, 0)).toEqual([0]);
  });

  it("includes negative indices so the caller's guard decides what exists", () => {
    expect(rangeIndices(-1, 1)).toEqual([-1, 0, 1]);
    expect(rangeIndices(-3, -3)).toEqual([-3]);
  });

  it("spans a month/year-sized list without gaps", () => {
    const yearEnd = rangeIndices(0, 364);
    expect(yearEnd.length).toBe(365);
    expect(yearEnd[0]).toBe(0);
    expect(yearEnd[364]).toBe(364);
  });
});

describe("collectRangeIds", () => {
  it("collects the inclusive slice of ids", () => {
    expect(collectRangeIds(items, 1, 3)).toEqual(["b", "c", "d"]);
    expect(collectRangeIds(items, 3, 1)).toEqual(["b", "c", "d"]);
  });

  it("returns one id when the range collapses", () => {
    expect(collectRangeIds(items, 4, 4)).toEqual(["e"]);
  });

  it("skips out-of-page rows instead of yielding undefined", () => {
    expect(collectRangeIds(items, 3, 99)).toEqual(["d", "e"]);
    expect(collectRangeIds(items, -2, 1)).toEqual(["a", "b"]);
    expect(collectRangeIds(items, 10, 12)).toEqual([]);
  });

  it("handles an empty page", () => {
    expect(collectRangeIds([], 0, 0)).toEqual([]);
  });

  it("follows the display order it is given, not the query order", () => {
    // 按天分组会重排（同一天的项目聚在一起），范围只能按传进来的这份顺序取：
    // 网格层传 gridItems，鼠标与键盘因此落在同一批卡片上。
    const display = ["day1-a", "day1-b", "day2-c", "day1-d"].map((id) => ({ id }));
    expect(collectRangeIds(display, 0, 2)).toEqual(["day1-a", "day1-b", "day2-c"]);
  });
});
