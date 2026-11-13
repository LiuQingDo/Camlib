// 由 main.ts 拆分而来：仅做搬移，未改动逻辑。
import { MediaPreviewDto, getMediaPreview } from "../api/media";
import { formatSize } from "../lib/format";
import { syncLiquidGlass } from "../liquid-glass";
import { loadModalThumbnail, previewAssetCache, previewPrefetchLimit, previewPrefetchQueue } from "../media/cache";
import { app } from "../render/context";
import { bindPreviewMetaEvents, render } from "../render/paint";
import { escapeHtml, formatDate, kindLabel } from "../render/text";
import { state } from "../state";
import { applyDialogSizes, setupDialogResizing } from "./dialogs";
import { renderMetaPanel } from "./preview/meta";
import { previewUi } from "./preview/state";

export let previewRequest = 0;

// Modal UI flags that must survive partial DOM updates (not full re-renders).
export let previewInfoOpen = false;

export let livePlaying = false;

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
  if (!stage) return;
  stage.querySelectorAll<HTMLImageElement>("img.modal-photo, img.live-still").forEach((img) => {
    if (img.classList.contains("modal-photo")) applyPhotoTransform(img);
    else applyVideoLikeTransform(img);
  });
  stage.querySelectorAll<HTMLElement>("video.live-motion, .video-stage video, video").forEach(applyVideoLikeTransform);
  stage.classList.toggle("is-zoomed", photoZoom.scale > 1.01);
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

export function handlePhotoWheel(event: WheelEvent): void {
  const stage = resolvePanRoot(event.currentTarget as HTMLElement | null);
  if (!stage) return;
  // Immersive: Ctrl/⌘ + wheel is the documented zoom gesture; plain wheel also
  // zooms because the pure stage has nothing else to scroll.
  event.preventDefault();
  const rect = stage.getBoundingClientRect();
  const cursorX = event.clientX - rect.left - rect.width / 2;
  const cursorY = event.clientY - rect.top - rect.height / 2;
  const factor = Math.exp(-event.deltaY * 0.0015);
  const next = clampPhotoZoom(photoZoom.scale * factor);
  if (Math.abs(next - photoZoom.scale) < 0.0001) return;
  const ratio = next / photoZoom.scale;
  photoZoom.x = cursorX - (cursorX - photoZoom.x) * ratio;
  photoZoom.y = cursorY - (cursorY - photoZoom.y) * ratio;
  photoZoom.scale = next;
  if (photoZoom.scale <= 1.01) {
    photoZoom.scale = 1;
    photoZoom.x = 0;
    photoZoom.y = 0;
  }
  applyPhotoTransformAll(stage);
}

export function handlePhotoDoubleClick(event: MouseEvent): void {
  const stage = resolvePanRoot(event.currentTarget as HTMLElement | null);
  if (!stage) return;
  event.preventDefault();
  if (photoZoom.scale > 1.01) {
    resetPhotoZoom();
    return;
  }
  const rect = stage.getBoundingClientRect();
  const cursorX = event.clientX - rect.left - rect.width / 2;
  const cursorY = event.clientY - rect.top - rect.height / 2;
  const next = 2;
  const ratio = next / photoZoom.scale;
  photoZoom.x = cursorX - (cursorX - photoZoom.x) * ratio;
  photoZoom.y = cursorY - (cursorY - photoZoom.y) * ratio;
  photoZoom.scale = next;
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

export function renderPreview(): string {
  if (state.previewIndex === null) return "";
  const item = state.page.items[state.previewIndex];
  if (!item) return "";
  const position = (state.previewIndex ?? 0) + 1;
  const immersiveClass = state.previewImmersive ? " is-immersive" : "";
  return `<div class="modal-backdrop${immersiveClass}" id="preview-modal"><div class="preview-modal${immersiveClass}" role="dialog" aria-modal="true" aria-label="${escapeHtml(item.displayName)}" ${state.previewImmersive ? 'data-liquid-glass="off"' : ""}>
    <header class="modal-header"><div class="modal-header-copy"><span class="modal-kind-pill">${kindLabel(item.kind)}</span><span class="modal-position">${position} / ${state.page.items.length}</span></div><div class="modal-header-actions"><button class="modal-close modal-fit-button" id="preview-fit" type="button" aria-label="按媒体尺寸自适应弹窗" title="按媒体尺寸自适应弹窗">⤢</button><button class="modal-close" id="close-preview" type="button" aria-label="关闭">×</button></div></header>
    <div class="modal-body">
      <div class="modal-stage"><button class="modal-nav prev" id="preview-prev" type="button" aria-label="上一个">‹</button><div class="modal-media" id="modal-media"><span class="spinner large"></span></div><button class="modal-nav next" id="preview-next" type="button" aria-label="下一个">›</button></div>
      <aside class="modal-meta ${previewInfoOpen ? "" : "is-hidden"}" id="modal-meta" aria-label="媒体信息" aria-hidden="${previewInfoOpen ? "false" : "true"}"><div class="meta-placeholder">加载中…</div></aside>
    </div>
    <footer class="modal-caption">
      <div class="modal-caption-copy"><strong>${escapeHtml(item.displayName)}</strong><span>${formatDate(item.captureDate)} · ${formatSize(item.totalSizeBytes)}${item.burstGroup ? " · 连拍" : ""}</span></div>
      <div class="modal-caption-tools">
        <div class="modal-actions">
          ${item.kind !== "live" ? `<button class="outline-button modal-tool-button" id="preview-edit" type="button">${item.kind === "video" ? "剪辑" : "编辑"}</button>` : ""}
          <button class="outline-button modal-tool-button" id="preview-info-toggle" type="button" aria-pressed="${previewInfoOpen}">信息</button>
          <button class="outline-button modal-tool-button" id="preview-fullscreen" type="button">全屏</button>
          <button class="outline-button modal-tool-button" id="preview-immersive" type="button" aria-pressed="${state.previewImmersive}">沉浸</button>
          <button class="outline-button modal-tool-button modal-folder-button" id="preview-open-folder" type="button" data-open-folder="${escapeHtml(item.id)}">打开文件夹</button>
        </div>
        <span class="modal-hint">← → 切换 · 拖动平移 · Ctrl+滚轮缩放 · F 全屏 · I 信息 · L 实况</span>
      </div>
    </footer>
    <button class="immersive-exit" id="preview-immersive-exit" type="button" aria-label="退出沉浸查看">退出沉浸</button>
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
        </div>
        <video class="live-motion" src="${video.url}" muted loop playsinline preload="metadata" hidden></video>
        <div class="live-controls">
          <button type="button" class="live-toggle" id="live-toggle" aria-pressed="false">实况</button>
          <span class="live-caption">默认显示静帧 · 点击「实况」或按 L / 长按画面播放短片</span>
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
        <div class="photo-zoom-hint" id="photo-zoom-hint">${state.previewImmersive ? "拖动平移 · Ctrl+滚轮缩放 · Esc 退出沉浸" : "滚轮缩放 · 拖动平移 · 双击放大 · F 全屏"}</div>
      </div>`;
      const stage = media.querySelector<HTMLElement>("#photo-stage");
      if (stage) {
        bindPhotoStage(stage);
        if (usePlaceholder) upgradeStillToOriginal(stage, photo.url, request);
      }
    } else {
      media.innerHTML = `<div class="preview-error"><span>当前文件不可用</span><button type="button" class="outline-button" id="preview-retry-media">重试</button></div>`;
    }
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

export function togglePreviewFullscreen(): void {
  const photoStage = app.querySelector<HTMLElement>("#modal-media .photo-stage");
  const video = activePreviewVideo() ?? app.querySelector<HTMLVideoElement>("#modal-media video");
  const target = photoStage ?? video;
  if (!target) return;
  if (document.fullscreenElement) {
    void document.exitFullscreen().catch(() => undefined);
    return;
  }
  void target.requestFullscreen().catch(() => undefined);
}

/** Pure media stage: no chrome, free pan, Ctrl+wheel resize. */
export function togglePreviewImmersive(force?: boolean): void {
  const next = typeof force === "boolean" ? force : !state.previewImmersive;
  state.previewImmersive = next;
  const backdrop = app.querySelector<HTMLElement>("#preview-modal");
  const modal = app.querySelector<HTMLElement>(".preview-modal");
  const button = app.querySelector<HTMLButtonElement>("#preview-immersive");
  backdrop?.classList.toggle("is-immersive", next);
  modal?.classList.toggle("is-immersive", next);
  if (modal) {
    if (next) modal.dataset.liquidGlass = "off";
    else delete modal.dataset.liquidGlass;
  }
  button?.setAttribute("aria-pressed", String(next));
  document.documentElement.classList.toggle("is-immersive-view", next);
  const hint = app.querySelector<HTMLElement>("#photo-zoom-hint");
  if (hint) {
    hint.textContent = next ? "拖动平移 · Ctrl+滚轮缩放 · Esc 退出沉浸" : "滚轮缩放 · 拖动平移 · 双击放大 · F 全屏";
  }
  if (!next) resetPhotoZoom();
  // Inline width/height would beat the immersive 100vw/100vh rules, so hand
  // geometry over when entering and take it back when leaving.
  applyDialogSizes();
  if (!next) setupDialogResizing();
  syncLiquidGlass();
}

export function togglePreviewInfo(): void {
  previewInfoOpen = !previewInfoOpen;
  const panel = app.querySelector<HTMLElement>("#modal-meta");
  const button = app.querySelector<HTMLButtonElement>("#preview-info-toggle");
  if (panel) {
    panel.classList.toggle("is-hidden", !previewInfoOpen);
    panel.setAttribute("aria-hidden", previewInfoOpen ? "false" : "true");
  }
  button?.setAttribute("aria-pressed", String(previewInfoOpen));
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
  document.documentElement.classList.remove("is-immersive-view");
  resetPhotoZoom();
  if (document.fullscreenElement) {
    void document.exitFullscreen().catch(() => undefined);
  }
  if (liveHoldTimer !== null) {
    window.clearTimeout(liveHoldTimer);
    liveHoldTimer = null;
  }
  render();
}

export function movePreview(delta: number): void {
  if (state.previewIndex === null || !state.page.items.length) return;
  state.previewIndex = (state.previewIndex + delta + state.page.items.length) % state.page.items.length;
  livePlaying = false;
  liveHoldActive = false;
  resetPhotoZoom();
  // The picker belongs to the previous item's tag block; start fresh.
  previewUi.tagPickerOpen = false;
  previewUi.tagPickerQuery = "";
  if (liveHoldTimer !== null) {
    window.clearTimeout(liveHoldTimer);
    liveHoldTimer = null;
  }
  // 换图会让预览容器按签名重建，重建钩子负责装载新图。
  render();
}

// Long-press (or press-and-hold) on the Live Photo still plays motion while held.
export let liveHoldTimer: number | null = null;

export let liveHoldActive = false;

app.addEventListener("pointerdown", (event) => {
  const still = (event.target as HTMLElement | null)?.closest?.("#modal-media .live-still");
  if (!still || livePlaying) return;
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
