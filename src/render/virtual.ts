// 由 main.ts 拆分而来：仅做搬移，未改动逻辑。
import { MediaItemDto } from "../api/media";
import { groupItemsByDay } from "../lib/grid";
import {
  CARD_ASPECT_RATIO,
  DayBox,
  FALLBACK_COLUMN_GAP,
  FALLBACK_ROW_GAP,
  GridGeometry,
  buildDayBoxes,
  computeColumns,
  computeGeometry,
  planWindow,
} from "../lib/virtual";
import { state } from "../state";
import { renderLibraryEmpty } from "../views/dialogs";
import { GRID_REGION, app, region, regionHtmlCache, setRegionHtml } from "./context";
import {
  createDayGroup,
  observePreviews,
  patchCardList,
  patchDayGroupHeader,
  releaseCardNode,
  renderCard,
} from "./grid";
import { bindEmptyStateEvents, loadMoreScrollRoot, updateLoadMoreFooter } from "./paint";

/**
 * 网格区 reconcile。分区结构：.media-day-group[data-day] > .media-grid > .media-card[data-id]。
 * 分组按天 keyed 复用，卡片按 id keyed 复用——筛选变化时留住的卡片连 <img> 都不换。
 *
 * 窗口化之后这里只负责「结果集变了」这一段：把 items 扁平化成展示顺序、重建行盒，
 * 然后交给 paintGridWindow 按当前滚动位置挂载可视行。
 */
export function patchGrid(): void {
  const area = region("media");
  if (!area) return;
  app.style.setProperty("--tile-min", `${[150, 185, 220, 260, 310][state.density - 1]}px`);
  const items = state.page.items;
  if (!items.length) {
    gridBoxes = [];
    gridItems = [];
    gridSignature = "";
    if (setRegionHtml(area, renderLibraryEmpty())) bindEmptyStateEvents();
    return;
  }
  // 从空态切回网格：清掉占位节点，缓存标记成永不命中的网格态。
  area.querySelector(":scope > .empty-state")?.remove();
  regionHtmlCache.set(area, GRID_REGION);

  // 先落哨兵：底部 spacer 要插在它前面，滚动加载的观察目标才不会被推走。
  updateLoadMoreFooter();
  watchGridResize(area);
  paintGridWindow();
}

// ---------------------------------------------------------------------------
// 固定行高虚拟滚动
//
// 行高是可推导的：列数只由容器宽度与 --tile-min 决定（auto-fill 的语义），每列
// 宽度再把剩余空间均分；卡片高度 = 预览区（固定宽高比）× 列宽 + 与宽度无关的
// 信息区。于是「第 N 行在哪」是纯算术，DOM 里只需要留下可视区 ±1 屏的行，上下
// 各用一个 spacer 撑出总高度。
//
// 天分组标题会被一并算进盒子里，所以渲染出来的分组位置与未窗口化时逐像素一致：
// 分组高度显式写成盒子高度，第一/最后一个分组只挂载落在窗口内的行，缺的行由分组
// 内的 .grid-row-offset 占位格补上。
// ---------------------------------------------------------------------------

/** 探测元素量不到时的兜底：卡片信息区（上下内边距 + 标题 + 元信息行 + 边框）。 */
export const CARD_CHROME_FALLBACK = 60;

/** 从 CSS 里量出来的、与宽度无关的常量。 */
export interface GridProbe {
  aspect: number;
  chrome: number;
  /** 卡片左右边框之和：预览区宽度要扣掉它。 */
  inset: number;
  /** 当前宽度下预览区的实测高度（行高以它为准）。 */
  previewHeight: number;
  /** 当前宽度下 1fr 轨道的实测宽度。 */
  cardWidth: number;
  headHeight: number;
  groupGap: number;
  rowGap: number;
  columnGap: number;
}

export let gridGeo: GridGeometry | null = null;

export let gridGeoKey = "";

export let gridBoxes: DayBox[] = [];

export let gridTotal = 0;

/** 按天分组后的展示顺序；卡片上的 data-index 就是它里面的下标。 */
export let gridItems: MediaItemDto[] = [];

export let gridSignature = "";

/** 结果集换代：筛选/媒体库变了就 +1，避免拿旧的行盒去算新的列表。 */
export let gridEpoch = 0;

/** 结果集换代：筛选/媒体库/删除后 +1，让旧行盒失效。 */
export function bumpGridEpoch(): void {
  gridEpoch += 1;
}

export let gridFrame: number | null = null;

/**
 * 量一次 CSS 常量。用一个离屏的迷你媒体区（天分组 + 真实卡片）去量，这样圆角、
 * 内边距、字号行高都跟着真实的样式表走，不用在 TS 里抄一遍。
 *
 * 两个必须照抄的细节：
 *  - 卡片用 renderCard 生成，并且铺满一整行：1fr 会把除不尽的余量分摊到各列，
 *    列宽相差 1/64px，而一行的高度由最宽的那列决定。只放一张卡片会少量 1/64，
 *    乘以十几行就是每一天的高度差。
 *  - 评分/无评分两种标记都放进去，取更高的那张（行高要覆盖最坏情况）。
 */
export function probeGridMetrics(width: number, tileMin: number): GridProbe {
  const host = document.createElement("div");
  // 宽度必须用小数：轨道宽度是按小数容器宽算完再截断到 1/64 的，
  // 取整后的宽度会让探测卡片和真实卡片差 1/64。
  host.style.cssText = `position:fixed;top:-20000px;left:0;width:${Math.max(160, width)}px;visibility:hidden;pointer-events:none;`;
  const shell = (cards: string) =>
    `<section class="media-day-group"><header class="day-heading"><h2>2024-01-01</h2><span>0 个项目</span></header><div class="media-grid">${cards}</div></section>`;
  const cardOf = (index: number) =>
    renderCard({ ...GRID_PROBE_ITEM, id: `__grid-probe-${index}__`, rating: index % 2 === 0 ? 0 : 5 }, index);
  app.append(host);
  try {
    // 第一趟：一张卡片，只为读出 gap 与列宽。
    host.innerHTML = shell(cardOf(0));
    const grid = host.querySelector<HTMLElement>(".media-grid");
    if (!grid) throw new Error("grid probe missing");
    const gridStyle = getComputedStyle(grid);
    const rowGap = Number.parseFloat(gridStyle.rowGap) || FALLBACK_ROW_GAP;
    const columnGap = Number.parseFloat(gridStyle.columnGap) || FALLBACK_COLUMN_GAP;
    const cols = computeColumns(width, tileMin, columnGap);
    // 第二趟：铺满一行，量出来的行高才等于真实网格的行高。
    host.innerHTML = shell(Array.from({ length: cols }, (_, index) => cardOf(index)).join(""));
    const section = host.querySelector<HTMLElement>(".media-day-group");
    const heading = host.querySelector<HTMLElement>(".day-heading");
    if (!section || !heading) throw new Error("grid probe missing");
    let tallest: { card: DOMRect; preview: DOMRect } | null = null;
    for (const node of host.querySelectorAll<HTMLElement>(".media-card")) {
      const preview = node.querySelector<HTMLElement>(".card-preview");
      if (!preview) continue;
      const cardRect = node.getBoundingClientRect();
      if (!tallest || cardRect.height > tallest.card.height)
        tallest = { card: cardRect, preview: preview.getBoundingClientRect() };
    }
    if (!tallest) throw new Error("grid probe card missing");
    const { card: cardRect, preview: previewRect } = tallest;
    const aspect =
      previewRect.width > 0 && previewRect.height > 0 ? previewRect.width / previewRect.height : CARD_ASPECT_RATIO;
    const chrome = cardRect.height - previewRect.height;
    return {
      aspect: aspect > 1 ? aspect : CARD_ASPECT_RATIO,
      chrome: chrome > 0 ? chrome : CARD_CHROME_FALLBACK,
      // 边框盒比预览区宽 2×border：aspect-ratio 是用内容宽度算高的。
      inset: Math.max(0, cardRect.width - previewRect.width),
      previewHeight: previewRect.height,
      cardWidth: cardRect.width,
      headHeight:
        heading.getBoundingClientRect().height + (Number.parseFloat(getComputedStyle(heading).marginBottom) || 0),
      groupGap: Number.parseFloat(getComputedStyle(section).marginBottom) || 0,
      rowGap,
      columnGap,
    };
  } catch {
    return {
      aspect: CARD_ASPECT_RATIO,
      chrome: CARD_CHROME_FALLBACK,
      inset: 2,
      previewHeight: 0,
      cardWidth: 0,
      headHeight: 30,
      groupGap: 35,
      rowGap: FALLBACK_ROW_GAP,
      columnGap: FALLBACK_COLUMN_GAP,
    };
  } finally {
    host.remove();
  }
}

/** 探测卡片用的假条目：只为了走一遍 renderCard 的真实标记。 */
export const GRID_PROBE_ITEM: MediaItemDto = {
  id: "__grid-probe__",
  libraryId: "",
  logicalKey: "",
  kind: "photo",
  displayName: "Probe.jpg",
  captureAt: null,
  captureDate: null,
  width: null,
  height: null,
  durationMs: null,
  totalSizeBytes: 0,
  burstGroup: null,
  metadataJson: null,
  scanState: "present",
  firstSeenAt: "",
  lastSeenAt: "",
  favorite: false,
  rating: 0,
};

/** 行高缓存键 = 容器宽度 + 密度；两者任一变化都要重新推导。 */
export function ensureGridGeometry(containerWidth: number): GridGeometry {
  // 用小数宽度：area 的整数 clientWidth 会把 1321.89 报成 1322，
  // 这 0.11px 摊到每一行就是滚动到底部前几像素的错位。
  const width = containerWidth > 0 ? containerWidth : 1;
  const key = `${width.toFixed(2)}:${state.density}`;
  if (gridGeo && gridGeoKey === key) return gridGeo;
  const tileMin = Number.parseFloat(getComputedStyle(app).getPropertyValue("--tile-min")) || 220;
  const probe = probeGridMetrics(width, tileMin);
  const geo = computeGeometry({
    containerWidth: width,
    tileMin,
    columnGap: probe.columnGap,
    rowGap: probe.rowGap,
    chrome: probe.chrome,
    headHeight: probe.headHeight,
    groupGap: probe.groupGap,
    aspectRatio: probe.aspect,
    inset: probe.inset,
    previewHeight: probe.previewHeight,
    cardWidth: probe.cardWidth,
  });
  gridGeo = geo;
  gridGeoKey = key;
  gridBoxes = [];
  return geo;
}

/**
 * 像素值对齐到 1/64：Chromium 内部排版单位就是 1/64px，占位高度也按它取整，
 * 才能和"整版渲染"折叠出来的分组高度逐个对上，而不是差一点点往下累积。
 */
export function layoutPx(value: number): string {
  return `${Math.round(value * 64) / 64}px`;
}

/** 结果集签名：长度 + 最后一项 + 换代号，足以判定行盒是否需要重算。 */
export function currentGridSignature(): string {
  const items = state.page.items;
  return `${gridEpoch}:${items.length}:${items[items.length - 1]?.id ?? ""}`;
}

export function rebuildGridBoxes(geo: GridGeometry): void {
  const groups = groupItemsByDay(state.page.items);
  const counts: Array<{ date: string; count: number }> = [];
  gridItems = [];
  for (const group of groups) {
    for (const item of group.items) gridItems.push(item);
    counts.push({ date: group.date, count: group.items.length });
  }
  const { boxes, total } = buildDayBoxes(counts, geo);
  gridBoxes = boxes;
  gridTotal = total;
  gridSignature = currentGridSignature();
}

/** 上下两个 spacer：一个撑出窗口之前的内容，一个撑出窗口之后的内容。 */
export function ensureGridSpacer(area: HTMLElement, edge: "top" | "bottom"): HTMLElement {
  const existing = area.querySelector<HTMLElement>(`:scope > .grid-spacer[data-edge="${edge}"]`);
  if (existing) return existing;
  const spacer = document.createElement("div");
  spacer.className = "grid-spacer";
  spacer.dataset.edge = edge;
  spacer.setAttribute("aria-hidden", "true");
  if (edge === "top") area.insertBefore(spacer, area.firstElementChild);
  else area.insertBefore(spacer, area.querySelector("#load-more-sentinel"));
  return spacer;
}

/** 分组内跳过的行用占位格补高度（grid-column:1/-1，独占一行）。 */
export function setGridRowOffset(grid: HTMLElement, height: number): void {
  const existing = grid.querySelector<HTMLElement>(":scope > .grid-row-offset");
  if (height <= 0) {
    existing?.remove();
    return;
  }
  const value = layoutPx(height);
  if (existing) {
    if (existing.style.height !== value) existing.style.height = value;
    return;
  }
  const spacer = document.createElement("div");
  spacer.className = "grid-row-offset";
  spacer.setAttribute("aria-hidden", "true");
  spacer.style.height = value;
  grid.insertBefore(spacer, grid.firstElementChild);
}

/**
 * 按当前滚动位置挂载可视行。
 * 只读一次几何（getBoundingClientRect），之后的写入都基于这一帧的数值。
 */
export function paintGridWindow(): void {
  const area = region("media");
  if (!area || !state.page.items.length) return;
  // 只读一次几何：后面所有写入都基于这一帧的数值。
  const rect = area.getBoundingClientRect();
  // 窗口最小化 / 容器还没布局时宽度不可用，画出来的行盒全是错的；等宽度回来
  // ResizeObserver 会再叫我们一次。
  if (rect.width < 160) return;
  const geo = ensureGridGeometry(rect.width);
  if (!gridBoxes.length || gridSignature !== currentGridSignature()) rebuildGridBoxes(geo);

  const scroller = loadMoreScrollRoot();
  const viewportHeight = scroller ? scroller.clientHeight : window.innerHeight || document.documentElement.clientHeight;
  // 可视带在 .media-area 坐标系里的位置（area 的顶边被卷到屏幕外时 -rect.top 为正）。
  const top = -rect.top;
  const plan = planWindow(gridBoxes, geo, { top, bottom: top + viewportHeight, overscan: viewportHeight });

  const topSpacer = ensureGridSpacer(area, "top");
  const bottomSpacer = ensureGridSpacer(area, "bottom");
  const padBottom = layoutPx(Math.max(0, gridTotal - plan.padBottom));
  const padTop = layoutPx(plan.padTop);
  if (topSpacer.style.height !== padTop) topSpacer.style.height = padTop;
  if (bottomSpacer.style.height !== padBottom) bottomSpacer.style.height = padBottom;

  const existing = new Map<string, HTMLElement>();
  area.querySelectorAll<HTMLElement>(":scope > .media-day-group").forEach((group) => {
    const day = group.dataset.day;
    if (day === undefined) group.remove();
    else existing.set(day, group);
  });

  let created = 0;
  let cursor: Element | null = topSpacer.nextElementSibling;
  for (const slice of plan.slices) {
    const box = gridBoxes[slice.box];
    let section = existing.get(box.date);
    if (section) existing.delete(box.date);
    else section = createDayGroup(box.date);
    patchDayGroupHeader(section, box.date, box.count);
    // 分组高度显式化：分组内只挂着窗口内的行，缺的行由下面两种占位补足。
    const groupHeight = layoutPx(box.height);
    if (section.style.height !== groupHeight) section.style.height = groupHeight;
    const grid = section.querySelector<HTMLElement>(".media-grid");
    if (grid) {
      setGridRowOffset(grid, slice.startRow > 0 ? slice.startRow * geo.rowPitch - geo.rowGap : 0);
      created += patchCardList(
        grid,
        gridItems.slice(slice.firstIndex, slice.firstIndex + slice.count),
        slice.firstIndex,
      );
    }
    if (section === cursor) cursor = cursor.nextElementSibling;
    else area.insertBefore(section, cursor);
  }
  for (const stale of existing.values()) {
    stale.querySelectorAll<HTMLElement>(":scope > .media-grid > .media-card").forEach(releaseCardNode);
    stale.remove();
  }

  // 只有真的换了卡片才需要重新排队取缩略图；换内容复用来的卡片自带新标记。
  if (created) observePreviews();
}

/** 一帧内只重排一次；滚动事件本身比帧快得多。 */
export function scheduleGridPaint(): void {
  if (gridFrame !== null) return;
  gridFrame = requestAnimationFrame(() => {
    gridFrame = null;
    paintGridWindow();
  });
}

/**
 * 媒体区宽度变化（窗口缩放、滚动条出现/消失）⇒ 列数可能变，行高必须重算。
 * 只靠 window.resize 会漏掉「内容变长后滚动条才出现」这一类宽度变化。
 */
export let gridResizeObserver: ResizeObserver | null = null;

/** 上一次观察到的媒体区宽度，用来滤掉纯高度变化（那不影响行盒）。 */
export let gridObservedWidth = 0;

export function watchGridResize(area: HTMLElement): void {
  if (typeof ResizeObserver !== "function") return;
  if (!gridResizeObserver) {
    gridResizeObserver = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0;
      if (gridObservedWidth === 0) {
        gridObservedWidth = width;
        return;
      }
      // 纯高度变化（条目增删）不影响行盒，只有宽度变了才需要重算。
      if (Math.abs(width - gridObservedWidth) < 0.5) return;
      gridObservedWidth = width;
      invalidateGridGeometry();
      scheduleGridPaint();
    });
    gridObservedWidth = area.getBoundingClientRect().width;
  }
  gridResizeObserver.observe(area);
}

/** 行高失效（密度/窗口宽度变化）：丢掉缓存，下一帧按新几何重排。 */
export function invalidateGridGeometry(): void {
  gridGeo = null;
  gridGeoKey = "";
  gridBoxes = [];
}

export function onGridScroll(): void {
  scheduleGridPaint();
}
