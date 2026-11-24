import { describe, expect, it } from "vitest";
import { isGridArrow, nextGridIndex, tabStopIndex } from "./focus-nav";

describe("isGridArrow", () => {
  it("accepts the four arrow keys only", () => {
    for (const key of ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]) expect(isGridArrow(key)).toBe(true);
    for (const key of ["Enter", " ", "a", "Tab", "Home"]) expect(isGridArrow(key)).toBe(false);
  });
});

describe("nextGridIndex", () => {
  it("moves one cell left and right", () => {
    expect(nextGridIndex(5, "ArrowLeft", 4, 10)).toBe(4);
    expect(nextGridIndex(5, "ArrowRight", 4, 10)).toBe(6);
  });

  it("moves a whole row up and down", () => {
    expect(nextGridIndex(6, "ArrowUp", 4, 20)).toBe(2);
    expect(nextGridIndex(6, "ArrowDown", 4, 20)).toBe(10);
  });

  it("stops at the edges instead of wrapping around", () => {
    expect(nextGridIndex(0, "ArrowLeft", 4, 10)).toBe(0);
    expect(nextGridIndex(9, "ArrowRight", 4, 10)).toBe(9);
    expect(nextGridIndex(1, "ArrowUp", 4, 10)).toBe(1);
    // 最后一行不满时也不能跳到不存在的下标。
    expect(nextGridIndex(8, "ArrowDown", 4, 10)).toBe(8);
  });

  it("clamps a stale focus index into range", () => {
    expect(nextGridIndex(-3, "ArrowRight", 4, 10)).toBe(1);
    expect(nextGridIndex(99, "ArrowLeft", 4, 10)).toBe(8);
  });

  it("returns -1 for an empty grid", () => {
    expect(nextGridIndex(0, "ArrowRight", 4, 0)).toBe(-1);
  });

  it("survives a zero column count", () => {
    expect(nextGridIndex(3, "ArrowDown", 0, 10)).toBe(4);
  });
});

describe("tabStopIndex", () => {
  it("falls back to the first card before any keyboard focus", () => {
    expect(tabStopIndex(null, 100)).toBe(0);
  });

  it("keeps the roving index while it is in range", () => {
    expect(tabStopIndex(7, 100)).toBe(7);
  });

  it("falls back when the index outlives the result set", () => {
    expect(tabStopIndex(7, 5)).toBe(0);
    expect(tabStopIndex(-1, 5)).toBe(0);
    expect(tabStopIndex(1.5, 5)).toBe(0);
  });

  it("returns -1 when there is nothing to focus", () => {
    expect(tabStopIndex(null, 0)).toBe(-1);
  });
});
