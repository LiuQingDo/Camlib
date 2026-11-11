/**
 * Fixed-row-height virtualization math (pure, no DOM).
 *
 * The media grid is a day-grouped CSS grid:
 *   `.media-area` > `.media-day-group[data-day]` > `.day-heading` + `.media-grid` > `.media-card`
 *
 * Columns come from `repeat(auto-fill, minmax(var(--tile-min), 1fr))`, so the
 * column count is a function of the container width and `--tile-min` alone; the
 * card height is the preview stage (a fixed aspect ratio) plus a width-independent
 * info block. That makes every row exactly the same height, which is what lets
 * the scroller describe the whole result set with numbers instead of DOM.
 *
 * Coordinate system: `top` / `height` are measured from the top of `.media-area`.
 */

/** `.card-preview` is `aspect-ratio: 1.17` — width ÷ height. */
export const CARD_ASPECT_RATIO = 1.17;
/** `.media-grid` gap fallbacks, used when no mounted grid is available to measure. */
export const FALLBACK_COLUMN_GAP = 16;
export const FALLBACK_ROW_GAP = 21;

export interface GridGeometry {
  /** Columns produced by `auto-fill`. */
  cols: number;
  /** Card width in px after the leftover space is distributed. */
  cardWidth: number;
  cardHeight: number;
  /** Row pitch: card height + row gap. */
  rowPitch: number;
  rowGap: number;
  /** Day heading block height including its own bottom margin. */
  headHeight: number;
  /**`.media-day-group` bottom margin. */
  groupGap: number;
}

export interface GeometryInput {
  containerWidth: number;
  tileMin: number;
  columnGap: number;
  rowGap: number;
  /** Width-independent part of a card: borders + `.card-info`. */
  chrome: number;
  headHeight: number;
  groupGap: number;
  aspectRatio?: number;
  /**
   * Horizontal border of a card (left + right). The track width is the card's
   * border box, but `aspect-ratio` on `.card-preview` resolves against the
   * content box — one pixel of border on each side would otherwise make every
   * row 1.7px too tall and the error would compound down the scroll.
   */
  inset?: number;
  /**
   * Preview height actually measured at `containerWidth`. When present it wins
   * over the aspect derivation: the browser truncates both the track width and
   * the aspect height to 1/64px, and re-deriving from a truncated ratio drifts
   * one layout unit per row — invisible in a row, ~15px at the bottom of a
   * 5000-item grid. The derivation below stays as the fallback (and as the
   * documented model the measurement is expected to agree with).
   */
  previewHeight?: number;
  /**
   * Track width actually measured at `containerWidth`. Preferred over the
   * arithmetic because `1fr` distribution rounds each track to 1/64px with a
   * rule that is not reproducible in JS (it floors 251.5875 → 251.578125 but
   * rounds 151.2421875 up). Being off by one layout unit per row is invisible in
   * a row and a dozen pixels at the bottom of a 5000-item grid.
   */
  cardWidth?: number;
}

/**
 * Column count of `repeat(auto-fill, minmax(tileMin, 1fr))`.
 * A new track only fits once the width can hold it plus one gap.
 */
export function computeColumns(containerWidth: number, tileMin: number, columnGap: number): number {
  if (!(containerWidth > 0) || !(tileMin > 0)) return 1;
  const gap = Math.max(0, columnGap);
  return Math.max(1, Math.floor((containerWidth + gap) / (tileMin + gap)));
}

/** `1fr` track width: the space left over after the fixed gaps, split evenly. */
export function computeCardWidth(containerWidth: number, cols: number, columnGap: number): number {
  if (!(containerWidth > 0) || cols <= 0) return 0;
  const gaps = Math.max(0, cols - 1) * Math.max(0, columnGap);
  return quantize((containerWidth - gaps) / cols);
}

/** Preview stage height plus the info block — the fixed row height. */
export function computeCardHeight(cardWidth: number, aspectRatio: number, chrome: number, inset = 0): number {
  const aspect = aspectRatio > 0 ? aspectRatio : CARD_ASPECT_RATIO;
  const previewWidth = Math.max(0, cardWidth - Math.max(0, inset));
  // 就近取整而不是向下：aspect 是从渲染结果反推出来的，本身已经被截断过一次，
  // 再向下取整会稳定少掉 1/64，乘以 17 行就是每一天的误差。
  return quantize(previewWidth / aspect, true) + Math.max(0, chrome);
}

export function computeGeometry(input: GeometryInput): GridGeometry {
  // 列数始终由 --tile-min 推导：它就是 auto-fill 的语义，也是行索引的来源。
  const cols = computeColumns(input.containerWidth, input.tileMin, input.columnGap);
  const measuredWidth = input.cardWidth ?? 0;
  const cardWidth = measuredWidth > 0 ? measuredWidth : computeCardWidth(input.containerWidth, cols, input.columnGap);
  const chrome = Math.max(0, input.chrome);
  const measuredPreview = input.previewHeight ?? 0;
  // 行高 = 预览区高度（宽高比由图宽决定）+ 与宽度无关的信息区。
  // 实测值优先；探测失败时退回「列宽 ÷ 宽高比」的推导。
  const cardHeight = measuredPreview > 0
    ? measuredPreview + chrome
    : computeCardHeight(cardWidth, input.aspectRatio ?? CARD_ASPECT_RATIO, chrome, input.inset ?? 0);
  return {
    cols,
    cardWidth,
    cardHeight,
    rowPitch: cardHeight + Math.max(0, input.rowGap),
    rowGap: Math.max(0, input.rowGap),
    headHeight: Math.max(0, input.headHeight),
    groupGap: Math.max(0, input.groupGap),
  };
}

export interface DayCount {
  date: string;
  count: number;
}

export interface DayBox {
  date: string;
  /** Index of the day's first item in the flattened display order. */
  firstIndex: number;
  count: number;
  rows: number;
  /** Offset of the day group's top edge. */
  top: number;
  /** Offset of the first card row (group top + heading). */
  gridTop: number;
  /** Group content height: heading + `rows` rows, without the trailing gap. */
  height: number;
}

export interface DayBoxes {
  boxes: DayBox[];
  /** Total scrolled height including the trailing group gap. */
  total: number;
}

export function buildDayBoxes(days: readonly DayCount[], geo: Pick<GridGeometry, "cols" | "rowPitch" | "rowGap" | "headHeight" | "groupGap">): DayBoxes {
  const boxes: DayBox[] = [];
  const cols = Math.max(1, geo.cols);
  let top = 0;
  let firstIndex = 0;
  for (const day of days) {
    const count = Math.max(0, day.count);
    const rows = Math.ceil(count / cols);
    const height = geo.headHeight + (rows > 0 ? rows * geo.rowPitch - geo.rowGap : 0);
    boxes.push({ date: day.date, firstIndex, count, rows, top, gridTop: top + geo.headHeight, height });
    top += height + geo.groupGap;
    firstIndex += count;
  }
  return { boxes, total: top };
}

export interface WindowSlice {
  /** Index into `boxes`. */
  box: number;
  startRow: number;
  endRow: number;
  /** Index of the first rendered card in the flattened display order. */
  firstIndex: number;
  /** Number of cards this slice renders. */
  count: number;
}

export interface GridWindow {
  slices: WindowSlice[];
  /** Height of the spacer above the first rendered day group. */
  padTop: number;
  /** Offset where the rendered content ends; the bottom spacer starts here. */
  padBottom: number;
  /** Total number of cards the window renders. */
  cardCount: number;
}

export interface WindowView {
  /** Visible band in `.media-area` coordinates. */
  top: number;
  bottom: number;
  /** Extra band kept mounted above and below (one viewport each by default). */
  overscan: number;
}

/**
 * Pick the day groups and rows to mount for a visible band.
 *
 * Only complete rows are mounted — a half-visible row would change the row
 * pitch and make the spacer arithmetic drift — so the band is rounded outward.
 */
export function planWindow(
  boxes: readonly DayBox[],
  geo: Pick<GridGeometry, "cols" | "rowPitch" | "rowGap" | "groupGap">,
  view: WindowView,
): GridWindow {
  const empty: GridWindow = { slices: [], padTop: 0, padBottom: 0, cardCount: 0 };
  if (!boxes.length) return empty;
  const overscan = Math.max(0, view.overscan);
  const from = view.top - overscan;
  const to = view.bottom + overscan;

  // First group whose box still reaches into the band.
  let first = 0;
  while (first + 1 < boxes.length && boxes[first + 1].top <= from) first += 1;
  // Last group that starts before the band ends.
  let last = first;
  while (last + 1 < boxes.length && boxes[last + 1].top < to) last += 1;

  const cols = Math.max(1, geo.cols);
  const rowPitch = Math.max(1, geo.rowPitch);
  const slices: WindowSlice[] = [];
  let cardCount = 0;
  for (let index = first; index <= last; index += 1) {
    const box = boxes[index];
    if (box.rows <= 0) continue;
    const startRow = clamp(Math.floor((from - box.gridTop) / rowPitch), 0, box.rows - 1);
    const endRow = clamp(Math.ceil((to - box.gridTop) / rowPitch) - 1, startRow, box.rows - 1);
    const fromItem = startRow * cols;
    const count = Math.min(box.count - fromItem, (endRow - startRow + 1) * cols);
    if (count <= 0) continue;
    slices.push({ box: index, startRow, endRow, firstIndex: box.firstIndex + fromItem, count });
    cardCount += count;
  }

  const lastBox = boxes[last];
  return {
    slices,
    padTop: boxes[first].top,
    padBottom: lastBox.top + lastBox.height + geo.groupGap,
    cardCount,
  };
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/**
 * Snap to Chromium's layout unit (1/64 px).
 *
 * `1fr` tracks are truncated to LayoutUnit, so a fractional track width must be
 * floored or it is a hair too wide. Heights go through `nearest` because the
 * aspect ratio they are divided by was itself read back from a truncated box.
 * Either way the residual is invisible in a single row and several pixels at the
 * bottom of a 5000-item grid.
 */
function quantize(value: number, nearest = false): number {
  if (!(value > 0)) return 0;
  return (nearest ? Math.round(value * 64) : Math.floor(value * 64)) / 64;
}
