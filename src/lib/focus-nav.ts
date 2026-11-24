/**
 * 网格 roving 焦点的纯逻辑（无 DOM，可直接单测）。
 *
 * 键盘选择模型里最容易写错的两件事——「按方向键该落到第几张」和「整个网格只有
 * 一个 Tab 停靠点」——都抽在这里；虚拟滚动的 DOM 部分只负责把结果套到节点上。
 */

export type GridArrow = "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown";

const GRID_ARROWS: ReadonlySet<string> = new Set<GridArrow>(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]);

export function isGridArrow(key: string): key is GridArrow {
  return GRID_ARROWS.has(key);
}

/**
 * 方向键落点。
 *
 * 左右是 ±1：CSS grid 逐行铺开，一维下标顺序就是视觉顺序。上下是 ±cols。
 * 越界停在原地而不是回绕——从最后一行按 ↓ 跳回第一行会让人彻底失去方位感；
 * 跨天分组时同理，跨越分组靠继续按 ↓ 一屏屏走。
 */
export function nextGridIndex(current: number, key: GridArrow, cols: number, count: number): number {
  if (count <= 0) return -1;
  const start = current < 0 ? 0 : Math.min(current, count - 1);
  const step = Math.max(1, Math.floor(cols) || 1);
  if (key === "ArrowLeft") return Math.max(0, start - 1);
  if (key === "ArrowRight") return Math.min(count - 1, start + 1);
  if (key === "ArrowUp") return start - step >= 0 ? start - step : start;
  return start + step < count ? start + step : start;
}

/**
 * 唯一的 Tab 停靠点。
 *
 * `focusIndex` 为空（还没用键盘进过网格）或越界（结果集换了、被删了）时退回第一张：
 * 否则整屏卡片全是 `tabindex="-1"`，Tab 键根本进不来。
 */
export function tabStopIndex(focusIndex: number | null, count: number): number {
  if (count <= 0) return -1;
  if (focusIndex === null || !Number.isInteger(focusIndex) || focusIndex < 0 || focusIndex >= count) return 0;
  return focusIndex;
}
