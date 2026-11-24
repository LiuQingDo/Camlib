// 由 main.ts 拆分而来：仅做搬移，未改动逻辑。
import { cancelAiChat } from "../../api/ai";
import { app, bind, bindAll } from "../../render/context";
import { bindMergeModalEvents, bindSettingsEvents, openSettings, render } from "../../render/paint";
import { searchUi } from "../../render/toolbar";
import { state } from "../../state";
import { aiChatUi, autoGrowAiChatInput, closeAiChatDrawer, sendAiChatMessage } from "../../views/ai-chat";
import { openEditor } from "../../views/editor";
import {
  closePreview,
  navigatePreview,
  toggleFocusMode,
  togglePreviewHintPopover,
  togglePreviewInfo,
} from "../../views/preview";
import { closeDeletedPanel, loadDeletedItems, openDeletedItemFolder } from "../deleted-ops";
import { cancelDeleteConfirm, openFolderForItem, runConfirmedDelete } from "../media-ops";
import { bindTagManagerEvents } from "./dialogs";
import { bindEditorEvents } from "./editor";
import { commitSemanticSearch } from "./toolbar";

/** 弹窗区：预览 / 删除确认 / AI 抽屉 / 编辑器 / 合并 / 标签管理 / 设置。 */
export function bindOverlayEvents(): void {
  bind(app.querySelector("#close-preview"), "click", closePreview);
  bind(app.querySelector("#preview-modal"), "click", (event) => {
    if (event.target === event.currentTarget) closePreview();
  });
  bind(app.querySelector("#preview-prev"), "click", () => void navigatePreview(-1));
  bind(app.querySelector("#preview-next"), "click", () => void navigatePreview(1));
  // TODO(14)：编辑器目前仍是独立 overlay。目标形态是预览内 viewMode: "view" | "edit"
  // 切换（保存后就地替换当前图并 toast），这样「编辑」不用先关预览、也不用第二套
  // 焦点陷阱。改动横跨 views/editor 与 orchestrate 的弹窗装配，本次先保持现状。
  bind(app.querySelector("#preview-edit"), "click", () => {
    const item = state.previewIndex === null ? undefined : state.page.items[state.previewIndex];
    if (item) void openEditor(item);
  });
  bind(app.querySelector("#preview-info-toggle"), "click", () => togglePreviewInfo());
  bind(app.querySelector("#preview-focus"), "click", () => toggleFocusMode());
  bind(app.querySelector("#preview-hint-more"), "click", () => togglePreviewHintPopover());
  // 专注视图是「隐藏 chrome」而不是离开预览：浮动按钮只退出专注，不关弹窗。
  bind(app.querySelector("#preview-focus-exit"), "click", () => toggleFocusMode(false));
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
    // 搜索框只有一个：写进语义草稿，commitSemanticSearch 会切到 AI 模式并把词
    // 回填到输入框（不再需要先展开折叠筛选层）。
    searchUi.semantic = query;
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

/**
 * 「已删除」浮层的绑定。
 *
 * 不能塞进 bindOverlayEvents()：那个函数只在启动与整体重建时跑，而浮层内容是
 * 「点开」那一刻才 patch 进空容器的——那时页面上还没有 #close-deleted，`bind()`
 * 对 null 静默返回，于是 ×、页脚「关闭」、点遮罩三个关闭入口全是死按钮。
 * 改由 patchDeletedOverlay() 在每次重建 DOM 之后调用，绑到的必然是刚插入的节点；
 * `bind()` 自带节点级幂等标记，重建后重绑不会叠加监听器。
 */
export function bindDeletedOverlayEvents(): void {
  if (!state.deletedOpen) return;
  // 只读列表。没有还原按钮——还原只在 Windows 回收站里做。
  bind(app.querySelector("#close-deleted"), "click", () => closeDeletedPanel());
  bind(app.querySelector("#deleted-close-footer"), "click", () => closeDeletedPanel());
  bind(app.querySelector("#deleted-retry"), "click", () => void loadDeletedItems());
  bind(app.querySelector("#deleted-backdrop"), "click", (event) => {
    if (event.target === event.currentTarget) closeDeletedPanel();
  });
  bindAll("[data-open-deleted]", "click", (event) => {
    const relativePath = (event.currentTarget as HTMLElement).dataset.openDeleted;
    if (relativePath) void openDeletedItemFolder(relativePath);
  });
}
