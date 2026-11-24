import { isGridArrow, nextGridIndex } from "../lib/focus-nav";
import { collectRangeIds } from "../lib/selection";
import { computeColumns } from "../lib/virtual";
import { app, region } from "../render/context";
import { applyGridRoving } from "../render/grid";
import { applySelectionChrome } from "../render/toolbar";
import { gridGeo, scheduleGridPaint } from "../render/virtual";
import { state } from "../state";
import { openMediaCard, toggleSelection } from "./bindings/toolbar";
import { displayItems } from "./media-order";

/**
 * 网格键盘选择模型：roving 焦点、Space 选中、Shift+方向键扩选、Enter 开预览。
 *
 * 这里只做「下标 → 卡片节点」的定位与焦点搬运；行的几何、挂载与回收仍然全部
 * 归 render/virtual（本文件只读 gridGeo，不改任何滚动算法）。
 */

/** 列数：几何算过就用它，没算过按 CSS 的 auto-fill 语义现推一次。 */
function gridColumns(): number {
  if (gridGeo && gridGeo.cols > 0) return gridGeo.cols;
  const area = region("media");
  const width = area ? area.getBoundingClientRect().width : 0;
  const tileMin = Number.parseFloat(getComputedStyle(app).getPropertyValue("--tile-min")) || 220;
  return computeColumns(width, tileMin, 16);
}

function cardAt(index: number): HTMLElement | null {
  return app.querySelector<HTMLElement>(`.media-card[data-index="${index}"]`);
}

/**
 * 把焦点搬到第 index 张卡。先把 roving 停靠点改过去，再滚到「最近」的位置——
 * `block:"nearest"` 保证已经在视口里的卡片不会突然把整页顶走。
 */
export function focusGridCard(index: number): void {
  const items = displayItems();
  if (!items.length) return;
  const target = Math.min(Math.max(index, 0), items.length - 1);
  state.focusIndex = target;
  applyGridRoving();
  const card = cardAt(target);
  if (!card) {
    // 目标行还没被虚拟滚动挂上（连按方向键越过了 overscan 边界）：先把滚动容器
    // 往目标方向推近一屏，排一帧让窗口重排，下一帧再把焦点补上。
    const mounted = app.querySelectorAll<HTMLElement>(".media-card");
    const lastIndex = Number(mounted[mounted.length - 1]?.dataset.index ?? 0);
    const scroller = app.querySelector<HTMLElement>(".content");
    scroller?.scrollBy({ top: (target > lastIndex ? 1 : -1) * scroller.clientHeight * 0.8 });
    scheduleGridPaint();
    requestAnimationFrame(() => {
      const late = cardAt(target);
      if (!late || state.focusIndex !== target) return;
      late.scrollIntoView({ block: "nearest" });
      late.focus({ preventScroll: true });
    });
    return;
  }
  card.scrollIntoView({ block: "nearest" });
  card.focus({ preventScroll: true });
}

/** Shift+方向键：从锚点补到新位置。只加不减——回缩靠再点一次卡片。 */
export function extendSelectionTo(index: number): void {
  const anchor = state.lastSelectIndex ?? index;
  for (const id of collectRangeIds(displayItems(), anchor, index)) state.selectedIds.add(id);
  state.lastSelectIndex = anchor;
  applySelectionChrome();
}

/**
 * 卡片上的 keydown。只处理落在卡片本身的事件：卡内两个按钮仍是原生按钮，
 * Enter/Space 该激活它们自己，而不是顺带打开预览。
 */
export function handleGridKeydown(event: KeyboardEvent): void {
  if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
  const target = event.target instanceof Element ? event.target : null;
  const card = target?.closest<HTMLElement>(".media-card") ?? null;
  if (!card || target !== card) return;
  const index = Number(card.dataset.index);
  if (!Number.isInteger(index) || index < 0) return;
  state.focusIndex = index;
  if (event.key === " " || event.key === "Spacebar") {
    // 默认行为是滚动一屏——在网格里按 Space 想选中的时候，页面先跳走最难忍。
    event.preventDefault();
    const id = card.dataset.id;
    if (id) toggleSelection(id, index, false);
    return;
  }
  if (event.key === "Enter") {
    event.preventDefault();
    openMediaCard(card);
    return;
  }
  if (!isGridArrow(event.key)) return;
  event.preventDefault();
  const next = nextGridIndex(index, event.key, gridColumns(), displayItems().length);
  if (next < 0) return;
  if (event.shiftKey) extendSelectionTo(next);
  if (next !== index) focusGridCard(next);
}

/**
 * 鼠标点卡：把 roving 落点搬到这张卡上。
 *
 * 不做这一步的话，点完第 20 张再按 → 会从「上一次键盘停留的第 1 张」跳走。
 * 只更新属性、不碰焦点，点击本身的默认行为（聚焦 / 开预览）不受影响。
 */
export function handleGridPointerDown(event: Event): void {
  const target = event.target instanceof Element ? event.target : null;
  const card = target?.closest<HTMLElement>(".media-card");
  if (!card) return;
  const index = Number(card.dataset.index);
  if (!Number.isInteger(index) || index < 0 || state.focusIndex === index) return;
  state.focusIndex = index;
  applyGridRoving();
}

/**
 * 滚动把停靠点那张卡回收掉之后补一个回来。
 *
 * 每帧只在「当前没有 tabindex=0 的卡片」时动 DOM，正常滚动是一次查询就返回。
 */
export function syncGridTabStopIfNeeded(): void {
  const stop = app.querySelector<HTMLElement>('.media-card[tabindex="0"]');
  if (stop) return;
  applyGridRoving();
}
