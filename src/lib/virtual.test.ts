import { describe, expect, it } from "vitest";
import {
  buildDayBoxes,
  computeCardHeight,
  computeCardWidth,
  computeColumns,
  computeGeometry,
  planWindow,
  type DayCount,
  type GridGeometry,
} from "./virtual";

const geo: GridGeometry = {
  cols: 4,
  cardWidth: 200,
  cardHeight: 250,
  rowPitch: 271,
  rowGap: 21,
  headHeight: 30,
  groupGap: 35,
};

const dayCounts = (...counts: number[]): DayCount[] => counts.map((count, index) => ({ date: `2024-01-0${index + 1}`, count }));

describe("computeColumns", () => {
  it("matches repeat(auto-fill, minmax(tile-min, 1fr))", () => {
    // 1000 + 16 = 1016; 4 tracks need 4*220 + 3*16 = 928 ≤ 1000, 5 need 1180 > 1000.
    expect(computeColumns(1000, 220, 16)).toBe(4);
    expect(computeColumns(1180, 220, 16)).toBe(5);
    expect(computeColumns(927, 220, 16)).toBe(3);
    expect(computeColumns(220, 220, 16)).toBe(1);
  });

  it("degrades to a single column instead of throwing", () => {
    expect(computeColumns(0, 220, 16)).toBe(1);
    expect(computeColumns(-10, 220, 16)).toBe(1);
    expect(computeColumns(400, 0, 16)).toBe(1);
  });
});

describe("computeCardWidth / computeCardHeight", () => {
  it("splits the leftover space evenly", () => {
    expect(computeCardWidth(1000, 4, 16)).toBeCloseTo(238, 5);
    expect(computeCardWidth(1000, 1, 16)).toBe(1000);
    expect(computeCardWidth(-5, 4, 16)).toBe(0);
  });

  it("derives the row height from the tile width and the card aspect ratio", () => {
    // aspect-ratio: 1.17 → preview height = (width - borders) / 1.17, plus a fixed info block.
    expect(computeCardHeight(238, 1.17, 58)).toBeCloseTo(238 / 1.17 + 58, 1);
    expect(computeCardHeight(0, 1.17, 58)).toBe(58);
    // A bogus aspect must not produce Infinity/NaN.
    expect(computeCardHeight(238, 0, 58)).toBeCloseTo(238 / 1.17 + 58, 1);
  });

  it("removes the card borders before applying the aspect ratio", () => {
    // A 1.17 aspect is resolved against the content box, so the 1px borders on
    // each side must not be divided by 1.17 — that error compounds per row.
    expect(computeCardHeight(238, 1.17, 58, 2)).toBeCloseTo(236 / 1.17 + 58, 1);
    expect(computeCardHeight(238, 1.17, 58, 2)).toBeLessThan(computeCardHeight(238, 1.17, 58));
  });

  it("snaps to Chromium's 1/64 layout unit", () => {
    // 1fr tracks truncate: (1321.9375 - 4*16)/5 = 251.5875 → 251.578125.
    expect(computeCardWidth(1321.9375, 5, 16)).toBe(251.578125);
    const height = computeCardHeight(251.578125, 1.17, 59, 2);
    expect(height).toBe(272.3125);
    expect(Number.isInteger(height * 64)).toBe(true);
  });
});

describe("computeGeometry", () => {
  it("packs the derived numbers into a row pitch", () => {
    const result = computeGeometry({ containerWidth: 1000, tileMin: 220, columnGap: 16, rowGap: 21, chrome: 58, headHeight: 30, groupGap: 35 });
    expect(result.cols).toBe(4);
    expect(result.cardWidth).toBeCloseTo(238, 5);
    expect(result.rowPitch).toBeCloseTo(result.cardHeight + 21, 5);
  });
});

describe("buildDayBoxes", () => {
  it("stacks day groups with heading and group gap", () => {
    const { boxes, total } = buildDayBoxes(dayCounts(9, 4), geo);
    // 9 items over 4 columns = 3 rows; 4 items = 1 row.
    expect(boxes[0].rows).toBe(3);
    expect(boxes[0].height).toBe(30 + 3 * 271 - 21);
    expect(boxes[1].top).toBe(boxes[0].height + 35);
    expect(boxes[1].gridTop).toBe(boxes[1].top + 30);
    expect(boxes[1].firstIndex).toBe(9);
    expect(total).toBe(boxes[1].top + boxes[1].height + 35);
  });

  it("keeps firstIndex aligned with the flattened card order", () => {
    const { boxes } = buildDayBoxes(dayCounts(3, 5, 7), geo);
    expect(boxes.map((box) => box.firstIndex)).toEqual([0, 3, 8]);
  });

  it("returns an empty plan for no days", () => {
    expect(buildDayBoxes([], geo)).toEqual({ boxes: [], total: 0 });
  });
});

describe("planWindow", () => {
  const { boxes } = buildDayBoxes(dayCounts(40, 40, 40, 40), geo);
  // Each group: 30 + 10*271 - 21 = 2719 tall, + 35 margin = 2754 advance.

  it("renders nothing without data", () => {
    expect(planWindow([], geo, { top: 0, bottom: 800, overscan: 800 })).toEqual({ slices: [], padTop: 0, padBottom: 0, cardCount: 0 });
  });

  it("pushes the off-screen head into the top spacer", () => {
    const plan = planWindow(boxes, geo, { top: 5600, bottom: 6400, overscan: 0 });
    expect(plan.padTop).toBe(boxes[2].top);
    // Third group starts at 5508; the band starts 92px inside it.
    expect(plan.slices[0].box).toBe(2);
    expect(plan.slices[0].startRow).toBe(0);
  });

  it("mounts one viewport of overscan above and below", () => {
    const tight = planWindow(boxes, geo, { top: 5600, bottom: 6400, overscan: 0 });
    const loose = planWindow(boxes, geo, { top: 5600, bottom: 6400, overscan: 800 });
    expect(loose.cardCount).toBeGreaterThan(tight.cardCount);
    expect(loose.padTop).toBeLessThanOrEqual(tight.padTop);
  });

  it("keeps the rendered card count within 3× a viewport of rows", () => {
    const viewHeight = 900;
    const plan = planWindow(boxes, geo, { top: 3000, bottom: 3000 + viewHeight, overscan: viewHeight });
    const visibleRows = Math.ceil(viewHeight / geo.rowPitch);
    expect(plan.cardCount).toBeLessThanOrEqual(geo.cols * (visibleRows + 2 * visibleRows + 2));
  });

  it("clamps the window at both ends", () => {
    const atTop = planWindow(boxes, geo, { top: -500, bottom: 300, overscan: 0 });
    expect(atTop.padTop).toBe(0);
    expect(atTop.slices[0].startRow).toBe(0);
    const atEnd = planWindow(boxes, geo, { top: 1e6, bottom: 1e6 + 800, overscan: 0 });
    const lastBox = boxes[boxes.length - 1];
    expect(atEnd.slices[atEnd.slices.length - 1].box).toBe(boxes.length - 1);
    expect(atEnd.slices[atEnd.slices.length - 1].endRow).toBe(lastBox.rows - 1);
  });

  it("never renders more cards than the day holds", () => {
    const { boxes: small } = buildDayBoxes(dayCounts(2), geo);
    const plan = planWindow(small, geo, { top: 0, bottom: 4000, overscan: 4000 });
    expect(plan.cardCount).toBe(2);
    expect(plan.slices[0].count).toBe(2);
  });

  it("keeps spacers and slices consistent with the total height", () => {
    const plan = planWindow(boxes, geo, { top: 5600, bottom: 6400, overscan: 800 });
    const first = plan.slices[0];
    const last = plan.slices[plan.slices.length - 1];
    expect(plan.padTop).toBe(boxes[first.box].top);
    expect(plan.padBottom).toBe(boxes[last.box].top + boxes[last.box].height + geo.groupGap);
  });
});
