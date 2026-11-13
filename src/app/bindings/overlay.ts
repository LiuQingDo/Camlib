// 由 main.ts 拆分而来：仅做搬移，未改动逻辑。
import { cancelAiChat } from "../../api/ai";
import { app, bind, bindAll } from "../../render/context";
import { bindMergeModalEvents, bindSettingsEvents, openSettings, render } from "../../render/paint";
import { patchToolbar, searchUi } from "../../render/toolbar";
import { state } from "../../state";
import { aiChatUi, autoGrowAiChatInput, closeAiChatDrawer, sendAiChatMessage } from "../../views/ai-chat";
import { adaptDialogToMedia } from "../../views/dialogs";
import { openEditor } from "../../views/editor";
import {
  closePreview,
  movePreview,
  togglePreviewFullscreen,
  togglePreviewImmersive,
  togglePreviewInfo,
} from "../../views/preview";
import { cancelDeleteConfirm, openFolderForItem, runConfirmedDelete } from "../media-ops";
import { bindTagManagerEvents } from "./dialogs";
import { bindEditorEvents } from "./editor";
import { commitSemanticSearch } from "./toolbar";

/** 弹窗区：预览 / 删除确认 / AI 抽屉 / 编辑器 / 合并 / 标签管理 / 设置。 */
export function bindOverlayEvents(): void {
  bind(app.querySelector("#close-preview"), "click", closePreview);
  // 实况默认展示静帧：优先取视频帧尺寸（未就绪时内部等待元数据），否则取静帧图片。
  bind(app.querySelector("#preview-fit"), "click", () => {
    const media = app.querySelector<HTMLElement>("#modal-media");
    const video = media?.querySelector<HTMLVideoElement>("video:not([hidden])");
    adaptDialogToMedia("preview", video ?? media?.querySelector<HTMLImageElement>("img") ?? null);
  });
  bind(app.querySelector("#preview-modal"), "click", (event) => {
    if (event.target === event.currentTarget) closePreview();
  });
  bind(app.querySelector("#preview-prev"), "click", () => movePreview(-1));
  bind(app.querySelector("#preview-next"), "click", () => movePreview(1));
  bind(app.querySelector("#preview-edit"), "click", () => {
    const item = state.previewIndex === null ? undefined : state.page.items[state.previewIndex];
    if (item) void openEditor(item);
  });
  bind(app.querySelector("#preview-info-toggle"), "click", () => togglePreviewInfo());
  bind(app.querySelector("#preview-fullscreen"), "click", () => togglePreviewFullscreen());
  bind(app.querySelector("#preview-immersive"), "click", () => togglePreviewImmersive());
  // Immersive exit is a leave-viewer action: return to the grid, not the framed modal.
  bind(app.querySelector("#preview-immersive-exit"), "click", () => closePreview());
  bind(app.querySelector("#cancel-delete-confirm"), "click", cancelDeleteConfirm);
  bind(app.querySelector("#cancel-delete-confirm-footer"), "click", cancelDeleteConfirm);
  bind(app.querySelector("#confirm-delete"), "click", () => void runConfirmedDelete());
  bind(app.querySelector("#delete-confirm-modal"), "click", (event) => {
    if (event.target === event.currentTarget) cancelDeleteConfirm();
  });
  bindAll("[data-open-folder]", "click", (event) => {
    event.stopPropagation();
    const folder = (event.currentTarget as HTMLElement).dataset.openFolder;
    if (folder) void openFolderForItem(folder);
  });
  // AI 助手抽屉。
  bind(app.querySelector("#ai-chat-close"), "click", () => closeAiChatDrawer());
  bind(app.querySelector("#ai-chat-goto-settings"), "click", () => void openSettings("ai"));
  bind(app.querySelector("#ai-chat-clear"), "click", () => {
    if (state.aiChatBusy) return;
    state.aiChatMessages = [];
    render();
  });
  bind(app.querySelector("#ai-chat-send"), "click", () => void sendAiChatMessage());
  bind(app.querySelector("#ai-chat-stop"), "click", () => {
    // Rust 在下一个 delta 处停下，部分回复会随命令结果返回。
    void cancelAiChat();
  });
  bindAll("[data-chat-search]", "click", (event) => {
    const query = ((event.currentTarget as HTMLElement).dataset.chatSearch || "").trim();
    if (!query) return;
    // 先让语义输入框渲染出查询词，commitSemanticSearch 才能取到。
    searchUi.semantic = query;
    state.filtersExpanded = true;
    patchToolbar();
    commitSemanticSearch();
  });
  const chatInput = app.querySelector<HTMLTextAreaElement>("#ai-chat-input");
  if (chatInput) {
    chatInput.value = aiChatUi.draft;
    bind(chatInput, "input", () => {
      aiChatUi.draft = chatInput.value;
      autoGrowAiChatInput(chatInput);
    });
    bind(chatInput, "keydown", (event) => {
      const keyEvent = event as KeyboardEvent;
      if (keyEvent.key === "Enter" && !keyEvent.shiftKey) {
        event.preventDefault();
        void sendAiChatMessage();
      }
    });
  }
  if (state.editorOpen) bindEditorEvents();
  bindMergeModalEvents();
  bindTagManagerEvents();
  bindSettingsEvents();
}
