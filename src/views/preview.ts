// 由 main.ts 拆分而来：仅做搬移，未改动逻辑。
import { MediaItemDto, MediaPreviewDto, getMediaPreview } from "../api/media";
import { loadMore } from "../app/media-query";
import { showToast } from "../app/toast";
import { formatSize } from "../lib/format";
import { syncLiquidGlass } from "../liquid-glass";
import { loadModalThumbnail, previewAssetCache, previewPrefetchLimit, previewPrefetchQueue } from "../media/cache";
import { app, setText } from "../render/context";
import { bindPreviewMetaEvents, render } from "../render/paint";
import { escapeHtml, formatDate, kindLabel } from "../render/text";
import { state } from "../state";
import { adaptDialogToMedia, applyDialogSizes, setupDialogResizing } from "./dialogs";
import { renderMetaPanel } from "./preview/meta";
import { previewUi } from "./preview/state";

export let previewRequest = 0;

// Modal UI flags that must survive partial DOM updates (not full re-renders).
// 信息面板默认展开：首次测得弹窗宽度 < PREVIEW_META_BREAKPOINT 时由
// applyPreviewLayout() 改回关闭（此时展开就是挡住画面的抽屉，得用户自己点开）。
export let previewInfoOpen = true;

export let livePlaying = false;

// ---------------------------------------------------------------------------
// 提示文案的唯一来源
//
// 之前底部提示、专注态舞台提示、实况说明各写一句，还出现过「滚轮缩放」与
// 「Ctrl+滚轮缩放」互相矛盾。现在三处都引用这里，改文案只改一处。
// ---------------------------------------------------------------------------
export const PREVIEW_HINTS = {
  main: "← → 切换 · 滚轮翻页 · Ctrl+滚轮缩放 · 双击 1:1 · F 专注视图",
  focus: "滚轮翻页 · Ctrl+滚轮缩放 · 双击 1:1 · Esc 退出专注",
  live: "点击画面播实况 · 长按看短片 · 按 L 切换",
} as const;

/** 「?」浮层里的完整手势表：由同一份常量驱动，不另写一套说明。 */
export const PREVIEW_SHORTCUTS: ReadonlyArray<readonly [string, string]> = [
  ["← →", "上一张 / 下一张"],
  ["滚轮", "翻页"],
  ["Ctrl + 滚轮", "缩放"],
  ["双击", "适配 / 1:1"],
  ["拖动", "放大后平移画面"],
  ["F", "进入 / 退出专注视图"],
  ["I", "信息面板"],
  ["L", "实况播放"],
  ["空格", "播放 / 暂停"],
  ["M", "静音"],
  ["Esc", "退出专注 / 关闭预览"],
];

/** 信息面板从侧栏变底部抽屉的容器宽度阈值（量的是弹窗，不是窗口）。 */
export const PREVIEW_META_BREAKPOINT = 1200;

/** 滚轮翻页：累计位移阈值，滤掉触控板的细碎抖动。 */
export const PREVIEW_WHEEL_PAGE_THRESHOLD = 40;

/** 滚轮翻页冷却：两次翻页之间至少隔这么久，避免一次滑动连翻十几张。 */
export const PREVIEW_WHEEL_PAGE_COOLDOWN_MS = 120;

/** 缩放 chip 的停留时长。 */
export const PREVIEW_ZOOM_CHIP_MS = 1200;

// Last loaded preview meta so tag/rating edits can patch the panel in place.
// Tag picker (preview panel) and tag-filter popover (toolbar) transient state.
// Lives outside AppState so opening/filtering them never triggers a re-render.
// Photo viewer zoom/pan. Scale 1 means fit-contain; >1 is a transform zoom.
export type PhotoZoomState = { scale: number; x: number; y: number; dragging: boolean; lastX: number; lastY: number };

export let photoZoom: PhotoZoomState = { scale: 1, x: 0, y: 0, dragging: false, lastX: 0, lastY: 0 };

export const PHOTO_ZOOM_MIN = 1;

export const PHOTO_ZOOM_MAX = 8;

export function resetPhotoZoom(): void {
  photoZoom = { scale: 1, x: 0, y: 0, dragging: false, lastX: 0, lastY: 0 };
  const imgs = app.querySelectorAll<HTMLImageElement>("#modal-media .photo-stage img.modal-photo");
  imgs.forEach((img) => {
    img.style.transform = "";
    img.classList.remove("is-zoomed");
  });
  updateZoomChip();
}

export function applyPhotoTransform(img: HTMLImageElement): void {
  const { scale, x, y } = photoZoom;
  const transform =
    scale <= 1 && Math.abs(x) < 0.5 && Math.abs(y) < 0.5 ? "" : `translate(${x}px, ${y}px) scale(${scale})`;
  img.style.transform = transform;
  img.classList.toggle("is-zoomed", scale > 1.01);
}

export function applyVideoLikeTransform(el: HTMLElement): void {
  const { scale, x, y } = photoZoom;
  el.style.transformOrigin = "center center";
  el.style.willChange = "transform";
  el.style.transform = scale === 1 && x === 0 && y === 0 ? "" : `translate(${x}px, ${y}px) scale(${scale})`;
}

export function applyPhotoTransformAll(stage: HTMLElement | null): void {
  if (stage) {
    stage.querySelectorAll<HTMLImageElement>("img.modal-photo, img.live-still").forEach((img) => {
      if (img.classList.contains("modal-photo")) applyPhotoTransform(img);
      else applyVideoLikeTransform(img);
    });
    stage.querySelectorAll<HTMLElement>("video.live-motion, .video-stage video, video").forEach(applyVideoLikeTransform);
    stage.classList.toggle("is-zoomed", photoZoom.scale > 1.01);
  }
  updateZoomChip(true);
}

export function clampPhotoZoom(value: number): number {
  return Math.min(PHOTO_ZOOM_MAX, Math.max(PHOTO_ZOOM_MIN, value));
}

export function resolvePanRoot(el: HTMLElement | null): HTMLElement | null {
  return (
    el?.closest?.<HTMLElement>(".photo-stage, .video-stage, .live-preview") ??
    el ??
    app.querySelector<HTMLElement>("#modal-media")
  );
}

// ---------------------------------------------------------------------------
// 缩放比例 chip
//
// 百分比是「画面相对原始像素的显示倍率」，不是 transform 的倍数：适配态通常
// 显示 40–60%，双击到 1:1 显示 100%。这样 100% 与「1:1」是同一个含义，chip
// 上的数字和用户对「原图 1:1」的直觉一致。
// ---------------------------------------------------------------------------

/** 当前显示倍率（相对原始像素）；拿不到自然尺寸时退回 transform 倍数。 */
export function previewZoomPercent(): number {
  const photo = app.querySelector<HTMLImageElement>("#modal-media img.modal-photo.is-original, #modal-media img.modal-photo, #modal-media img.live-still");
  const natural = photo?.naturalWidth ?? 0;
  const layout = photo?.clientWidth ?? 0;
  if (!photo || !natural || !layout) return Math.round(photoZoom.scale * 100);
  return Math.round(((layout * photoZoom.scale) / natural) * 100);
}

export let zoomChipTimer: number | null = null;

/**
 * `flash` 只给「用户刚刚缩放」的路径用：换图 / 重置时只更新数字与常亮状态，
 * 否则每打开一张照片都会闪一下比例，看起来像系统在自言自语。
 */
export function updateZoomChip(flash = false): void {
  const chip = app.querySelector<HTMLElement>("#zoom-chip");
  if (zoomChipTimer !== null) {
    window.clearTimeout(zoomChipTimer);
    zoomChipTimer = null;
  }
  if (!chip) return;
  const percent = previewZoomPercent();
  chip.textContent = `${percent}%`;
  chip.classList.remove("is-visible");
  // 100% = 1:1，是唯一需要「常亮」的锚点；其余比例看完就淡出。
  if (Math.abs(percent - 100) <= 1) {
    chip.classList.add("is-pinned");
    return;
  }
  chip.classList.remove("is-pinned");
  if (!flash) return;
  chip.classList.add("is-visible");
  zoomChipTimer = window.setTimeout(() => {
    zoomChipTimer = null;
    chip.classList.remove("is-visible");
  }, PREVIEW_ZOOM_CHIP_MS);
}

/** 以光标位置为锚点缩放：先把光标换算到舞台中心，再按比例挪位移。 */
function zoomAtCursor(stage: HTMLElement, event: MouseEvent, nextScale: number): void {
  const rect = stage.getBoundingClientRect();
  const cursorX = event.clientX - rect.left - rect.width / 2;
  const cursorY = event.clientY - rect.top - rect.height / 2;
  const ratio = nextScale / photoZoom.scale;
  photoZoom.x = cursorX - (cursorX - photoZoom.x) * ratio;
  photoZoom.y = cursorY - (cursorY - photoZoom.y) * ratio;
  photoZoom.scale = nextScale;
  if (photoZoom.scale <= 1.01) {
    photoZoom.scale = 1;
    photoZoom.x = 0;
    photoZoom.y = 0;
  }
}

// 滚轮翻页的累计量与上次翻页时刻。
let wheelPageAccum = 0;

let wheelPageLastAt = 0;

export function resetWheelPaging(): void {
  wheelPageAccum = 0;
  wheelPageLastAt = 0;
}

/**
 * 滚轮 = 翻页，Ctrl/⌘ + 滚轮 = 缩放。
 *
 * 舞台没有别的东西可滚动，所以两种手势都要 preventDefault；但「滚轮即缩放」
 * 会让想翻页的人莫名把图放大（而且不容易察觉），翻页才是图库的通用语义。
 */
export function handlePhotoWheel(event: WheelEvent): void {
  const stage = resolvePanRoot(event.currentTarget as HTMLElement | null);
  if (!stage) return;
  event.preventDefault();
  if (event.ctrlKey || event.metaKey) {
    const factor = Math.exp(-event.deltaY * 0.0015);
    const next = clampPhotoZoom(photoZoom.scale * factor);
    if (Math.abs(next - photoZoom.scale) < 0.0001) return;
    zoomAtCursor(stage, event, next);
    applyPhotoTransformAll(stage);
    return;
  }
  // deltaMode 1 = 按行滚动（部分鼠标/远程桌面），换算成像素再比较阈值。
  const delta = event.deltaY * (event.deltaMode === 1 ? 16 : 1);
  if (!delta) return;
  if (wheelPageAccum !== 0 && Math.sign(delta) !== Math.sign(wheelPageAccum)) wheelPageAccum = 0;
  wheelPageAccum += delta;
  if (Math.abs(wheelPageAccum) < PREVIEW_WHEEL_PAGE_THRESHOLD) return;
  const now = performance.now();
  if (now - wheelPageLastAt < PREVIEW_WHEEL_PAGE_COOLDOWN_MS) return;
  const direction = wheelPageAccum > 0 ? 1 : -1;
  wheelPageAccum = 0;
  wheelPageLastAt = now;
  void navigatePreview(direction);
}

/** 双击在「适配 ↔ 1:1」之间切换，锚点仍是光标位置。 */
export function handlePhotoDoubleClick(event: MouseEvent): void {
  const stage = resolvePanRoot(event.currentTarget as HTMLElement | null);
  if (!stage) return;
  // 双击导航按钮 / 实况控件不算缩放手势。
  if ((event.target as HTMLElement | null)?.closest?.("button, a, input, select, textarea, label, .live-controls")) return;
  event.preventDefault();
  // 已在 1:1（或被放大到更大）→ 回到适配。
  if (photoZoom.scale > 1.01) {
    resetPhotoZoom();
    return;
  }
  const media =
    stage.querySelector<HTMLImageElement>("img.modal-photo.is-original") ??
    stage.querySelector<HTMLImageElement>("img.modal-photo") ??
    stage.querySelector<HTMLVideoElement>("video");
  const natural = media instanceof HTMLVideoElement ? media.videoWidth : (media?.naturalWidth ?? 0);
  const layout = media instanceof HTMLVideoElement ? media.clientWidth : (media?.clientWidth ?? 0);
  // 1:1 = 原始像素 1:1。小图在适配态已经被放大（layout > natural）时没有
  // 可缩的余量，退回 2 倍，保证手势始终有反馈。
  const oneToOne = natural > 0 && layout > 0 ? natural / layout : 0;
  const next = clampPhotoZoom(oneToOne >= 1.02 ? oneToOne : 2);
  if (Math.abs(next - photoZoom.scale) < 0.01) return;
  zoomAtCursor(stage, event, next);
  applyPhotoTransformAll(stage);
}

export function handlePhotoPointerDown(event: PointerEvent): void {
  if (event.button !== 0) return;
  const stage = resolvePanRoot(event.currentTarget as HTMLElement | null);
  if (!stage) return;
  const target = event.target as HTMLElement | null;
  // Immersive allows free pan at any scale; otherwise pan only after zoom.
  if (!state.previewImmersive && photoZoom.scale <= 1.01) return;
  if (target?.closest?.("button, a, input, select, textarea, label, .live-controls")) return;
  // Leave the bottom native video control strip alone.
  if (state.previewImmersive && target?.tagName === "VIDEO") {
    const rect = target.getBoundingClientRect();
    if (event.clientY > rect.bottom - 48) return;
  }
  photoZoom.dragging = true;
  photoZoom.lastX = event.clientX;
  photoZoom.lastY = event.clientY;
  stage.classList.add("is-dragging");
  stage.setPointerCapture?.(event.pointerId);
}

export function handlePhotoPointerMove(event: PointerEvent): void {
  if (!photoZoom.dragging) return;
  const stage = resolvePanRoot(event.currentTarget as HTMLElement | null);
  if (!stage) return;
  photoZoom.x += event.clientX - photoZoom.lastX;
  photoZoom.y += event.clientY - photoZoom.lastY;
  photoZoom.lastX = event.clientX;
  photoZoom.lastY = event.clientY;
  applyPhotoTransformAll(stage);
}

export function handlePhotoPointerUp(event: PointerEvent): void {
  if (!photoZoom.dragging) return;
  photoZoom.dragging = false;
  const stage = resolvePanRoot(event.currentTarget as HTMLElement | null);
  stage?.classList.remove("is-dragging");
  stage?.releasePointerCapture?.(event.pointerId);
}

export function bindPhotoStage(stage: HTMLElement): void {
  stage.addEventListener("wheel", handlePhotoWheel, { passive: false });
  stage.addEventListener("dblclick", handlePhotoDoubleClick);
  stage.addEventListener("pointerdown", handlePhotoPointerDown);
  stage.addEventListener("pointermove", handlePhotoPointerMove);
  stage.addEventListener("pointerup", handlePhotoPointerUp);
  stage.addEventListener("pointercancel", handlePhotoPointerUp);
}

export function bindPreviewMediaInteraction(media: HTMLElement): void {
  media
    .querySelectorAll<HTMLElement>("#photo-stage, .photo-stage, .video-stage, .live-preview")
    .forEach(bindPhotoStage);
}

/**
 * Overlay the camera original on top of the thumbnail placeholder.
 * Never swap src on the same element — partial decode would flash gray bands.
 */
export function upgradeStillToOriginal(stage: HTMLElement | null, originalUrl: string, request: number): void {
  if (!stage || !originalUrl) return;
  const loader = new Image();
  loader.decoding = "async";
  loader.onload = () => {
    if (request !== previewRequest || !stage.isConnected) return;
    if (!loader.naturalWidth || !loader.naturalHeight) return;
    const existing = stage.querySelector<HTMLImageElement>("img.modal-photo.is-original");
    if (existing) return;
    const original = document.createElement("img");
    original.className = "modal-photo is-original";
    original.alt = stage.querySelector<HTMLImageElement>("img.modal-photo")?.alt ?? "";
    original.draggable = false;
    original.src = originalUrl;
    original.style.transform = stage.querySelector<HTMLImageElement>("img.modal-photo")?.style.transform ?? "";
    if (photoZoom.scale > 1.01) original.classList.add("is-zoomed");
    const hint = stage.querySelector<HTMLElement>(".photo-zoom-hint");
    const placeholder = stage.querySelector<HTMLImageElement>("img.modal-photo.is-placeholder");
    if (hint) stage.insertBefore(original, hint);
    else stage.appendChild(original);
    // Drop the blurry stand-in after the original is on screen.
    placeholder?.remove();
    stage.classList.add("is-original-ready");
    stage.classList.remove("is-original-loading");
    // 原图就位后「显示倍率」才是真值：占位缩略图的自然尺寸不同。
    updateZoomChip();
  };
  loader.onerror = () => {
    if (request !== previewRequest || !stage.isConnected) return;
    stage.classList.add("is-original-failed");
    stage.classList.remove("is-original-loading");
    const status = stage.querySelector<HTMLElement>(".photo-load-status");
    if (status) status.textContent = "原图加载失败 · 显示缩略图";
  };
  stage.classList.add("is-original-loading");
  loader.src = originalUrl;
}

/** Same overlay upgrade for Live Photo stills (no zoom stack). */
export function upgradeLiveStill(stack: HTMLElement | null, originalUrl: string, request: number): void {
  if (!stack || !originalUrl) return;
  const loader = new Image();
  loader.decoding = "async";
  loader.onload = () => {
    if (request !== previewRequest || !stack.isConnected) return;
    if (!loader.naturalWidth || !loader.naturalHeight) return;
    if (stack.querySelector("img.live-still.is-original")) return;
    const original = document.createElement("img");
    original.className = "live-still is-original";
    original.alt = stack.querySelector<HTMLImageElement>("img.live-still")?.alt ?? "";
    original.src = originalUrl;
    stack.appendChild(original);
    stack.querySelector<HTMLImageElement>("img.live-still.is-placeholder")?.remove();
  };
  loader.src = originalUrl;
}

export function requestPreview(id: string): Promise<MediaPreviewDto> {
  const pending = previewAssetCache.get(id);
  if (pending) return pending;
  const request = getMediaPreview(id);
  previewAssetCache.set(id, request);
  void request.catch(() => previewAssetCache.delete(id));
  return request;
}

/**
 * Evict cached preview payloads after a meta change (tags/rating/favorite/AI).
 * The cache stores whole preview DTOs, so without this a reopened preview
 * replays the stale promise and shows the old tags/rating even though the
 * database write succeeded.
 */
export function invalidatePreviewMeta(ids: string[]): void {
  for (const id of ids) previewAssetCache.delete(id);
}

export function pumpPreviewPrefetch(): void {
  while (previewUi.activePrefetches < previewPrefetchLimit && previewPrefetchQueue.length) {
    const id = previewPrefetchQueue.shift();
    if (!id || previewAssetCache.has(id)) continue;
    previewUi.activePrefetches += 1;
    const request = getMediaPreview(id);
    previewAssetCache.set(id, request);
    void request
      .catch(() => previewAssetCache.delete(id))
      .finally(() => {
        previewUi.activePrefetches -= 1;
        pumpPreviewPrefetch();
      });
  }
}

export function neighborIds(index: number): string[] {
  const items = state.page.items;
  if (!items.length || index < 0 || index >= items.length) return [];
  const total = items.length;
  const candidates = [index - 1, index + 1, index - 2, index + 2].map((offset) => (offset + total * 2) % total);
  const seen = new Set<number>();
  const ids: string[] = [];
  for (const neighbor of candidates) {
    if (neighbor === index || seen.has(neighbor)) continue;
    seen.add(neighbor);
    const id = items[neighbor]?.id;
    if (id) ids.push(id);
  }
  return ids;
}

export function prefetchPreviewNeighbors(index: number): void {
  for (const id of neighborIds(index)) {
    if (previewAssetCache.has(id) || previewPrefetchQueue.includes(id)) continue;
    previewPrefetchQueue.push(id);
    // Warm the large modal still in parallel so photo previews pop instantly.
    void loadModalThumbnail(id).catch(() => undefined);
  }
  pumpPreviewPrefetch();
}

/** 底部标题的第二行：日期 · 体积 ·（连拍）。打开与换图共用同一份文案。 */
function captionMeta(item: MediaItemDto): string {
  return `${formatDate(item.captureDate)} · ${formatSize(item.totalSizeBytes)}${item.burstGroup ? " · 连拍" : ""}`;
}

/** 结果集总数（未加载完时它才是「共几张」的答案）。 */
function previewTotal(): number {
  return state.page.total > 0 ? state.page.total : state.page.items.length;
}

function renderHintPopover(): string {
  const rows = PREVIEW_SHORTCUTS.map(
    ([keys, action]) => `<div class="hint-row"><kbd>${escapeHtml(keys)}</kbd><span>${escapeHtml(action)}</span></div>`,
  ).join("");
  return `<strong>快捷键与手势</strong>${rows}`;
}

/**
 * 换图时的原地 patch：只改文字与按钮可见性，绝不重建外壳。
 *
 * `resetAssets` 为真表示换成的是另一张图（而不是同一张的结果集长度变化）：
 * 这时把元信息面板退回占位——上一张的标签、评分、AI 描述不能挂在新图上，
 * 真正的数据由 loadModalAsset 取回后填。
 */
export function patchPreviewFrame(item: MediaItemDto, index: number, resetAssets: boolean): void {
  const frame = app.querySelector<HTMLElement>(".preview-modal");
  if (!frame) return;
  frame.setAttribute("aria-label", item.displayName);
  // 位置显示「第几张 / 共几张」：分母只认 total，别再出现第二个「总数」。
  setText(frame.querySelector(".modal-position"), `${index + 1} / ${previewTotal()}`);
  const shown = state.page.items.length;
  const total = previewTotal();
  const loaded = frame.querySelector<HTMLElement>("#preview-loaded-note");
  if (loaded) {
    loaded.hidden = shown >= total;
    loaded.textContent = `已加载 ${shown} / ${total}`;
  }
  const copy = frame.querySelector(".modal-caption-copy");
  if (copy) {
    setText(copy.querySelector("strong"), item.displayName);
    setText(copy.querySelector("span"), captionMeta(item));
  }
  // 实况没有可编辑的源：保留节点只隐藏，重建节点会把绑好的点击一起丢掉。
  const edit = frame.querySelector<HTMLButtonElement>("#preview-edit");
  if (edit) {
    edit.hidden = item.kind === "live";
    setText(edit, item.kind === "video" ? "剪辑" : "编辑");
  }
  const folder = frame.querySelector<HTMLElement>("#preview-open-folder");
  if (folder) folder.dataset.openFolder = item.id;
  if (!resetAssets) return;
  const meta = frame.querySelector<HTMLElement>("#modal-meta");
  if (meta && !meta.querySelector(".meta-placeholder")) meta.innerHTML = `<div class="meta-placeholder">加载中…</div>`;
}

export function renderPreview(): string {
  if (state.previewIndex === null) return "";
  const item = state.page.items[state.previewIndex];
  if (!item) return "";
  const position = (state.previewIndex ?? 0) + 1;
  const total = previewTotal();
  const shown = state.page.items.length;
  const immersiveClass = state.previewImmersive ? " is-immersive" : "";
  return `<div class="modal-backdrop${immersiveClass}" id="preview-modal"><div class="preview-modal${immersiveClass}" role="dialog" aria-modal="true" aria-label="${escapeHtml(item.displayName)}" ${state.previewImmersive ? 'data-liquid-glass="off"' : ""}>
    <header class="modal-header"><div class="modal-header-copy"><span class="modal-kind-pill">${kindLabel(item.kind)}</span><span class="modal-position">${position} / ${total}</span></div><div class="modal-header-actions"><button class="modal-close" id="close-preview" type="button" aria-label="关闭">×</button></div></header>
    <div class="modal-body">
      <div class="modal-stage"><button class="modal-nav prev" id="preview-prev" type="button" aria-label="上一个">‹</button><div class="modal-media" id="modal-media"><span class="spinner large"></span></div><button class="modal-nav next" id="preview-next" type="button" aria-label="下一个">›</button><span class="zoom-chip" id="zoom-chip" aria-hidden="true">100%</span></div>
      <aside class="modal-meta ${previewInfoOpen ? "" : "is-hidden"}" id="modal-meta" aria-label="媒体信息" aria-hidden="${previewInfoOpen ? "false" : "true"}"><div class="meta-placeholder">加载中…</div></aside>
    </div>
    <footer class="modal-caption">
      <div class="modal-caption-copy"><strong>${escapeHtml(item.displayName)}</strong><span>${captionMeta(item)}</span></div>
      <div class="modal-caption-tools">
        <div class="modal-actions">
          <button class="outline-button modal-tool-button" id="preview-info-toggle" type="button" aria-pressed="${previewInfoOpen}">信息</button>
          <button class="outline-button modal-tool-button" id="preview-focus" type="button" aria-pressed="${state.previewImmersive}">专注</button>
          <button class="outline-button modal-tool-button" id="preview-edit" type="button"${item.kind === "live" ? " hidden" : ""}>${item.kind === "video" ? "剪辑" : "编辑"}</button>
          <button class="outline-button modal-tool-button modal-folder-button" id="preview-open-folder" type="button" data-open-folder="${escapeHtml(item.id)}">在文件夹中显示</button>
        </div>
      </div>
      <div class="modal-hint-row">
        <span class="modal-hint">${PREVIEW_HINTS.main}</span>
        <button class="modal-hint-more" id="preview-hint-more" type="button" aria-expanded="false" aria-label="全部快捷键与手势" title="全部快捷键与手势">?</button>
        <span class="modal-loaded-note" id="preview-loaded-note"${shown >= total ? " hidden" : ""}>已加载 ${shown} / ${total}</span>
        <div class="modal-hint-pop" id="preview-hint-pop" hidden>${renderHintPopover()}</div>
      </div>
    </footer>
    <button class="focus-exit" id="preview-focus-exit" type="button" aria-label="退出专注视图">退出专注</button>
  </div></div>`;
}

export function renderVideoStatusOverlay(): string {
  return `<div class="video-status is-buffering" id="video-buffer" hidden><span class="spinner"></span><span>缓冲中…</span></div>
  <div class="video-status is-error" id="video-error" hidden><strong>视频无法播放</strong><span>文件可能损坏，或当前磁盘暂时不可读</span><button type="button" class="outline-button" id="video-retry">重试</button></div>`;
}

export function bindVideoElement(video: HTMLVideoElement): void {
  const buffer = app.querySelector<HTMLElement>("#video-buffer");
  const errorBox = app.querySelector<HTMLElement>("#video-error");
  const hideOverlays = () => {
    if (buffer) buffer.hidden = true;
    if (errorBox) errorBox.hidden = true;
  };
  video.addEventListener("waiting", () => {
    if (buffer) buffer.hidden = false;
  });
  video.addEventListener("playing", hideOverlays);
  video.addEventListener("canplay", () => {
    if (buffer) buffer.hidden = true;
  });
  video.addEventListener("error", () => {
    if (buffer) buffer.hidden = true;
    if (errorBox) errorBox.hidden = false;
  });
}

export async function loadModalAsset(): Promise<void> {
  const index = state.previewIndex;
  const item = index === null ? undefined : state.page.items[index];
  if (!item) return;
  const request = ++previewRequest;
  livePlaying = false;
  resetPhotoZoom();
  if (index !== null) prefetchPreviewNeighbors(index);
  try {
    const preview = await requestPreview(item.id);
    if (request !== previewRequest || state.previewIndex === null) return;
    const media = app.querySelector<HTMLElement>("#modal-media");
    const metaPanel = app.querySelector<HTMLElement>("#modal-meta");
    if (!media) return;
    previewUi.metaCache = preview.meta;
    if (metaPanel) {
      metaPanel.innerHTML = renderMetaPanel(preview.meta, item);
      bindPreviewMetaEvents(metaPanel, item);
    }
    const photo = preview.sources.find(
      (source) => source.role === "photo" || (source.role === "single" && !source.mimeType.startsWith("video/")),
    );
    const video = preview.sources.find(
      (source) => source.role === "video" || (source.role === "single" && source.mimeType.startsWith("video/")),
    );
    if (item.kind === "live" && photo && video) {
      const photoPreview = await loadModalThumbnail(item.id).catch(() => undefined);
      if (request !== previewRequest || state.previewIndex === null) return;
      const usePlaceholder = Boolean(photoPreview?.url && photoPreview.url !== photo.url);
      media.innerHTML = `<div class="live-preview" data-live-playing="false">
        <div class="live-still-stack" id="live-still-stack">
          <img class="live-still${usePlaceholder ? " is-placeholder" : " is-original"}" src="${photoPreview?.url ?? photo.url}" alt="${escapeHtml(item.displayName)}" />
          <span class="live-badge" aria-hidden="true">LIVE</span>
        </div>
        <video class="live-motion" src="${video.url}" muted loop playsinline preload="metadata" hidden></video>
        <div class="live-controls">
          <button type="button" class="live-toggle" id="live-toggle" aria-pressed="false">实况</button>
          <span class="live-caption">${PREVIEW_HINTS.live}</span>
        </div>
      </div>`;
      if (usePlaceholder) {
        const stack = media.querySelector<HTMLElement>("#live-still-stack");
        if (stack) upgradeLiveStill(stack, photo.url, request);
      }
      const liveVideo = media.querySelector<HTMLVideoElement>("video.live-motion");
      if (liveVideo) {
        bindVideoElement(liveVideo);
        liveVideo.addEventListener("ended", () => setLivePlaying(false));
      }
      bindPreviewMediaInteraction(media);
    } else if (video) {
      media.innerHTML = `<div class="video-stage"><video src="${video.url}" controls playsinline preload="metadata"></video>${renderVideoStatusOverlay()}</div>`;
      const el = media.querySelector<HTMLVideoElement>("video");
      if (el) {
        bindVideoElement(el);
        // 编辑器叠在预览之上时保持暂停：全量渲染会重建该元素，
        // 此时自动播放会让背后的预览重新出画出声。
        if (!state.editorOpen) void el.play().catch(() => undefined);
      }
      bindPreviewMediaInteraction(media);
    } else if (photo) {
      // Thumbnail first for instant paint; original overlays only after a full decode.
      const thumb = await loadModalThumbnail(item.id).catch(() => undefined);
      if (request !== previewRequest || state.previewIndex === null) return;
      const placeholder = thumb?.url;
      const usePlaceholder = Boolean(placeholder && placeholder !== photo.url);
      media.innerHTML = `<div class="photo-stage${usePlaceholder ? " is-original-loading" : " is-original-ready"}" id="photo-stage">
        <img class="modal-photo${usePlaceholder ? " is-placeholder" : " is-original"}" id="modal-photo" src="${placeholder ?? photo.url}" alt="${escapeHtml(item.displayName)}" draggable="false" decoding="async" />
        ${usePlaceholder ? `<span class="photo-load-status" id="photo-load-status">正在加载原图…</span>` : ""}
        <div class="photo-zoom-hint" id="photo-zoom-hint">${state.previewImmersive ? PREVIEW_HINTS.focus : PREVIEW_HINTS.main}</div>
      </div>`;
      const stage = media.querySelector<HTMLElement>("#photo-stage");
      if (stage) {
        bindPhotoStage(stage);
        if (usePlaceholder) upgradeStillToOriginal(stage, photo.url, request);
      }
    } else {
      media.innerHTML = `<div class="preview-error"><span>当前文件不可用</span><button type="button" class="outline-button" id="preview-retry-media">重试</button></div>`;
    }
    updateZoomChip();
  } catch {
    if (request !== previewRequest) return;
    const media = app.querySelector<HTMLElement>("#modal-media");
    if (media) {
      media.innerHTML = `<div class="preview-error"><span>当前文件不可用</span><button type="button" class="outline-button" id="preview-retry-media">重试</button></div>`;
    }
  }
}

export function setLivePlaying(playing: boolean): void {
  livePlaying = playing;
  const root = app.querySelector<HTMLElement>("#modal-media .live-preview");
  if (!root) return;
  const video = root.querySelector<HTMLVideoElement>("video.live-motion");
  const stack = root.querySelector<HTMLElement>(".live-still-stack");
  const toggle = root.querySelector<HTMLButtonElement>("#live-toggle");
  root.dataset.livePlaying = playing ? "true" : "false";
  toggle?.setAttribute("aria-pressed", String(playing));
  toggle?.classList.toggle("is-active", playing);
  if (!video) return;
  if (playing) {
    video.hidden = false;
    stack?.classList.add("is-under");
    if (video.ended || video.currentTime === 0) video.currentTime = 0;
    void video.play().catch(() => setLivePlaying(false));
  } else {
    video.pause();
    video.hidden = true;
    stack?.classList.remove("is-under");
  }
}

export function toggleLivePreview(): void {
  const root = app.querySelector<HTMLElement>("#modal-media .live-preview");
  if (!root) return;
  setLivePlaying(!livePlaying);
}

export function activePreviewVideo(): HTMLVideoElement | null {
  const live = app.querySelector<HTMLVideoElement>("#modal-media video.live-motion");
  if (live && livePlaying) return live;
  return app.querySelector<HTMLVideoElement>("#modal-media .video-stage video");
}

export function togglePreviewPlayback(): void {
  const video = activePreviewVideo();
  if (video) {
    if (video.paused) void video.play().catch(() => undefined);
    else video.pause();
    return;
  }
  // Live Photo still: Space starts the motion clip.
  if (app.querySelector("#modal-media .live-preview")) toggleLivePreview();
}

export function togglePreviewMute(): void {
  const video = activePreviewVideo() ?? app.querySelector<HTMLVideoElement>("#modal-media video");
  if (!video) return;
  video.muted = !video.muted;
}

/**
 * Pause all preview media playback. Overlays that take over playback (the
 * editor) call this so the preview behind them never keeps playing. The live
 * path goes through setLivePlaying to also restore the still-frame UI.
 */
export function pausePreviewPlayback(): void {
  if (livePlaying) setLivePlaying(false);
  for (const video of app.querySelectorAll<HTMLVideoElement>("#modal-media video")) {
    video.pause();
  }
}

/** 「按媒体尺寸自适应弹窗」：按钮现在挂在信息面板底部，逻辑与编辑器共用。 */
export function fitPreviewDialogToMedia(): void {
  const media = app.querySelector<HTMLElement>("#modal-media");
  const video = media?.querySelector<HTMLVideoElement>("video:not([hidden])");
  adaptDialogToMedia("preview", video ?? media?.querySelector<HTMLImageElement>("img") ?? null);
}

/**
 * 专注视图：只留画面，隐藏顶栏 / 信息面板 / 底部工具，右上角留一个退出按钮。
 *
 * 刻意不碰浏览器 Fullscreen API——Tauri 窗口下全屏的行为与退出路径都不由我们
 * 掌控（Esc 可能被系统吃掉），而这里只需要「让 chrome 消失」。
 * 状态仍沿用 `state.previewImmersive`：对话框几何、CSS 与持久化偏好都认它。
 */
export function toggleFocusMode(force?: boolean): void {
  const next = typeof force === "boolean" ? force : !state.previewImmersive;
  state.previewImmersive = next;
  const backdrop = app.querySelector<HTMLElement>("#preview-modal");
  const modal = app.querySelector<HTMLElement>(".preview-modal");
  const button = app.querySelector<HTMLButtonElement>("#preview-focus");
  backdrop?.classList.toggle("is-immersive", next);
  modal?.classList.toggle("is-immersive", next);
  if (modal) {
    if (next) modal.dataset.liquidGlass = "off";
    else delete modal.dataset.liquidGlass;
  }
  button?.setAttribute("aria-pressed", String(next));
  closePreviewHintPopover();
  const hint = app.querySelector<HTMLElement>("#photo-zoom-hint");
  if (hint) hint.textContent = next ? PREVIEW_HINTS.focus : PREVIEW_HINTS.main;
  if (!next) resetPhotoZoom();
  // Inline width/height would beat the immersive 100vw/100vh rules, so hand
  // geometry over when entering and take it back when leaving.
  applyDialogSizes();
  if (!next) setupDialogResizing();
  syncLiquidGlass();
  applyPreviewLayout();
}

function syncInfoPanelState(): void {
  const panel = app.querySelector<HTMLElement>("#modal-meta");
  if (panel) {
    panel.classList.toggle("is-hidden", !previewInfoOpen);
    panel.setAttribute("aria-hidden", previewInfoOpen ? "false" : "true");
  }
  app.querySelector<HTMLButtonElement>("#preview-info-toggle")?.setAttribute("aria-pressed", String(previewInfoOpen));
}

let previewLayoutObserver: ResizeObserver | null = null;

let previewLayoutTarget: HTMLElement | null = null;

/** 首次测得宽度决定默认开关；之后只切形态，不再覆盖用户的手动选择。 */
let previewInfoInitialized = false;

/**
 * 信息面板布局：宽 → 右侧栏，窄 → 底部抽屉（`.is-drawer`）。
 *
 * 量的是弹窗自己的宽度而不是 `window.innerWidth`：弹窗可拖拽缩放，窗口 1400
 * 但弹窗被拖到 900 时，用窗口宽度判断会把侧栏留在画面里挤扁主图。
 */
export function applyPreviewLayout(decideDefault = false): void {
  const modal = app.querySelector<HTMLElement>(".preview-modal");
  if (!modal) return;
  const width = modal.getBoundingClientRect().width;
  if (width <= 0) return;
  const narrow = width < PREVIEW_META_BREAKPOINT;
  modal.classList.toggle("is-drawer", narrow);
  if (decideDefault && !previewInfoInitialized) {
    previewInfoInitialized = true;
    // 窄弹窗里默认展开等于用抽屉盖住图，所以默认收起，需要时手动拉出。
    previewInfoOpen = !narrow;
  }
  syncInfoPanelState();
}

/**
 * 预览外壳重建后调用（在 applyDialogSizes 之后，此时弹窗宽度已是最终值）：
 * 挂上观察器并算一次布局。幂等，重复调用只重算不改结构。
 */
export function bindPreviewLayoutObserver(): void {
  const modal = app.querySelector<HTMLElement>(".preview-modal");
  if (!modal) {
    previewLayoutObserver?.disconnect();
    previewLayoutObserver = null;
    previewLayoutTarget = null;
    return;
  }
  if (previewLayoutTarget !== modal || !previewLayoutObserver) {
    previewLayoutObserver?.disconnect();
    previewLayoutTarget = modal;
    previewInfoInitialized = false;
    previewLayoutObserver = new ResizeObserver(() => applyPreviewLayout());
    previewLayoutObserver.observe(modal);
  }
  applyPreviewLayout(true);
}

export function togglePreviewInfo(): void {
  previewInfoOpen = !previewInfoOpen;
  previewInfoInitialized = true;
  closePreviewHintPopover();
  syncInfoPanelState();
}

export function togglePreviewHintPopover(): void {
  const pop = app.querySelector<HTMLElement>("#preview-hint-pop");
  const button = app.querySelector<HTMLButtonElement>("#preview-hint-more");
  if (!pop) return;
  const open = pop.hidden;
  pop.hidden = !open;
  button?.setAttribute("aria-expanded", String(open));
}

/** 收掉「?」浮层；返回是否真的收了一个（Esc 阶梯用）。 */
export function closePreviewHintPopover(): boolean {
  const pop = app.querySelector<HTMLElement>("#preview-hint-pop");
  if (!pop || pop.hidden) return false;
  pop.hidden = true;
  app.querySelector<HTMLButtonElement>("#preview-hint-more")?.setAttribute("aria-expanded", "false");
  return true;
}

/** 预览弹窗尚未增量化：关闭时容器整体清空。 */
export function closePreview(): void {
  state.previewIndex = null;
  livePlaying = false;
  liveHoldActive = false;
  previewUi.metaCache = null;
  previewUi.tagPickerOpen = false;
  previewUi.tagPickerQuery = "";
  state.previewImmersive = false;
  previewInfoOpen = true;
  previewInfoInitialized = false;
  resetPhotoZoom();
  resetWheelPaging();
  previewLayoutObserver?.disconnect();
  previewLayoutObserver = null;
  previewLayoutTarget = null;
  if (liveHoldTimer !== null) {
    window.clearTimeout(liveHoldTimer);
    liveHoldTimer = null;
  }
  render();
}

let previewPageBusy = false;

/**
 * 翻页唯一入口：到已加载末尾就先补下一页，成功后再移动。
 *
 * 旧实现用 `% items.length` 回卷，最后一张按右键会跳回第一张，而且永远不触发
 * 加载更多——照片一多，预览能看到的就只有前 120 张。这里改成「到头就追加」，
 * 追加失败给 toast，别让按键看起来像坏了。
 */
export async function navigatePreview(delta: number): Promise<void> {
  const index = state.previewIndex;
  if (index === null || !state.page.items.length) return;
  // 正在补页时再翻一次：不放行，也不要误报「加载失败」。
  if (previewPageBusy) return;
  const target = index + delta;
  if (target < 0) return;
  if (target >= state.page.items.length) {
    if (state.page.items.length >= previewTotal()) return;
    const before = state.page.items.length;
    previewPageBusy = true;
    try {
      await loadMore();
    } finally {
      previewPageBusy = false;
    }
    // 期间用户已经换图 / 关掉预览：本次翻页作废。
    if (state.previewIndex !== index) return;
    if (state.page.items.length <= before) {
      showToast(state.loadMoreError ?? "加载更多失败，请稍后重试", { kind: "error", key: "preview-load-more" });
      return;
    }
  }
  if (index + delta >= state.page.items.length) return;
  movePreview(delta);
}

function movePreview(delta: number): void {
  if (state.previewIndex === null || !state.page.items.length) return;
  state.previewIndex = Math.min(state.page.items.length - 1, Math.max(0, state.previewIndex + delta));
  livePlaying = false;
  liveHoldActive = false;
  resetPhotoZoom();
  // 只清累计量，不清翻页冷却：触控板的惯性尾巴不该因为换了一张图就重新生效。
  wheelPageAccum = 0;
  closePreviewHintPopover();
  // The picker belongs to the previous item's tag block; start fresh.
  previewUi.tagPickerOpen = false;
  previewUi.tagPickerQuery = "";
  if (liveHoldTimer !== null) {
    window.clearTimeout(liveHoldTimer);
    liveHoldTimer = null;
  }
  // 换图只改文字与 #modal-media：外壳不重建，由 patchPreviewFrame + 装载钩子接手。
  render();
}

// Long-press (or press-and-hold) on the Live Photo still plays motion while held.
export let liveHoldTimer: number | null = null;

export let liveHoldActive = false;

/** 长按已经起播时，抬手会紧跟一个 click：别让它又把实况切回去。 */
let liveHoldConsumedClick = false;

app.addEventListener("pointerdown", (event) => {
  const still = (event.target as HTMLElement | null)?.closest?.("#modal-media .live-still");
  if (!still || livePlaying) return;
  // 上一次长按若没能等到 click（手滑出了画面），别把这一次的点击吃掉。
  liveHoldConsumedClick = false;
  liveHoldTimer = window.setTimeout(() => {
    liveHoldTimer = null;
    liveHoldActive = true;
    setLivePlaying(true);
  }, 180);
});

app.addEventListener("pointerup", () => {
  if (liveHoldTimer !== null) {
    window.clearTimeout(liveHoldTimer);
    liveHoldTimer = null;
  }
  if (liveHoldActive) {
    liveHoldActive = false;
    liveHoldConsumedClick = true;
    setLivePlaying(false);
  }
});

app.addEventListener("pointercancel", () => {
  if (liveHoldTimer !== null) {
    window.clearTimeout(liveHoldTimer);
    liveHoldTimer = null;
  }
  if (liveHoldActive) {
    liveHoldActive = false;
    setLivePlaying(false);
  }
});

// 实况首帧（LIVE 角标那张）点一下就播；播放中的短片点一下停。
app.addEventListener("click", (event) => {
  const target = event.target as HTMLElement | null;
  if (!target?.closest("#modal-media .live-preview")) return;
  if (liveHoldConsumedClick) {
    liveHoldConsumedClick = false;
    return;
  }
  if (target.closest("#live-toggle")) return;
  const still = target.closest(".live-still");
  const motion = target.closest("video.live-motion");
  if (still && !livePlaying) {
    event.preventDefault();
    setLivePlaying(true);
    return;
  }
  if (motion && livePlaying) {
    event.preventDefault();
    setLivePlaying(false);
  }
});
