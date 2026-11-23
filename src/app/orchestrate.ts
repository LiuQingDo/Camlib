// 由 main.ts 拆分而来：仅做搬移，未改动逻辑。
import { app } from "../render/context";
import { OVERLAY_ENTER_MS, OVERLAY_LEAVE_MS, beginOverlayTransition } from "../render/overlay-transition";
import { patchSidebar, renderShell } from "../render/shell";
import {
  patchErrorBar as patchErrorBarRegion,
  patchTaskPill as patchTaskPillRegion,
  patchToolbar,
} from "../render/toolbar";
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
import { loadModalAsset, patchPreviewFrame, renderPreview } from "../views/preview";
import { renderSettingsPanel, updateSettingsPanel } from "../views/settings";
import { bindOverlayEvents } from "./bindings/overlay";

export type OverlayId = "preview" | "confirm" | "tag-manager" | "editor" | "merge" | "settings" | "ai-chat";

/** 弹窗容器 → 上次构建它的签名。签名没变就完全不碰 DOM。 */
export const overlaySignatures = new WeakMap<HTMLElement, string>();

/** 退场定时器：同一容器重新打开时撤掉，避免"关掉的定时器把新内容清空"。 */
const leaveTimers = new WeakMap<HTMLElement, number>();

function cancelLeave(host: HTMLElement): void {
  const timer = leaveTimers.get(host);
  if (timer === undefined) return;
  window.clearTimeout(timer);
  leaveTimers.delete(host);
}

/**
 * 退场：先给根节点挂 `.is-leaving` 播一段淡出，再清空容器。
 *
 * 原来关闭是直接把容器 `innerHTML` 清空——画面上是硬切，观感上像"闪没了"。
 * 现在多留 140ms：根节点淡出、容器 `pointer-events:none`（CSS），期间点击不会
 * 落到正在消失的按钮上；这 140ms 里若又打开了同一个弹窗，cancelLeave 撤掉定时器
 * 直接换新内容。
 */
function leaveOverlay(host: HTMLElement, signature: string): void {
  cancelLeave(host);
  overlaySignatures.set(host, signature);
  const root = host.firstElementChild as HTMLElement | null;
  if (!root) {
    host.replaceChildren();
    return;
  }
  root.classList.add("is-leaving");
  beginOverlayTransition(OVERLAY_LEAVE_MS + 48);
  leaveTimers.set(
    host,
    window.setTimeout(() => {
      leaveTimers.delete(host);
      // 期间被重新打开过：签名已经不是它了，别把新内容清掉。
      if (overlaySignatures.get(host) !== signature) return;
      host.replaceChildren();
    }, OVERLAY_LEAVE_MS),
  );
}

/**
 * 弹窗容器 patch。每个弹窗独占一个容器，所以「编辑器压着预览打开」这类场景
 * 不会再顺手把预览的 DOM 一起冲掉——这正是旧代码要重放 loadModalAsset 的根因。
 *
 * 生产出空串 = 关闭，走退场动画；返回 true 只表示"结构性重建"，关闭不算变化
 * （关闭不需要重绑事件，也不该重算弹窗几何）。
 */
export function patchOverlay(id: OverlayId, signature: string, produce: () => string): boolean {
  const host = app.querySelector<HTMLElement>(`[data-overlay="${id}"]`);
  if (!host) return false;
  if (overlaySignatures.get(host) === signature) return false;
  const html = produce();
  if (!html) {
    if (!host.firstChild) {
      overlaySignatures.set(host, signature);
      return false;
    }
    leaveOverlay(host, signature);
    return false;
  }
  cancelLeave(host);
  overlaySignatures.set(host, signature);
  host.innerHTML = html;
  // 新插入的玻璃面板要重建位移贴图；动画正在跑的那几帧先摘掉折射带。
  beginOverlayTransition(OVERLAY_ENTER_MS);
  return true;
}

// ---------------------------------------------------------------------------
// 预览弹窗：外壳只建一次，换图原地 patch
//
// 之前 ←/→ 换图走的是 patchOverlay 的签名重建：整个 `.modal-backdrop` 连同全屏
// `backdrop-filter: blur(18px)` 和面板一起换掉，入场动画重播一遍、弹窗几何重算一遍。
// 换一张图的开销和第一次打开完全一样，于是每按一次方向键就"卡一下、闪一下"。
//
// 现在只有开/关才动结构；换图只改文字、按钮可见性，`#modal-media` 由装载钩子
// 交叉替换（旧图在替换前一直留在画面上，不再先清成转圈）。
// ---------------------------------------------------------------------------

/** 上次装载的那张图（index:itemId）：变了才重新取源。 */
let previewAssetKey = "";

/** 上次 patch 的帧（含结果集长度）：变了才改位置计数与标题。 */
let previewFrameKey = "";

export function patchPreviewOverlay(): { rebuilt: boolean; load: boolean } {
  const host = app.querySelector<HTMLElement>('[data-overlay="preview"]');
  if (!host) return { rebuilt: false, load: false };
  const index = state.previewIndex;
  const item = index === null ? undefined : state.page.items[index];
  if (index === null || !item) {
    previewAssetKey = "";
    previewFrameKey = "";
    // 已经关着（含退场动画还在跑的这 140ms）：别再重排一次退场定时器。
    if (overlaySignatures.get(host) === "closed") return { rebuilt: false, load: false };
    if (!host.firstChild) {
      overlaySignatures.set(host, "closed");
      return { rebuilt: false, load: false };
    }
    leaveOverlay(host, "closed");
    return { rebuilt: false, load: false };
  }

  let rebuilt = false;
  if (overlaySignatures.get(host) !== "open" || !host.firstChild) {
    cancelLeave(host);
    overlaySignatures.set(host, "open");
    host.innerHTML = renderPreview();
    beginOverlayTransition(OVERLAY_ENTER_MS);
    rebuilt = true;
  }

  const assetKey = `${index}:${item.id}`;
  const frameKey = `${assetKey}:${state.page.items.length}`;
  if (assetKey !== previewAssetKey) {
    // 换的是另一张图：清掉上一张的元信息与缩放，标记进入装载。
    patchPreviewFrame(item, index, true);
    previewAssetKey = assetKey;
    previewFrameKey = frameKey;
    return { rebuilt, load: true };
  }
  if (rebuilt) return { rebuilt, load: true };
  if (frameKey !== previewFrameKey) {
    // 只是结果集长度变了（追加了一页），位置计数要跟上，媒体不用重取。
    patchPreviewFrame(item, index, false);
    previewFrameKey = frameKey;
  }
  return { rebuilt, load: false };
}

export function renderOverlays(): void {
  let changed = false;
  const preview = patchPreviewOverlay();
  changed = preview.rebuilt || changed;
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
  if (changed) {
    bindOverlayEvents();
    // 新弹窗需要恢复保存的几何尺寸并补上拖拽手柄（两者都自带幂等判断）。
    applyDialogSizes();
    setupDialogResizing();
    setupAiChatResize();
  }
  // 预览容器刚建好、或刚换了图，都由这里补一次装载。
  if (preview.load && state.previewIndex !== null) void loadModalAsset();
}

/**
 * 反馈三通道里的两块常驻区域，单独 patch 入口。
 *
 * 整块刷新走 patchToolbar()（它内部已按顺序带上这两条通道）；只有「关掉一条
 * 通知」「取消/展开一个任务」这种局部动作才从这里直调，避免连带重画标题、
 * 筛选行与选择工具栏。
 */
export function patchErrorBar(): void {
  patchErrorBarRegion();
}

export function patchTaskPill(): void {
  patchTaskPillRegion();
}

/**
 * 全量 reconcile：骨架 + 各分区 patch + 弹窗。
 * 语义上等价于旧的 render()，但只改真正变化的那部分 DOM。
 *
 * 仍未增量化（继续走整块重建，语义与改造前一致）：
 *   - 设置面板的内容区：已有 updateSettingsPanel() 单独 patch，面板壳只建一次。
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
