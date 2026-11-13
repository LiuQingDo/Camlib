// 由 main.ts 拆分而来：仅做搬移，未改动逻辑。
import { app } from "../render/context";
import { patchSidebar, renderShell } from "../render/shell";
import { patchToolbar } from "../render/toolbar";
import { patchGrid } from "../render/virtual";
import { state } from "../state";
import { aiChatReady, renderAiChatDrawer, setupAiChatResize } from "../views/ai-chat";
import {
  applyDialogSizes,
  renderDeleteConfirm,
  renderMergeModal,
  renderTagManager,
  setupDialogResizing,
} from "../views/dialogs";
import { renderEditor } from "../views/editor";
import { loadModalAsset, renderPreview } from "../views/preview";
import { renderSettingsPanel, updateSettingsPanel } from "../views/settings";
import { bindOverlayEvents } from "./bindings/overlay";

export type OverlayId = "preview" | "confirm" | "tag-manager" | "editor" | "merge" | "settings" | "ai-chat";

/** 弹窗容器 → 上次构建它的签名。签名没变就完全不碰 DOM。 */
export const overlaySignatures = new WeakMap<HTMLElement, string>();

/**
 * 弹窗容器 patch。每个弹窗独占一个容器，所以「编辑器压着预览打开」这类场景
 * 不会再顺手把预览的 DOM 一起冲掉——这正是旧代码要重放 loadModalAsset 的根因。
 */
export function patchOverlay(id: OverlayId, signature: string, produce: () => string): boolean {
  const host = app.querySelector<HTMLElement>(`[data-overlay="${id}"]`);
  if (!host) return false;
  if (overlaySignatures.get(host) === signature) return false;
  overlaySignatures.set(host, signature);
  // 空容器写空内容不算变化（首帧所有弹窗都是关闭态，没必要触发一次绑定）。
  if (!host.firstChild && signature === "closed") return false;
  host.innerHTML = produce();
  return true;
}

/** 预览弹窗的结构签名：打开 / 换图 / 结果集长度变化才需要重建。 */
export function previewSignature(): string {
  if (state.previewIndex === null) return "closed";
  const item = state.page.items[state.previewIndex];
  return `${state.previewIndex}:${item?.id ?? ""}:${state.page.items.length}`;
}

export function renderOverlays(): void {
  let changed = false;
  const previewChanged = patchOverlay("preview", previewSignature(), renderPreview);
  changed = previewChanged || changed;
  changed = patchOverlay("confirm", JSON.stringify(state.deleteConfirm?.ids ?? []), renderDeleteConfirm) || changed;
  changed =
    patchOverlay(
      "tag-manager",
      state.tagsManagerOpen
        ? `${state.tagsManagerBusy}:${state.tagsManagerError ?? ""}:${state.tagDeleteConfirmId ?? ""}:${state.tags.map((tag) => `${tag.id}/${tag.name}/${tag.mediaCount ?? 0}`).join("|")}`
        : "closed",
      renderTagManager,
    ) || changed;
  changed =
    patchOverlay(
      "editor",
      state.editorOpen
        ? `${state.editorItem?.id ?? ""}:${state.editorKind}:${state.editorLoading}:${state.editorBusy}:${state.editorError ?? ""}:${state.editorNotice ?? ""}:${state.editorSourceUrl}`
        : "closed",
      renderEditor,
    ) || changed;
  changed =
    patchOverlay(
      "merge",
      state.mergeModalOpen
        ? `${state.mergeItems.map((item) => item.id).join(",")}:${state.mergeMode}:${state.mergeRecycleSources}`
        : "closed",
      renderMergeModal,
    ) || changed;
  // 设置面板只建一次壳，内容由 updateSettingsPanel 单独 patch。
  changed = patchOverlay("settings", state.settingsOpen ? "open" : "closed", renderSettingsPanel) || changed;
  changed =
    patchOverlay(
      "ai-chat",
      state.aiChatOpen
        ? `${aiChatReady()}:${state.aiChatBusy}:${state.aiChatMessages.length}:${state.aiChatMessages[state.aiChatMessages.length - 1]?.streaming ? 1 : 0}`
        : "closed",
      renderAiChatDrawer,
    ) || changed;
  if (!changed) return;
  bindOverlayEvents();
  // 新弹窗需要恢复保存的几何尺寸并补上拖拽手柄（两者都自带幂等判断）。
  applyDialogSizes();
  setupDialogResizing();
  setupAiChatResize();
  // 预览容器刚重建时里面只有一个占位骨架，由这里补一次装载。
  // 注意：只有「容器真的重建」才会走到这，纯粹的 patch 不会重放。
  if (previewChanged && state.previewIndex !== null) void loadModalAsset();
}

/**
 * 全量 reconcile：骨架 + 各分区 patch + 弹窗。
 * 语义上等价于旧的 render()，但只改真正变化的那部分 DOM。
 *
 * 仍未增量化（继续走整块重建，语义与改造前一致）：
 *   - 设置面板的内容区：已有 updateSettingsPanel() 单独 patch，面板壳只建一次。
 *   - 媒体预览弹窗：按签名（打开 / 换图 / 结果集长度）复用，换图时整块重建。
 *   - 编辑器、合并视频、标签管理、删除确认、AI 助手抽屉：整块重建。
 * 这些区域都不参与“快速连续交互”路径，重建不会造成缩略图闪烁；等它们也
 * 变成高频交互点（例如编辑器内实时预览）时再引入同样的分区 patch。
 */
export function render(): void {
  renderShell();
  patchSidebar();
  patchToolbar();
  patchGrid();
  renderOverlays();
}

/** Prefer in-place settings patch when the dialog is open (avoids full-shell flash). */
export function renderSettingsAware(): void {
  if (state.settingsOpen) updateSettingsPanel();
  else render();
}
