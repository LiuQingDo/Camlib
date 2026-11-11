import { describe, expect, it } from "vitest";
import { groupItemsByDay, UNKNOWN_DAY } from "./grid";

const item = (id: string, captureDate: string | null) => ({ id, captureDate });

describe("groupItemsByDay", () => {
  it("returns no groups for an empty page", () => {
    expect(groupItemsByDay([])).toEqual([]);
  });

  it("keeps rows of the same day together and in input order", () => {
    const groups = groupItemsByDay([
      item("a", "2024-05-02"),
      item("b", "2024-05-02"),
      item("c", "2024-05-01"),
    ]);
    expect(groups.map((group) => group.date)).toEqual(["2024-05-02", "2024-05-01"]);
    expect(groups[0]!.items.map((entry) => entry.id)).toEqual(["a", "b"]);
    expect(groups[1]!.items.map((entry) => entry.id)).toEqual(["c"]);
  });

  it("buckets missing capture dates under the unknown key", () => {
    const groups = groupItemsByDay([item("a", null), item("b", null)]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.date).toBe(UNKNOWN_DAY);
    expect(groups[0]!.items).toHaveLength(2);
  });

  it("reuses the bucket when a later page revisits an already-grouped day", () => {
    // load-more appends rows; a day may appear again further down the list.
    const groups = groupItemsByDay([
      item("a", "2024-05-02"),
      item("b", "2024-05-01"),
      item("c", "2024-05-02"),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0]!.items.map((entry) => entry.id)).toEqual(["a", "c"]);
  });

  it("does not mutate the input array", () => {
    const rows = [item("a", "2024-05-02"), item("b", "2024-05-01")];
    const snapshot = rows.slice();
    groupItemsByDay(rows);
    expect(rows).toEqual(snapshot);
  });
});
