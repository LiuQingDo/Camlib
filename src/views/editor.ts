// 由 main.ts 拆分而来：仅做搬移，未改动逻辑。
import { toUserMessage } from "../api/errors";
import { MediaItemDto, cancelEditJob } from "../api/media";
import { loadModalThumbnail } from "../media/cache";
import { render } from "../render/paint";
import { escapeHtml } from "../render/text";
import { state } from "../state";
import { renderEditorImageBody } from "./editor/photo";
import { HEIC_MIME_TYPES, editorUi, renderEditorFooter } from "./editor/shared";
import { renderEditorVideoBody } from "./editor/video";
import { pausePreviewPlayback, requestPreview } from "./preview";

export function resetEditorImageOps(): void {
  state.editorCrop = { x: 0, y: 0, w: 1, h: 1 };
  state.editorRotate90 = 0;
  state.editorFlipH = false;
  state.editorFlipV = false;
  state.editorBrightness = 1;
  state.editorContrast = 1;
  state.editorSaturation = 1;
}

/** 编辑器弹窗尚未增量化：打开 / 载入源 / 出错各重建一次容器。 */
export async function openEditor(item: MediaItemDto): Promise<void> {
  // The editor stacks on top of the preview viewer; stop the media behind it.
  pausePreviewPlayback();
  state.editorOpen = true;
  state.editorItem = item;
  state.editorKind = item.kind === "video" ? "video" : "image";
  state.editorLoading = true;
  state.editorBusy = false;
  state.editorError = null;
  state.editorNotice = null;
  state.editorJobId = null;
  state.editorProgress = null;
  state.editorPrecise = false;
  state.editorSourceUrl = "";
  resetEditorImageOps();
  state.editorSegments = [{ inMs: 0, outMs: 0, merge: false }];
  state.editorActiveSegment = 0;
  state.editorDurationMs = 0;
  editorUi.imageEl = null;
  editorUi.sourceBitmap = null;
  editorUi.drag = null;
  render();
  try {
    const preview = await requestPreview(item.id);
    if (!state.editorOpen || state.editorItem?.id !== item.id) return;
    let url = "";
    if (state.editorKind === "video") {
      url =
        preview.sources.find(
          (source) => source.role === "video" || (source.role === "single" && source.mimeType.startsWith("video/")),
        )?.url ?? "";
    } else {
      const photo = preview.sources.find(
        (source) => source.role === "photo" || (source.role === "single" && !source.mimeType.startsWith("video/")),
      );
      url = photo?.url ?? "";
      if (photo && HEIC_MIME_TYPES.has(photo.mimeType)) {
        // The webview cannot decode HEIC; edit against the JPEG thumbnail copy.
        const thumb = await loadModalThumbnail(item.id).catch(() => undefined);
        url = thumb?.url ?? url;
      }
    }
    if (!url) throw new Error("没有可编辑的源文件");
    state.editorSourceUrl = url;
    state.editorLoading = false;
    render();
  } catch (error) {
    if (!state.editorOpen) return;
    state.editorLoading = false;
    state.editorError = toUserMessage(error, "无法打开编辑器");
    render();
  }
}

export function closeEditor(): void {
  // Never orphan a running trim: closing the editor cancels the job.
  if (state.editorJobId) void cancelEditJob(state.editorJobId).catch(() => undefined);
  state.editorOpen = false;
  state.editorItem = null;
  state.editorSourceUrl = "";
  state.editorLoading = false;
  state.editorBusy = false;
  state.editorError = null;
  state.editorNotice = null;
  state.editorJobId = null;
  state.editorProgress = null;
  editorUi.imageEl = null;
  editorUi.drag = null;
  editorUi.cropBoxEl = null;
  editorUi.previewCanvasEl = null;
  editorUi.cropInfoEl = null;
  editorUi.shades = { top: null, bottom: null, left: null, right: null };
  editorUi.sourceBitmap = null;
  render();
}

export function renderEditor(): string {
  if (!state.editorItem) return "";
  const body = state.editorKind === "image" ? renderEditorImageBody() : renderEditorVideoBody();
  return `<div class="modal-backdrop editor-backdrop" id="editor-modal"><div class="editor-modal" role="dialog" aria-modal="true" aria-label="媒体编辑">
    <header class="modal-header"><div class="modal-header-copy"><span class="modal-kind-pill">${state.editorKind === "image" ? "图片编辑" : "视频剪辑"}</span><span class="modal-position">${escapeHtml(state.editorItem.displayName)}</span></div><div class="modal-header-actions"><button class="modal-close modal-fit-button" id="editor-fit" type="button" aria-label="按媒体尺寸自适应弹窗" title="按媒体尺寸自适应弹窗">⤢</button><button class="modal-close editor-close-button" type="button" aria-label="关闭">×</button></div></header>
    <div class="editor-body">${body}</div>
    ${renderEditorFooter()}
  </div></div>`;
}
