import { beforeEach, describe, expect, it } from "vitest";
import { NOTICE_VISIBLE_LIMIT, dismissNotice, listNotices, pushNotice, resetNoticesForTest } from "./notices";

beforeEach(() => {
  resetNoticesForTest();
});

describe("通知注册表", () => {
  it("超过 3 条时只展示 3 条，其余计数为「还有 N 条」", () => {
    for (let index = 0; index < 5; index += 1) pushNotice({ kind: "info", title: `第 ${index} 条` });

    const { visible, hidden } = listNotices();
    expect(NOTICE_VISIBLE_LIMIT).toBe(3);
    expect(visible).toHaveLength(3);
    expect(hidden).toBe(2);
  });

  it("错误排在信息前面，同 kind 内保持「新的在前」", () => {
    pushNotice({ kind: "info", title: "最近任务" });
    pushNotice({ kind: "error", title: "索引损坏" });
    pushNotice({ kind: "warning", title: "媒体库已断开" });

    expect(listNotices().visible.map((notice) => notice.title)).toEqual(["索引损坏", "媒体库已断开", "最近任务"]);
  });

  it("同 id 原地更新，不会多出一条", () => {
    pushNotice({ id: "state-error", kind: "error", title: "读取失败" });
    pushNotice({ id: "state-error", kind: "error", title: "读取失败（可重试）" });

    const { visible, hidden } = listNotices();
    expect(visible).toHaveLength(1);
    expect(hidden).toBe(0);
    expect(visible[0].title).toBe("读取失败（可重试）");
  });

  it("关掉可见项后，原本被折叠的那条递补进前 3", () => {
    const ids = ["a", "b", "c", "d"].map((title) => pushNotice({ kind: "info", title }));
    dismissNotice(ids[1]);

    const { visible, hidden } = listNotices();
    expect(visible.map((notice) => notice.title)).toEqual(["d", "c", "a"]);
    expect(hidden).toBe(0);
  });
});
