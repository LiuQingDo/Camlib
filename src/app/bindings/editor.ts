// 由 main.ts 拆分而来：仅做搬移，未改动逻辑。
import { toUserMessage } from "../../api/errors";
import {
  EditResultDto,
  VideoMergeResultDto,
  cancelEditJob,
  editImage,
  startVideoCutSegments,
  startVideoTrim,
} from "../../api/media";
import { app } from "../../render/context";
import { render } from "../../render/paint";
import { state } from "../../state";
import { adaptDialogToMedia } from "../../views/dialogs";
import { closeEditor } from "../../views/editor";
import { bindEditorImageEvents } from "../../views/editor/photo";
import { EDITOR_MIN_TRIM_MS, editorUi, editorUpdateFooter } from "../../views/editor/shared";
import { bindEditorVideoEvents } from "../../views/editor/video";
import { refreshMedia } from "../media-query";
import { showTransientNotice } from "../ui";

export function bindEditorEvents(): void {
  const modal = app.querySelector<HTMLElement>("#editor-modal");
  if (!modal) return;
  if (modal.dataset.boundRegion === "1") return;
  modal.dataset.boundRegion = "1";
  modal.querySelectorAll<HTMLButtonElement>(".editor-close-button").forEach((button) => {
    button.addEventListener("click", closeEditor);
  });
  modal.addEventListener("click", (event) => {
    if (event.target === modal) closeEditor();
  });
  if (state.editorKind === "image") bindEditorImageEvents(modal);
  else bindEditorVideoEvents(modal);
  bindEditorFooterEvents(modal);
  modal.querySelector<HTMLButtonElement>("#editor-fit")?.addEventListener("click", () => {
    adaptDialogToMedia(
      "editor",
      state.editorKind === "image" ? editorUi.imageEl : modal.querySelector<HTMLVideoElement>("#editor-video"),
    );
  });
}

export function bindEditorFooterEvents(modal: HTMLElement): void {
  modal.querySelector<HTMLButtonElement>("#editor-cancel-job")?.addEventListener("click", () => {
    if (state.editorJobId) void cancelEditJob(state.editorJobId).catch(() => undefined);
  });
  modal.querySelector<HTMLButtonElement>("#editor-save")?.addEventListener("click", () => {
    if (state.editorKind === "image") void saveImageEdit();
    else void saveVideoCut();
  });
}

export async function saveImageEdit(): Promise<void> {
  const item = state.editorItem;
  if (!item || state.editorBusy || state.editorJobId) return;
  state.editorBusy = true;
  state.editorError = null;
  editorUpdateFooter();
  try {
    const result = await editImage(item.id, {
      crop: state.editorCrop,
      rotate90: state.editorRotate90,
      flipH: state.editorFlipH,
      flipV: state.editorFlipV,
      brightness: state.editorBrightness,
      contrast: state.editorContrast,
      saturation: state.editorSaturation,
    });
    handleEditSaved(result);
  } catch (error) {
    state.editorError = toUserMessage(error, "保存编辑失败");
  } finally {
    state.editorBusy = false;
    editorUpdateFooter();
  }
}

export async function saveVideoCut(): Promise<void> {
  const item = state.editorItem;
  if (!item || state.editorBusy || state.editorJobId) return;
  if (state.editorSegments.some((segment) => segment.outMs - segment.inMs < EDITOR_MIN_TRIM_MS)) {
    state.editorError = "存在太短的片段，请调整入点/出点";
    editorUpdateFooter();
    return;
  }
  const mergeCount = state.editorSegments.filter((segment) => segment.merge).length;
  if (state.editorSegments.length > 1 && mergeCount === 1) {
    state.editorError = "合并至少需要勾选两个片段";
    editorUpdateFooter();
    return;
  }
  state.editorBusy = true;
  state.editorError = null;
  try {
    // A single segment keeps the classic trim path (and `{stem}_edited` name);
    // one segment alone can never merge.
    const single = state.editorSegments.length === 1;
    const start = single
      ? await startVideoTrim(item.id, {
          inMs: state.editorSegments[0].inMs,
          outMs: state.editorSegments[0].outMs,
          precise: state.editorPrecise,
        })
      : await startVideoCutSegments(
          item.id,
          state.editorSegments.map((segment) => ({ ...segment })),
          state.editorPrecise,
        );
    state.editorJobId = start.jobId;
    state.editorProgress = {
      jobId: start.jobId,
      kind: "trim",
      phase: "preparing",
      state: "running",
      percent: null,
      error: null,
      result: null,
    };
  } catch (error) {
    state.editorError = toUserMessage(error, "无法开始剪辑");
  } finally {
    state.editorBusy = false;
    editorUpdateFooter();
  }
}

export function handleEditSaved(result: EditResultDto): void {
  const message = `已保存为 ${result.fileName}，正在自动入库`;
  showTransientNotice(message, "success");
  closeEditor();
  void refreshMedia();
  // The incremental scan takes a moment; refresh again once it has landed so
  // the new copy shows up without manual interaction.
  window.setTimeout(() => void refreshMedia(), 2500);
}

export function handleCutCompleted(results: EditResultDto[], merged: EditResultDto | null): void {
  const message = merged
    ? `已导出 ${results.length} 个片段并合并为 ${merged.fileName}，正在自动入库`
    : `已导出 ${results.length} 个片段（${results.map((result) => result.fileName).join("、")}），正在自动入库`;
  showTransientNotice(message, "success");
  closeEditor();
  void refreshMedia();
  // The incremental scan takes a moment; refresh again once it has landed so
  // the new copies show up without manual interaction.
  window.setTimeout(() => void refreshMedia(), 2500);
}

export function handleMergeCompleted(result: VideoMergeResultDto): void {
  const message = `已合并为 ${result.fileName}，正在自动入库`;
  showTransientNotice(message, "success");
  state.mergeModalOpen = false;
  state.mergeItems = [];
  state.mergeProgress = null;
  state.mergeError = null;
  state.mergeNotice = null;
  render();
  void refreshMedia();
  // The incremental scan takes a moment; refresh again once it has landed so
  // the merged copy shows up without manual interaction.
  window.setTimeout(() => void refreshMedia(), 2500);
}
