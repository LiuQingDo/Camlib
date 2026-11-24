import { describe, expect, it } from "vitest";
import { isTopOfStack, nextFocusIndex, nextInertDepth } from "./focus";

// 这里只测焦点陷阱的纯逻辑：仓库的 vitest 跑在 node 环境，没有 DOM 可操作。
describe("Tab 循环索引", () => {
  it("向后逐个推进，到末尾回到第一个", () => {
    expect(nextFocusIndex(0, 3, false)).toBe(1);
    expect(nextFocusIndex(1, 3, false)).toBe(2);
    expect(nextFocusIndex(2, 3, false)).toBe(0);
  });

  it("Shift+Tab 逐个回退，在第一个时回到最后一个", () => {
    expect(nextFocusIndex(2, 3, true)).toBe(1);
    expect(nextFocusIndex(0, 3, true)).toBe(2);
  });

  it("焦点不在容器内（-1）时，向后落在第一个，向前落在最后一个", () => {
    expect(nextFocusIndex(-1, 3, false)).toBe(0);
    expect(nextFocusIndex(-1, 3, true)).toBe(2);
  });

  it("只有一个可聚焦元素时原地打转（循环不塌陷）", () => {
    expect(nextFocusIndex(0, 1, false)).toBe(0);
    expect(nextFocusIndex(0, 1, true)).toBe(0);
  });

  it("没有可聚焦元素时返回 -1，交给容器兜底", () => {
    expect(nextFocusIndex(-1, 0, false)).toBe(-1);
    expect(nextFocusIndex(0, 0, true)).toBe(-1);
  });

  it("20 次 Tab 始终落在区间内（不逃逸）", () => {
    let index = -1;
    for (let step = 0; step < 20; step += 1) {
      index = nextFocusIndex(index, 4, false);
      expect(index).toBeGreaterThanOrEqual(0);
      expect(index).toBeLessThan(4);
    }
  });
});

describe("背景 inert 计数栈", () => {
  it("压一层就锁住，解开计数归零才解锁", () => {
    expect(nextInertDepth(0, true)).toBe(1);
    expect(nextInertDepth(1, false)).toBe(0);
  });

  it("嵌套弹窗：关掉一层不会误解锁，深 2 → 1 仍然锁着", () => {
    const afterPreview = nextInertDepth(0, true);
    const afterEditor = nextInertDepth(afterPreview, true);
    expect(afterEditor).toBe(2);

    const afterCloseEditor = nextInertDepth(afterEditor, false);
    expect(afterCloseEditor).toBe(1);
    expect(afterCloseEditor).toBeGreaterThan(0);

    expect(nextInertDepth(afterCloseEditor, false)).toBe(0);
  });

  it("多余的一次解开不会把计数压成负数", () => {
    expect(nextInertDepth(0, false)).toBe(0);
    expect(nextInertDepth(nextInertDepth(0, false), false)).toBe(0);
  });

  it("三层依次关闭，只有最后一次才解锁", () => {
    let depth = 0;
    for (let layer = 0; layer < 3; layer += 1) depth = nextInertDepth(depth, true);
    expect(depth).toBe(3);

    depth = nextInertDepth(depth, false);
    expect(depth).toBe(2);
    depth = nextInertDepth(depth, false);
    expect(depth).toBe(1);
    depth = nextInertDepth(depth, false);
    expect(depth).toBe(0);
  });
});

describe("焦点栈的栈顶判定", () => {
  it("只有最后压入的那一层能处理键盘", () => {
    const stack: string[] = [];
    stack.push("preview");
    expect(isTopOfStack(stack, "preview")).toBe(true);

    stack.push("editor");
    expect(isTopOfStack(stack, "editor")).toBe(true);
    expect(isTopOfStack(stack, "preview")).toBe(false);
  });

  it("关掉上层后，下层重新成为最上层", () => {
    const stack = ["preview", "editor"];
    stack.splice(stack.indexOf("editor"), 1);
    expect(isTopOfStack(stack, "preview")).toBe(true);
    expect(isTopOfStack(stack, "editor")).toBe(false);
  });

  it("空栈没有最上层", () => {
    expect(isTopOfStack<string>([], "preview")).toBe(false);
  });
});
