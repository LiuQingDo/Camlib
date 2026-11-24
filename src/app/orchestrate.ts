// 由 main.ts 拆分而来：仅做搬移，未改动逻辑。
import type { BackupProgressDto } from "../api/media";
import { formatEtaSeconds, formatSize, formatSpeed } from "../lib/format";
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
import { renderBackupPanel } from "../views/backup";
import {
  applyDialogSizes,
  renderDeleteConfirm,
  renderMergeModal,
  renderTagManager,
  setupDialogResizing,
} from "../views/dialogs";
import { closeEditor, renderEditor } from "../views/editor";
import { bindPreviewLayoutObserver, loadModalAsset, patchPreviewFrame, renderPreview } from "../views/preview";
import { renderDeletedPanel } from "../views/deleted";
import { renderSettingsPanel, updateSettingsPanel } from "../views/settings";
import { bindDeletedOverlayEvents, bindOverlayEvents } from "./bindings/overlay";
import { handlePreviewEscape } from "./bindings/preview";
import { closeDeletedPanel } from "./deleted-ops";
import { closeMergeModal, closeTagManager } from "./dialogs-ops";
import { pruneDetachedTraps, trapDialogFocus } from "./focus";
import { cancelDeleteConfirm } from "./media-ops";

export type OverlayId =
  | "preview"
  | "confirm"
  | "tag-manager"
  | "editor"
  | "merge"
  | "settings"
  | "ai-chat"
  | "backup"
  /** 侧栏「已删除」：只读审计列表，模态浮层。 */
  | "deleted"
  /** 筛选面板：无遮罩、无焦点陷阱，由 render/toolbar.ts 自行挂载与定位。 */
  | "filters";

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
 * 弹窗容器的焦点陷阱释放函数。按容器（`[data-overlay]`）而不是按
 * `[role="dialog"]` 记账：合并弹窗换内容时整个 dialog 会被 outerHTML 替换，
 * 挂在 dialog 上的 keydown 监听会连节点一起消失，挂在容器上才活得下来。
 */
const overlayTraps = new WeakMap<HTMLElement, (restoreFocus?: boolean) => void>();

/**
 * Esc 归各弹窗自己：陷阱只把 Esc 交给最上层，不再由全局 keydown 按状态猜顺序。
 * 没登记的两个（设置 / 导入抽屉）Esc 阶梯里还有二级确认与运行中提示，
 * 仍然留在全局分派里——此处返回 undefined，`trapDialogFocus` 便不拦 Esc。
 */
function overlayEscHandler(id: OverlayId): (() => void) | undefined {
  switch (id) {
    case "preview":
      return handlePreviewEscape;
    case "confirm":
      return cancelDeleteConfirm;
    case "tag-manager":
      return closeTagManager;
    case "editor":
      return closeEditor;
    case "merge":
      return closeMergeModal;
    case "deleted":
      return closeDeletedPanel;
    default:
      return undefined;
  }
}

/** 摘掉容器上的焦点陷阱，并（默认）把焦点还给打开前的元素。 */
function releaseOverlayFocus(host: HTMLElement, restoreFocus = true): void {
  const release = overlayTraps.get(host);
  if (!release) return;
  overlayTraps.delete(host);
  release(restoreFocus);
}

/**
 * 内容刚插进容器：模态弹窗（`[role="dialog"][aria-modal="true"]`）才建陷阱。
 * AI 助手抽屉虽然也是 `role="dialog"`，但没有 `aria-modal`、没有遮罩、关着也能
 * 继续操作网格——它是非模态面板，锁住背景反而是错的。
 * 先摘旧陷阱再建新的——签名重建时旧记录里的 previousFocus 已经过期。
 */
function applyOverlayFocus(host: HTMLElement, id: OverlayId): void {
  releaseOverlayFocus(host, false);
  if (!host.querySelector('[role="dialog"][aria-modal="true"]')) return;
  overlayTraps.set(host, trapDialogFocus(host, { onClose: overlayEscHandler(id) }));
}

/**
 * 退场：先给根节点挂 `.is-leaving` 播一段淡出，再清空容器。
 *
 * 原来关闭是直接把容器 `innerHTML` 清空——画面上是硬切，观感上像"闪没了"。
 * 现在多留 140ms：根节点淡出、容器 `pointer-events:none`（CSS），期间点击不会
 * 落到正在消失的按钮上；这 140ms 里若又打开了同一个弹窗，cancelLeave 撤掉定时器
 * 直接换新内容。
 *
 * 焦点在动画开始前就还回去：让用户等 140ms 才拿回键盘焦点是没道理的。
 */
function leaveOverlay(host: HTMLElement, signature: string): void {
  cancelLeave(host);
  releaseOverlayFocus(host);
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
      releaseOverlayFocus(host);
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
  // 焦点进弹窗 + 背景 inert：内容建好之后、下一次按键之前。
  applyOverlayFocus(host, id);
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
      releaseOverlayFocus(host);
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
    applyOverlayFocus(host, "preview");
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

// ---------------------------------------------------------------------------
// 备份抽屉：结构按签名重建，运行中的数字进度原地同步
//
// 备份进度每秒可能推进很多次。若把 bytesProcessed / speed / eta 也算进签名，
// 每次事件都会重写整个抽屉并重播入场过渡，既丢焦点又让玻璃降级窗口一直开着。
// 这里签名只包含「结构会变」的字段（步骤、预览、进度状态、历史），数字部分
// 交给 syncBackupProgressView() 直接改文字与进度条宽度。
// ---------------------------------------------------------------------------

function backupOverlaySignature(): string {
  if (!state.backupOpen) return "closed";
  const preview = state.backupPreview;
  const progress = state.backupProgress;
  return [
    state.backupLoading ? "loading" : "idle",
    state.availability,
    state.backupSources.map((source) => `${source.id}:${source.volumeLabel ?? ""}:${source.rootPath}`).join(","),
    state.libraries.map((library) => `${library.id}:${library.volumeLabel ?? ""}`).join(","),
    state.backupSourceId ?? "",
    state.backupTargetId ?? "",
    state.backupConflictPolicy,
    state.backupIgnoreExtensions,
    state.backupMergeSegments ? "merge" : "keep",
    state.backupDeepVerify ? "deep" : "fast",
    preview
      ? [
          preview.id,
          preview.requiredBytes,
          preview.freeBytes ?? "",
          preview.spaceSufficient,
          preview.conflictPolicy,
          preview.deepVerify ? "deep" : "fast",
          preview.mergeGroupCount,
          preview.mergeSegmentCount,
          preview.conflictFiles,
          preview.alreadyExistsFiles,
          preview.ignoredFiles,
          preview.totalFiles,
        ].join(":")
      : "no-preview",
    progress ? `${progress.jobId}:${progress.state}:${progress.phase}:${progress.error ?? ""}` : "no-progress",
    state.backupJobId ?? "",
    state.backupRetrying ? "retrying" : "",
    state.backupLastRunId ?? "",
    state.backupFailedItems.map((item) => `${item.id}:${item.errorMessage ?? ""}`).join(","),
    state.backupHistory
      .map((run) => `${run.id}:${run.status}:${run.copiedFiles}:${run.skippedFiles}:${run.failedFiles}:${run.copiedBytes}`)
      .join(","),
    state.backupExpandedRunId ?? "",
    state.backupHistoryItems.map((item) => item.id).join(","),
  ].join("|");
}

function backupCurrentLabel(progress: BackupProgressDto): string {
  const phaseLabel = progress.currentFile || (progress.phase === "merging" ? "正在合并分段" : "准备中");
  const liveMeta = `${formatSpeed(progress.speedBytesPerSec)} · ${formatEtaSeconds(progress.etaSeconds)}`;
  return `${phaseLabel} · ${liveMeta} · ${formatSize(progress.bytesProcessed)} / ${formatSize(progress.bytesTotal)}`;
}

/** 运行中只改数字，不重建节点；抽屉关着时什么都不做。 */
function syncBackupProgressView(): void {
  const progress = state.backupProgress;
  if (!progress || progress.state !== "running" || !state.backupOpen) return;
  const host = app.querySelector<HTMLElement>('[data-overlay="backup"]');
  if (!host?.firstChild) return;
  const percent =
    progress.bytesTotal > 0
      ? Math.min(100, Math.max(0, Math.round((progress.bytesProcessed / progress.bytesTotal) * 100)))
      : 0;
  const percentNode = host.querySelector<HTMLElement>("[data-backup-percent]");
  if (percentNode) percentNode.textContent = `${percent}%`;
  const track = host.querySelector<HTMLElement>("[data-backup-track]");
  const fill = host.querySelector<HTMLElement>("[data-backup-track-fill]");
  if (track && fill) {
    const indeterminate = progress.bytesTotal <= 0;
    track.classList.toggle("is-indeterminate", indeterminate);
    fill.style.width = indeterminate ? "35%" : `${percent}%`;
  }
  const current = host.querySelector<HTMLElement>("[data-backup-current]");
  if (current) current.textContent = backupCurrentLabel(progress);
}

export function patchBackupOverlay(): boolean {
  const host = app.querySelector<HTMLElement>('[data-overlay="backup"]');
  // 已经在场上（预览完成、进度换态、历史展开）时只换内容，不重播滑入动画。
  const wasRendered = Boolean(host?.firstElementChild);
  const rebuilt = patchOverlay("backup", backupOverlaySignature(), () =>
    state.backupOpen
      ? `<div class="modal-backdrop backup-backdrop" data-backdrop="backup">${renderBackupPanel()}</div>`
      : "",
  );
  if (rebuilt && wasRendered) host?.firstElementChild?.classList.add("is-settled");
  syncBackupProgressView();
  return rebuilt;
}

/** 侧栏「已删除」浮层：内容只由 state 决定，网格与其它弹窗不受影响。 */
export function patchDeletedOverlay(): boolean {
  const rebuilt = patchOverlay(
    "deleted",
    state.deletedOpen
      ? `${state.deletedLoading ? 1 : 0}:${state.deletedError ?? ""}:${state.deletedTotal}:${state.deletedItems
          .map((item) => `${item.id}@${item.deletedAt}`)
          .join("|")}`
      : "closed",
    renderDeletedPanel,
  );
  // 浮层内容只在打开时才有，启动期的 bindOverlayEvents 抓不到这些节点：
  // 重建后立刻绑，否则 ×、页脚关闭、点遮罩全是死按钮。
  if (rebuilt) bindDeletedOverlayEvents();
  return rebuilt;
}

export function renderOverlays(): void {
  // 骨架被强制重建过（换媒体库）时，旧容器连同陷阱一起脱离了文档：
  // 不清掉的话 inert 计数会卡在 >0，整个界面被锁死。
  pruneDetachedTraps();
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
  changed = patchBackupOverlay() || changed;
  changed = patchDeletedOverlay() || changed;
  if (changed) {
    bindOverlayEvents();
    // 新弹窗需要恢复保存的几何尺寸并补上拖拽手柄（两者都自带幂等判断）。
    applyDialogSizes();
    setupDialogResizing();
    setupAiChatResize();
    // 几何落定之后再算预览布局：信息面板是右侧栏还是底部抽屉，取决于弹窗
    // 真实宽度（不是窗口宽度），而宽度刚由 applyDialogSizes 写进 inline style。
    bindPreviewLayoutObserver();
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
