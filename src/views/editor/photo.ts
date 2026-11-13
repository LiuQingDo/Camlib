// 由 main.ts 拆分而来：仅做搬移，未改动逻辑。
import { app } from "../../render/context";
import { state } from "../../state";
import {
  EDITOR_MIN_CROP,
  EDITOR_PREVIEW_BACKING,
  EDITOR_PREVIEW_SOURCE_MAX,
  editorFilterCss,
  editorUi,
} from "./shared";

export function renderEditorImageBody(): string {
  return `<div class="editor-workbench">
    <div class="editor-stage-wrap"><div class="editor-stage" id="editor-stage">${
      state.editorLoading
        ? `<span class="spinner large"></span>`
        : `<div class="editor-canvas" id="editor-canvas"><img id="editor-image" src="${state.editorSourceUrl}" alt="" draggable="false" decoding="async" /><div class="crop-shades" aria-hidden="true"><span class="crop-shade shade-top"></span><span class="crop-shade shade-bottom"></span><span class="crop-shade shade-left"></span><span class="crop-shade shade-right"></span></div><div class="crop-box" id="crop-box"><span class="crop-grid"></span>${["nw", "n", "ne", "e", "se", "s", "sw", "w"].map((handle) => `<span class="crop-handle handle-${handle}" data-handle="${handle}"></span>`).join("")}</div></div>`
    }</div></div>
    <aside class="editor-tools">
      <div class="editor-tool-group"><span class="editor-tool-label">旋转 / 翻转</span>
        <div class="editor-tool-grid">
          <button class="editor-tool-tile" id="editor-rotate-left" type="button"><span class="editor-tool-icon">↺</span><span>左旋</span></button>
          <button class="editor-tool-tile" id="editor-rotate-right" type="button"><span class="editor-tool-icon">↻</span><span>右旋</span></button>
          <button class="editor-tool-tile" id="editor-flip-h" type="button"><span class="editor-tool-icon">⇋</span><span>水平</span></button>
          <button class="editor-tool-tile" id="editor-flip-v" type="button"><span class="editor-tool-icon">⇅</span><span>垂直</span></button>
        </div>
      </div>
      <div class="editor-tool-group"><span class="editor-tool-label">裁剪</span>
        <div class="editor-tool-row"><button class="outline-button" id="editor-crop-reset" type="button">重置裁剪</button><span class="editor-hint editor-crop-info" id="editor-crop-info"></span></div>
        <span class="editor-hint">拖动裁剪框边缘调整范围，框内拖动移动位置。</span>
      </div>
      <div class="editor-tool-group"><span class="editor-tool-label">调整</span>
        ${renderEditorSlider("亮度", "editor-brightness", 0.3, 2, state.editorBrightness)}
        ${renderEditorSlider("对比度", "editor-contrast", 0.5, 1.5, state.editorContrast)}
        ${renderEditorSlider("饱和度", "editor-saturation", 0, 2, state.editorSaturation)}
        <button class="text-button" id="editor-adjust-reset" type="button">还原全部调整</button>
      </div>
      <div class="editor-tool-group is-output"><span class="editor-tool-label">输出预览</span>
        <div class="editor-output-wrap"><canvas id="editor-output" width="${EDITOR_PREVIEW_BACKING}" height="${EDITOR_PREVIEW_BACKING}"></canvas></div>
      </div>
    </aside>
  </div>`;
}

export function renderEditorSlider(label: string, id: string, min: number, max: number, value: number): string {
  return `<label class="editor-slider" title="双击还原默认值"><span class="editor-slider-head"><span>${label}</span><strong class="editor-slider-value" id="${id}-value">${value.toFixed(2)}</strong></span><input type="range" id="${id}" min="${min}" max="${max}" step="0.01" value="${value}" /></label>`;
}

// --- image editor ----------------------------------------------------------

export function bindEditorImageEvents(modal: HTMLElement): void {
  const image = modal.querySelector<HTMLImageElement>("#editor-image");
  const canvasBox = modal.querySelector<HTMLElement>("#editor-canvas");
  editorUi.imageEl = image;
  editorUi.cropBoxEl = modal.querySelector<HTMLElement>("#crop-box");
  editorUi.previewCanvasEl = modal.querySelector<HTMLCanvasElement>("#editor-output");
  editorUi.cropInfoEl = modal.querySelector<HTMLElement>("#editor-crop-info");
  const shades = modal.querySelector<HTMLElement>(".crop-shades");
  editorUi.shades = {
    top: shades?.querySelector<HTMLElement>(".shade-top") ?? null,
    bottom: shades?.querySelector<HTMLElement>(".shade-bottom") ?? null,
    left: shades?.querySelector<HTMLElement>(".shade-left") ?? null,
    right: shades?.querySelector<HTMLElement>(".shade-right") ?? null,
  };
  const onImageReady = (): void => {
    editorBuildSourceBitmap();
    state.editorCrop = { x: 0, y: 0, w: 1, h: 1 };
    editorSyncCropBox();
    editorSyncFilter();
    redrawEditorPreview();
    editorUpdateCropInfo();
  };
  image?.addEventListener("load", onImageReady);
  if (image?.complete) onImageReady();
  const startDrag = (event: PointerEvent, mode: "move" | "resize", handle: string): void => {
    if (!canvasBox || editorUi.drag) return;
    event.preventDefault();
    event.stopPropagation();
    // Cache the canvas bounds once: a getBoundingClientRect on every pointer
    // move would force synchronous layout each event.
    const bounds = canvasBox.getBoundingClientRect();
    editorUi.pointer = { x: event.clientX, y: event.clientY };
    editorUi.drag = {
      mode,
      handle,
      startX: event.clientX,
      startY: event.clientY,
      rect: { ...state.editorCrop },
      bounds: { width: bounds.width, height: bounds.height },
    };
    canvasBox.setPointerCapture?.(event.pointerId);
  };
  modal.querySelector<HTMLElement>("#crop-box")?.addEventListener("pointerdown", (event) => {
    const handle = (event.target as HTMLElement).dataset?.handle;
    if (handle) startDrag(event, "resize", handle);
    else startDrag(event, "move", "move");
  });
  modal.addEventListener("pointermove", (event) => {
    if (!editorUi.drag) return;
    editorUi.pointer = { x: event.clientX, y: event.clientY };
    // Light path: style writes only (bounds are cached, so no layout reads).
    // Chromium coalesces these into one layout per frame anyway, and applying
    // immediately keeps the box glued to fast-moving cursors.
    editorApplyDragGeometry();
    // Heavy path: preview redraw + info label at most once per frame.
    if (editorUi.frame !== null) return;
    editorUi.frame = requestAnimationFrame(() => {
      editorUi.frame = null;
      if (editorUi.drag) editorRefreshPreview();
    });
  });
  const endDrag = (): void => {
    if (editorUi.frame !== null) {
      cancelAnimationFrame(editorUi.frame);
      editorUi.frame = null;
    }
    if (editorUi.drag) {
      // Final flush so the box and preview land exactly under the pointer.
      editorApplyDragGeometry();
      editorRefreshPreview();
    }
    editorUi.drag = null;
  };
  modal.addEventListener("pointerup", endDrag);
  modal.addEventListener("pointercancel", endDrag);

  modal.querySelector<HTMLButtonElement>("#editor-rotate-left")?.addEventListener("click", () => {
    state.editorRotate90 = (state.editorRotate90 + 3) % 4;
    redrawEditorPreview();
    editorUpdateCropInfo();
  });
  modal.querySelector<HTMLButtonElement>("#editor-rotate-right")?.addEventListener("click", () => {
    state.editorRotate90 = (state.editorRotate90 + 1) % 4;
    redrawEditorPreview();
    editorUpdateCropInfo();
  });
  modal.querySelector<HTMLButtonElement>("#editor-flip-h")?.addEventListener("click", () => {
    state.editorFlipH = !state.editorFlipH;
    redrawEditorPreview();
  });
  modal.querySelector<HTMLButtonElement>("#editor-flip-v")?.addEventListener("click", () => {
    state.editorFlipV = !state.editorFlipV;
    redrawEditorPreview();
  });
  modal.querySelector<HTMLButtonElement>("#editor-crop-reset")?.addEventListener("click", () => {
    state.editorCrop = { x: 0, y: 0, w: 1, h: 1 };
    editorSyncCropBox();
    redrawEditorPreview();
    editorUpdateCropInfo();
  });
  const setSlider = (id: string, value: number): void => {
    if (id === "editor-brightness") state.editorBrightness = value;
    else if (id === "editor-contrast") state.editorContrast = value;
    else state.editorSaturation = value;
    const input = modal.querySelector<HTMLInputElement>(`#${id}`);
    if (input) input.value = String(value);
    const label = modal.querySelector<HTMLElement>(`#${id}-value`);
    if (label) label.textContent = value.toFixed(2);
  };
  modal.querySelector<HTMLButtonElement>("#editor-adjust-reset")?.addEventListener("click", () => {
    for (const id of ["editor-brightness", "editor-contrast", "editor-saturation"]) setSlider(id, 1);
    editorSyncFilter();
    redrawEditorPreview();
  });
  for (const id of ["editor-brightness", "editor-contrast", "editor-saturation"]) {
    const input = modal.querySelector<HTMLInputElement>(`#${id}`);
    input?.addEventListener("input", (event) => {
      setSlider(id, Number((event.target as HTMLInputElement).value));
      editorSyncFilter();
      redrawEditorPreview();
    });
    // Double-click anywhere on the slider row restores the neutral value.
    input?.closest(".editor-slider")?.addEventListener("dblclick", () => {
      setSlider(id, 1);
      editorSyncFilter();
      redrawEditorPreview();
    });
  }
}

/**
 * Light drag step: recompute the crop rect and write the box/shade styles.
 * Runs on every pointermove — style writes are cheap and Chromium coalesces
 * them into one layout per frame, and with bounds cached there are no layout
 * reads, so fast cursors never wait on the preview redraw.
 */
export function editorApplyDragGeometry(): void {
  const drag = editorUi.drag;
  if (!drag) return;
  const bounds = drag.bounds;
  if (bounds.width <= 0 || bounds.height <= 0) return;
  const dx = (editorUi.pointer.x - drag.startX) / bounds.width;
  const dy = (editorUi.pointer.y - drag.startY) / bounds.height;
  const base = drag.rect;
  const min = EDITOR_MIN_CROP;
  let next: typeof state.editorCrop;
  if (drag.mode === "move") {
    next = {
      x: Math.min(Math.max(0, base.x + dx), 1 - base.w),
      y: Math.min(Math.max(0, base.y + dy), 1 - base.h),
      w: base.w,
      h: base.h,
    };
  } else {
    let x1 = base.x;
    let y1 = base.y;
    let x2 = base.x + base.w;
    let y2 = base.y + base.h;
    if (drag.handle.includes("w")) x1 = Math.min(Math.max(0, base.x + dx), x2 - min);
    if (drag.handle.includes("e")) x2 = Math.max(Math.min(1, base.x + base.w + dx), x1 + min);
    if (drag.handle.includes("n")) y1 = Math.min(Math.max(0, base.y + dy), y2 - min);
    if (drag.handle.includes("s")) y2 = Math.max(Math.min(1, base.y + base.h + dy), y1 + min);
    next = { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
  }
  state.editorCrop = next;
  editorSyncCropBox();
}

/**
 * Crop box uses percentage positioning. The dark surround is four scale-
 * transformed shade rects: transforms stay on the compositor, while the old
 * `box-shadow: 0 0 0 9999px` trick repainted the whole glass modal per frame.
 */
export function editorSyncCropBox(): void {
  const box = editorUi.cropBoxEl ?? app.querySelector<HTMLElement>("#crop-box");
  if (!box) return;
  const { x, y, w, h } = state.editorCrop;
  box.style.left = `${x * 100}%`;
  box.style.top = `${y * 100}%`;
  box.style.width = `${w * 100}%`;
  box.style.height = `${h * 100}%`;
  const { top, bottom, left, right } = editorUi.shades;
  if (top) top.style.transform = `scaleY(${Math.max(0, y)})`;
  if (bottom) bottom.style.transform = `scaleY(${Math.max(0, 1 - y - h)})`;
  if (left) left.style.transform = `scaleX(${Math.max(0, x)})`;
  if (right) right.style.transform = `scaleX(${Math.max(0, 1 - x - w)})`;
}

export function editorSyncFilter(): void {
  const image = editorUi.imageEl ?? app.querySelector<HTMLImageElement>("#editor-image");
  if (!image) return;
  // Neutral sliders need no CSS filter; skipping it keeps the img cheap to
  // repaint while dragging (filters force an extra compositing pass).
  const neutral = state.editorBrightness === 1 && state.editorContrast === 1 && state.editorSaturation === 1;
  image.style.filter = neutral ? "" : editorFilterCss();
}

export function editorUpdateCropInfo(): void {
  const image = editorUi.imageEl;
  const label = editorUi.cropInfoEl ?? app.querySelector<HTMLElement>("#editor-crop-info");
  if (!image?.naturalWidth || !label) return;
  const cropW = Math.round(state.editorCrop.w * image.naturalWidth);
  const cropH = Math.round(state.editorCrop.h * image.naturalHeight);
  const swap = state.editorRotate90 % 2 === 1;
  const outW = swap ? cropH : cropW;
  const outH = swap ? cropW : cropH;
  const flips = state.editorFlipH || state.editorFlipV ? " · 已翻转" : "";
  label.textContent = `输出约 ${outW} × ${outH}px${flips}`;
}

/**
 * Downscale the opened photo once so preview redraws sample a small bitmap
 * instead of the full-resolution original texture on every drag frame.
 */
export function editorBuildSourceBitmap(): void {
  editorUi.sourceBitmap = null;
  const image = editorUi.imageEl;
  if (!image?.naturalWidth) return;
  const natW = image.naturalWidth;
  const natH = image.naturalHeight;
  const scale = Math.min(1, EDITOR_PREVIEW_SOURCE_MAX / Math.max(natW, natH));
  if (scale >= 1) {
    // Small enough to sample directly.
    editorUi.sourceBitmap = { el: image, width: natW, height: natH };
    return;
  }
  const bitmap = document.createElement("canvas");
  bitmap.width = Math.max(1, Math.round(natW * scale));
  bitmap.height = Math.max(1, Math.round(natH * scale));
  const ctx = bitmap.getContext("2d");
  if (!ctx) {
    editorUi.sourceBitmap = { el: image, width: natW, height: natH };
    return;
  }
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(image, 0, 0, bitmap.width, bitmap.height);
  editorUi.sourceBitmap = { el: bitmap, width: bitmap.width, height: bitmap.height };
}

/**
 * Live preview canvas: crop → rotate → flip → CSS-equivalent adjustments,
 * letterboxed inside a fixed square backing store. The backing store is never
 * resized here, so dragging reallocates nothing and only the pixels change.
 */
export function redrawEditorPreview(): void {
  const source = editorUi.sourceBitmap;
  const canvas = editorUi.previewCanvasEl ?? app.querySelector<HTMLCanvasElement>("#editor-output");
  if (!source || !canvas) return;
  const srcW = source.width;
  const srcH = source.height;
  if (!srcW || !srcH) return;
  const { x, y, w, h } = state.editorCrop;
  const sx = x * srcW;
  const sy = y * srcH;
  const sw = Math.max(1, w * srcW);
  const sh = Math.max(1, h * srcH);
  const rot = state.editorRotate90 % 4;
  const swap = rot % 2 === 1;
  const finalW = swap ? sh : sw;
  const finalH = swap ? sw : sh;
  // Keep a small margin inside the fixed square so rotated content never
  // touches the tile border.
  const scale = Math.min((EDITOR_PREVIEW_BACKING * 0.96) / finalW, (EDITOR_PREVIEW_BACKING * 0.96) / finalH);
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.save();
  const neutral = state.editorBrightness === 1 && state.editorContrast === 1 && state.editorSaturation === 1;
  if (!neutral) ctx.filter = editorFilterCss();
  // Transforms compose in reverse declaration order, so the drawn pixels go
  // rescale → rotate → flip — exactly the backend pipeline order.
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.scale(state.editorFlipH ? -1 : 1, state.editorFlipV ? -1 : 1);
  ctx.rotate((rot * Math.PI) / 2);
  ctx.scale(scale, scale);
  ctx.drawImage(source.el, sx, sy, sw, sh, -sw / 2, -sh / 2, sw, sh);
  ctx.restore();
}

/** Heavy drag step: preview canvas + info label, at most once per frame. */
export function editorRefreshPreview(): void {
  redrawEditorPreview();
  editorUpdateCropInfo();
}
