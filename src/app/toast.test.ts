import { describe, expect, it } from "vitest";
import { enqueueToastEntry, removeToastEntry, TOAST_LIMIT, type ToastEntry, type ToastQueue } from "./toast";

function entry(key: string): ToastEntry {
  return { key, kind: "success", message: `消息 ${key}`, timeout: 4000 };
}

const empty: ToastQueue = { visible: [], pending: [] };

describe("toast 队列", () => {
  it("屏上最多 3 条，第 4 条开始排队，不互相顶掉", () => {
    let queue = empty;
    for (const key of ["a", "b", "c", "d", "e"]) queue = enqueueToastEntry(queue, entry(key));

    expect(TOAST_LIMIT).toBe(3);
    expect(queue.visible.map((item) => item.key)).toEqual(["a", "b", "c"]);
    expect(queue.pending.map((item) => item.key)).toEqual(["d", "e"]);
  });

  it("同 key 合并：连续操作只留一条，且不改变它在队列里的位置", () => {
    let queue = enqueueToastEntry(empty, entry("a"));
    queue = enqueueToastEntry(queue, entry("b"));
    queue = enqueueToastEntry(queue, { ...entry("a"), message: "收藏 5 项" });

    expect(queue.visible.map((item) => item.key)).toEqual(["a", "b"]);
    expect(queue.visible[0].message).toBe("收藏 5 项");
  });

  it("移除一条后，排队中的队首自动递补", () => {
    let queue = empty;
    for (const key of ["a", "b", "c", "d"]) queue = enqueueToastEntry(queue, entry(key));

    queue = removeToastEntry(queue, "b");
    expect(queue.visible.map((item) => item.key)).toEqual(["a", "c", "d"]);
    expect(queue.pending).toHaveLength(0);
  });

  it("错误默认常驻（timeout 0 不会被移除路径影响）", () => {
    const sticky: ToastEntry = { key: "err", kind: "error", message: "删除失败", timeout: 0 };
    const queue = enqueueToastEntry(empty, sticky);
    expect(queue.visible[0].timeout).toBe(0);
  });
});
