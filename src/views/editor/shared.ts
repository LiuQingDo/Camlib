// 由 main.ts 拆分而来：仅做搬移，未改动逻辑。
import { app } from "../../render/context";
import { bindEditorFooterEvents } from "../../render/paint";
import { escapeHtml } from "../../render/text";
import { state } from "../../state";

// Editor interaction state lives outside AppState because drags update the DOM
// directly; re-rendering mid-drag would destroy the pointer gesture.
export type EditorDragState = {
  mode: "move" | "resize";
  handle: string;
  startX: number;
  startY: number;
  rect: { x: number; y: number; w: number; h: number };
  /** Canvas bounds cached at drag start; reading them per move forces layout. */
  bounds: { width: number; height: number };
};

/**
 * 编辑器交互状态。分开的 `let` 无法被多个子模块同时写，所以收在一个对象里：
 * photo/video/入口三个文件共享同一份可变引用。
 */
export const editorUi = {
  drag: null as EditorDragState | null,
  /** Latest pointer position; drags apply at most once per animation frame. */
  pointer: { x: 0, y: 0 },
  frame: null as number | null,
  imageEl: null as HTMLImageElement | null,
  // Per-open editor DOM refs; refreshed by bindEditorImageEvents, dropped on
  // close so a stale modal tree is never touched.
  cropBoxEl: null as HTMLElement | null,
  previewCanvasEl: null as HTMLCanvasElement | null,
  cropInfoEl: null as HTMLElement | null,
  shades: { top: null, bottom: null, left: null, right: null } as {
    top: HTMLElement | null;
    bottom: HTMLElement | null;
    left: HTMLElement | null;
    right: HTMLElement | null;
  },
  /**
   * Downscaled copy of the opened photo used by the preview canvas. Drawing the
   * crop preview from the full-resolution original forced the GPU to sample a
   * potentially 20MP+ texture on every frame, which is what dropped frames on
   * fast drags.
   */
  sourceBitmap: null as { el: CanvasImageSource; width: number; height: number } | null,
};

/** Latest pointer position; drags apply at most once per animation frame. */
// Per-open editor DOM refs; refreshed by bindEditorImageEvents, dropped on
// close so a stale modal tree is never touched.
/**
 * Downscaled copy of the opened photo used by the preview canvas. Drawing the
 * crop preview from the full-resolution original forced the GPU to sample a
 * potentially 20MP+ texture on every frame, which is what dropped frames on
 * fast drags.
 */
// ---------------------------------------------------------------------------
// Media editor (photo crop/rotate/adjust + video trim, save-on-copy)
// ---------------------------------------------------------------------------

/**
 * Fixed backing-store pixels of the square output-preview tile (2x the 220px
 * CSS size for HiDPI crispness); the canvas never reallocates per frame.
 */
export const EDITOR_PREVIEW_BACKING = 440;

/** Max source pixels fed to the preview sampler; built once per opened image. */
export const EDITOR_PREVIEW_SOURCE_MAX = 1400;

export const EDITOR_MIN_CROP = 0.02;

export const EDITOR_MIN_TRIM_MS = 100;

/** Step of the in/out nudge buttons under the trim track. */
export const EDITOR_NUDGE_MS = 100;

/** Length of a freshly added cut segment, clamped to the video duration. */
export const EDITOR_DEFAULT_SEGMENT_MS = 2000;

export const HEIC_MIME_TYPES = new Set(["image/heic", "image/heif"]);

export function editorFilterCss(): string {
  return `brightness(${state.editorBrightness}) contrast(${state.editorContrast}) saturate(${state.editorSaturation})`;
}

/** Re-render just the footer so progress updates never reset the editor stage. */
export function editorUpdateFooter(): void {
  const modal = app.querySelector<HTMLElement>("#editor-modal");
  const footer = modal?.querySelector<HTMLElement>("#editor-footer");
  if (!modal || !footer) return;
  footer.innerHTML = renderEditorFooter();
  bindEditorFooterEvents(modal);
}

/** Save button label: a single segment keeps the classic trim wording. */
export function editorSaveLabel(): string {
  if (state.editorKind === "image") return "保存为新副本";
  const count = state.editorSegments.length;
  if (count <= 1) return "开始剪辑";
  const mergeCount = state.editorSegments.filter((segment) => segment.merge).length;
  if (mergeCount >= 2) return `导出 ${count} 个片段并合并 ${mergeCount} 段`;
  return `导出 ${count} 个片段`;
}

/** Progress copy: segment position while cutting, merge once joining. */
export function editorRunningCopy(): string {
  const progress = state.editorProgress;
  if (progress?.phase === "finalizing") return "正在合并所选片段";
  if (progress?.segmentIndex != null && progress.segmentCount != null) {
    return `正在剪辑片段 ${progress.segmentIndex + 1}/${progress.segmentCount}`;
  }
  return "正在剪辑";
}

export function renderEditorFooter(): string {
  const busy = state.editorBusy || state.editorJobId !== null;
  const percent = state.editorProgress?.percent ?? null;
  const feedback = state.editorError
    ? `<span class="editor-error">${escapeHtml(state.editorError)}</span>`
    : state.editorNotice
      ? `<span class="editor-notice">${escapeHtml(state.editorNotice)}</span>`
      : state.editorJobId
        ? `<span class="editor-progress-copy">${editorRunningCopy()}${percent !== null ? ` ${Math.round(percent)}%` : "…"}（原视频不受影响）</span>`
        : `<span class="editor-hint">保存后生成新副本并自动入库，原文件保持不变。</span>`;
  return `<footer class="editor-footer" id="editor-footer">
    <div class="editor-feedback">${feedback}</div>
    ${state.editorJobId ? `<div class="progress-track${percent === null ? " is-indeterminate" : ""}"><span style="width:${percent ?? 100}%"></span></div>` : ""}
    <div class="editor-footer-actions">
      ${
        state.editorJobId
          ? `<button class="outline-button" id="editor-cancel-job" type="button">取消任务</button>`
          : `<button class="outline-button editor-close-button" type="button">关闭</button>`
      }
      <button class="primary-button" id="editor-save" type="button" ${busy || state.editorLoading ? "disabled" : ""}>${editorSaveLabel()}</button>
    </div>
  </footer>`;
}
