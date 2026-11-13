// 由 main.ts 拆分而来：仅做搬移，未改动逻辑。
import { DialogSize } from "../api/infrastructure";
import { LibraryMergeGroupDto } from "../api/media";
import { hasAnyFilter } from "../lib/filters";
import { formatCount, formatEtaSeconds, formatSize, formatSpeed } from "../lib/format";
import { app } from "../render/context";
import { bindMergeFooterEvents, bindMergeModalEvents, persistUiPrefs, updateSettingsPanel } from "../render/paint";
import { escapeHtml, pathBaseName } from "../render/text";
import { state } from "../state";

/** Resizable-dialog registry: selectors, stylesheet defaults, drag minimums. */
export interface DialogSpec {
  /** Dialog element inside its backdrop, resolved against the app root. */
  selector: string;
  label: string;
  /** Stylesheet default in px; null = content-driven (auto). */
  width: number | null;
  height: number | null;
  minWidth: number;
  minHeight: number;
}

export const DIALOG_SPECS: Record<string, DialogSpec> = {
  preview: {
    selector: "#preview-modal .preview-modal",
    label: "媒体预览",
    width: 1050,
    height: 780,
    minWidth: 560,
    minHeight: 380,
  },
  editor: {
    selector: "#editor-modal .editor-modal",
    label: "媒体编辑",
    width: 1180,
    height: 820,
    minWidth: 640,
    minHeight: 440,
  },
  settings: {
    selector: "#settings-backdrop .settings-panel",
    label: "设置",
    width: 920,
    height: 760,
    minWidth: 560,
    minHeight: 400,
  },
  tagManager: {
    selector: "#tag-manager-backdrop .tag-manager",
    label: "标签管理",
    width: 440,
    height: null,
    minWidth: 320,
    minHeight: 240,
  },
  confirm: {
    selector: "#delete-confirm-modal .confirm-dialog",
    label: "删除确认",
    width: 520,
    height: null,
    minWidth: 300,
    minHeight: 200,
  },
  mergeVideos: {
    selector: "#merge-videos-modal .merge-modal",
    label: "合并视频",
    width: 640,
    height: null,
    minWidth: 460,
    minHeight: 320,
  },
};

export const dialogResizeDirections = ["n", "s", "e", "w", "ne", "nw", "se", "sw"] as const;

export type DialogResizeDirection = (typeof dialogResizeDirections)[number];

/** The titlebar overlays fixed drags; resized dialogs must stay below it. */
export function dialogDragTopBound(): number {
  const raw = getComputedStyle(document.documentElement).getPropertyValue("--titlebar-h");
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Actual horizontal/vertical backdrop insets — `.settings-backdrop` overrides the generic 25px padding. */
export function backdropInsets(dialog: HTMLElement): { x: number; y: number } {
  const style = getComputedStyle(dialog.parentElement ?? dialog);
  const parse = (value: string) => Number.parseFloat(value) || 0;
  return {
    x: parse(style.paddingLeft) + parse(style.paddingRight),
    y: parse(style.paddingTop) + parse(style.paddingBottom),
  };
}

/**
 * Clamp a stored dialog size to the live viewport. The backdrop insets its
 * content and starts below the titlebar. `clampDialogSize` runs at open time,
 * so a size saved on a large screen shrinks gracefully on a smaller one
 * without ever being rewritten on disk.
 */
export function clampDialogSize(
  id: string,
  size: DialogSize | undefined,
  insets: { x: number; y: number },
): DialogSize {
  const spec = DIALOG_SPECS[id];
  if (!spec || !size) return {};
  const maxWidth = Math.max(spec.minWidth, window.innerWidth - insets.x);
  const maxHeight = Math.max(spec.minHeight, window.innerHeight - dialogDragTopBound() - insets.y);
  const clamp = (value: number | undefined, min: number, max: number) =>
    value == null ? undefined : Math.min(max, Math.max(min, Math.round(value)));
  return {
    width: clamp(size.width, spec.minWidth, maxWidth),
    height: clamp(size.height, spec.minHeight, maxHeight),
  };
}

/** Drop unknown dialog ids and non-numeric values from a hand-edited file. */
export function sanitizeDialogSizes(input: unknown): Record<string, DialogSize> {
  const sizes: Record<string, DialogSize> = {};
  if (!input || typeof input !== "object") return sizes;
  for (const [id, value] of Object.entries(input as Record<string, unknown>)) {
    if (!DIALOG_SPECS[id] || !value || typeof value !== "object") continue;
    const raw = value as Record<string, unknown>;
    const size: DialogSize = {};
    if (typeof raw.width === "number" && Number.isFinite(raw.width) && raw.width >= 1) size.width = raw.width;
    if (typeof raw.height === "number" && Number.isFinite(raw.height) && raw.height >= 1) size.height = raw.height;
    if (size.width != null || size.height != null) sizes[id] = size;
  }
  return sizes;
}

/**
 * Re-apply saved dialog geometry after every render. Inline width/height beat
 * the stylesheet `min(...)` defaults; a missing dimension is cleared so the
 * stylesheet rule (auto height for content-sized dialogs) applies again.
 */
export function applyDialogSizes(): void {
  for (const [id, spec] of Object.entries(DIALOG_SPECS)) {
    const dialog = app.querySelector<HTMLElement>(spec.selector);
    if (!dialog) continue;
    if (id === "preview" && state.previewImmersive) {
      // Immersive CSS owns the geometry (100vw/100vh); inline sizes would win.
      dialog.style.removeProperty("width");
      dialog.style.removeProperty("height");
      dialog.style.removeProperty("max-width");
      dialog.style.removeProperty("max-height");
      continue;
    }
    const saved = clampDialogSize(id, state.dialogSizes[id], backdropInsets(dialog));
    if (saved.width != null) {
      dialog.style.width = `${saved.width}px`;
      dialog.style.maxWidth = `${saved.width}px`;
    } else {
      dialog.style.removeProperty("width");
      dialog.style.removeProperty("max-width");
    }
    if (saved.height != null) {
      dialog.style.height = `${saved.height}px`;
      dialog.style.maxHeight = `${saved.height}px`;
    } else {
      dialog.style.removeProperty("height");
      dialog.style.removeProperty("max-height");
    }
  }
}

/**
 * Give every mounted dialog 8-direction resize handles. Handles are appended
 * after each render() together with the dialog DOM; `data-resize-bound` keeps
 * the immersive-exit re-run from duplicating them on a surviving dialog.
 */
export function setupDialogResizing(): void {
  for (const [id, spec] of Object.entries(DIALOG_SPECS)) {
    const dialog = app.querySelector<HTMLElement>(spec.selector);
    if (!dialog || dialog.dataset.resizeBound === "1") continue;
    // The immersive stage fills the backdrop; resizing is meaningless there.
    if (id === "preview" && state.previewImmersive) continue;
    dialog.dataset.resizeBound = "1";
    for (const direction of dialogResizeDirections) {
      const handle = document.createElement("div");
      handle.className = `dialog-resize-handle is-${direction}`;
      handle.setAttribute("aria-hidden", "true");
      handle.addEventListener("pointerdown", (event) => beginDialogResize(event, dialog, id, direction));
      dialog.append(handle);
    }
  }
}

/**
 * Center-anchored resize: the dialog never leaves the centered grid flow, so
 * there is no re-center flash on release. Each pointer delta feeds both edges
 * symmetrically, which keeps the grabbed edge/corner tracking the cursor 1:1.
 */
export function beginDialogResize(
  event: PointerEvent,
  dialog: HTMLElement,
  id: string,
  direction: DialogResizeDirection,
): void {
  const spec = DIALOG_SPECS[id];
  const handle = event.currentTarget;
  if (!spec || !(handle instanceof HTMLElement)) return;
  event.preventDefault();
  event.stopPropagation();
  const startX = event.clientX;
  const startY = event.clientY;
  const startRect = dialog.getBoundingClientRect();
  // Stay inside the backdrop's content box; the dialog is centered, so the
  // largest symmetric size is the backdrop minus its actual padding. Offsets
  // beyond that would trip the grid's overflow alignment and nudge the dialog.
  const backdropRect = dialog.parentElement?.getBoundingClientRect();
  const insets = backdropRect ? backdropInsets(dialog) : { x: 50, y: 50 };
  const maxWidth = Math.max(spec.minWidth, (backdropRect?.width ?? window.innerWidth) - insets.x);
  const maxHeight = Math.max(spec.minHeight, (backdropRect?.height ?? window.innerHeight) - insets.y);
  let width = startRect.width;
  let height = startRect.height;

  document.body.classList.add("is-dialog-resizing");
  handle.setPointerCapture(event.pointerId);
  // Esc can destroy the dialog mid-drag, taking finish() with it; these
  // window-level one-shots guarantee the drag state never stays behind.
  const clearDragState = () => document.body.classList.remove("is-dialog-resizing");
  window.addEventListener("pointerup", clearDragState, { once: true });
  window.addEventListener("pointercancel", clearDragState, { once: true });

  const apply = () => {
    dialog.style.width = `${width}px`;
    dialog.style.maxWidth = `${width}px`;
    dialog.style.height = `${height}px`;
    dialog.style.maxHeight = `${height}px`;
  };

  const onMove = (moveEvent: PointerEvent) => {
    const dx = moveEvent.clientX - startX;
    const dy = moveEvent.clientY - startY;
    width = startRect.width;
    height = startRect.height;
    if (direction.includes("e")) width = startRect.width + dx * 2;
    if (direction.includes("w")) width = startRect.width - dx * 2;
    if (direction.includes("s")) height = startRect.height + dy * 2;
    if (direction.includes("n")) height = startRect.height - dy * 2;
    width = Math.min(Math.max(width, spec.minWidth), maxWidth);
    height = Math.min(Math.max(height, spec.minHeight), maxHeight);
    apply();
  };

  const finish = () => {
    handle.removeEventListener("pointermove", onMove);
    document.body.classList.remove("is-dialog-resizing");
    // A click without a drag must not lock content-driven (auto) sizes.
    const moved =
      Math.round(width) !== Math.round(startRect.width) || Math.round(height) !== Math.round(startRect.height);
    if (moved) state.dialogSizes[id] = { width: Math.round(width), height: Math.round(height) };
    // Re-clamp from state: restores no-move jitter and clamps saved sizes.
    applyDialogSizes();
    if (moved) {
      void persistUiPrefs({ uiDialogSizes: state.dialogSizes });
      if (state.settingsOpen && state.settingsSection === "system") updateSettingsPanel();
    }
  };

  handle.addEventListener("pointermove", onMove);
  handle.addEventListener("pointerup", finish, { once: true });
  handle.addEventListener("pointercancel", finish, { once: true });
}

/** Intrinsic pixel size of a photo/video, or null until metadata is decoded. */
export function mediaNaturalSize(media: HTMLImageElement | HTMLVideoElement | null): { w: number; h: number } | null {
  if (!media) return null;
  const w = media instanceof HTMLVideoElement ? media.videoWidth : media.naturalWidth;
  const h = media instanceof HTMLVideoElement ? media.videoHeight : media.naturalHeight;
  return w > 0 && h > 0 ? { w, h } : null;
}

/**
 * 「按媒体自适应」：以媒体原始宽高比，把弹窗调成媒体在视口内的最大等比
 * 适配尺寸。标题栏/工具栏/信息栏等装饰开销从当前弹窗实测反推，对预览与
 * 编辑两种布局都成立。弹窗已是该尺寸时再次点击则恢复默认尺寸。
 */
export function adaptDialogToMedia(
  dialogId: "preview" | "editor",
  media: HTMLImageElement | HTMLVideoElement | null,
): void {
  const spec = DIALOG_SPECS[dialogId];
  const dialog = app.querySelector<HTMLElement>(spec?.selector ?? "");
  if (!spec || !dialog) return;
  const natural = mediaNaturalSize(media);
  if (!natural) {
    // 视频元数据或图片解码未就绪：就绪后自动补一次适配。
    if (media) {
      const event = media instanceof HTMLVideoElement ? "loadedmetadata" : "load";
      media.addEventListener(event, () => adaptDialogToMedia(dialogId, media), { once: true });
    }
    return;
  }
  // 媒体区内容盒：预览为 .modal-media（含左右导航留白），编辑为舞台区。
  const area = dialog.querySelector<HTMLElement>(dialogId === "preview" ? ".modal-media" : ".editor-stage-wrap");
  if (!area) return;
  const modalRect = dialog.getBoundingClientRect();
  const areaRect = area.getBoundingClientRect();
  const areaStyle = getComputedStyle(area);
  const padX = Number.parseFloat(areaStyle.paddingLeft) + Number.parseFloat(areaStyle.paddingRight);
  const padY = Number.parseFloat(areaStyle.paddingTop) + Number.parseFloat(areaStyle.paddingBottom);
  const areaW = areaRect.width - padX;
  const areaH = areaRect.height - padY;
  if (areaW <= 0 || areaH <= 0) return;
  const chromeW = Math.max(0, modalRect.width - areaW);
  const chromeH = Math.max(0, modalRect.height - areaH);
  const insets = backdropInsets(dialog);
  const availW = Math.max(spec.minWidth, window.innerWidth - insets.x);
  const availH = Math.max(spec.minHeight, window.innerHeight - dialogDragTopBound() - insets.y);
  const scale = Math.max(0.01, Math.min((availW - chromeW) / natural.w, (availH - chromeH) / natural.h));
  const targetW = Math.min(availW, Math.max(spec.minWidth, Math.round(natural.w * scale) + Math.round(chromeW)));
  const targetH = Math.min(availH, Math.max(spec.minHeight, Math.round(natural.h * scale) + Math.round(chromeH)));
  const same = Math.abs(modalRect.width - targetW) <= 2 && Math.abs(modalRect.height - targetH) <= 2;
  if (same) delete state.dialogSizes[dialogId];
  else state.dialogSizes[dialogId] = { width: targetW, height: targetH };
  applyDialogSizes();
  void persistUiPrefs({ uiDialogSizes: state.dialogSizes });
  if (state.settingsOpen && state.settingsSection === "system") updateSettingsPanel();
}

export function mergeGroupMatches(group: LibraryMergeGroupDto, query: string): boolean {
  if (!query) return true;
  const haystack = [group.fileName, group.groupKey, ...group.sources.map(pathBaseName)].join("\n").toLowerCase();
  return haystack.includes(query);
}

export function renderDeleteConfirm(): string {
  const confirm = state.deleteConfirm;
  if (!confirm) return "";
  const { preview } = confirm;
  const summaryLines = preview.summary.slice(0, 8);
  const more = preview.summary.length > 8;
  return `<div class="modal-backdrop confirm-backdrop" id="delete-confirm-modal" role="presentation"><div class="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="delete-confirm-title">
    <header class="confirm-header"><h2 id="delete-confirm-title">移入 Windows 回收站</h2><button class="icon-button" id="cancel-delete-confirm" type="button" aria-label="取消">×</button></header>
    <div class="confirm-body">
      <p class="confirm-lead">将把 <strong>${formatCount(preview.mediaCount)}</strong> 个媒体项（<strong>${formatCount(preview.fileCount)}</strong> 个文件，约 <strong>${formatSize(preview.totalSizeBytes)}</strong>）移入 <strong>Windows 回收站</strong>。</p>
      <p class="confirm-recycle">文件不会被永久粉碎。你可以从系统回收站恢复原文件；Camlib 只从索引中标记为已删除。</p>
      <div class="confirm-summary"><div class="confirm-summary-label">将处理的文件</div><ul>${summaryLines.map((line) => `<li>${escapeHtml(line)}</li>`).join("")}${more ? `<li class="confirm-more">…以及另外 ${formatCount(preview.summary.length - 8)} 个文件</li>` : ""}</ul></div>
    </div>
    <footer class="confirm-actions"><button class="outline-button" id="cancel-delete-confirm-footer" type="button">取消</button><button class="danger-button confirm-danger" id="confirm-delete" type="button">移入回收站</button></footer>
  </div></div>`;
}

export function renderMergeModal(): string {
  if (!state.mergeModalOpen) return "";
  return `<div class="modal-backdrop merge-backdrop" id="merge-videos-modal" role="presentation">${renderMergeDialog()}</div>`;
}

export function renderMergeDialog(): string {
  if (!state.mergeModalOpen) return "";
  const busy = Boolean(state.mergeJobId || state.mergeBusy);
  const rows = state.mergeItems
    .map((item, index) => {
      const first = index === 0;
      const last = index === state.mergeItems.length - 1;
      return `<li class="merge-row" data-item-id="${escapeHtml(item.id)}">
      <span class="merge-row-handle" data-merge-handle aria-hidden="true" title="拖动调整顺序">⠿</span>
      <span class="merge-order">${index + 1}</span>
      <span class="merge-thumb" data-merge-thumb="${escapeHtml(item.id)}"><span class="spinner"></span></span>
      <span class="merge-row-info"><strong title="${escapeHtml(item.displayName)}">${escapeHtml(item.displayName)}</strong><span>${formatSize(item.totalSizeBytes)}</span></span>
      <span class="merge-row-tools">
        <button class="icon-button" type="button" data-merge-up="${index}" aria-label="上移" title="上移" ${busy || first ? "disabled" : ""}>↑</button>
        <button class="icon-button" type="button" data-merge-down="${index}" aria-label="下移" title="下移" ${busy || last ? "disabled" : ""}>↓</button>
      </span>
    </li>`;
    })
    .join("");
  return `<div class="merge-modal" role="dialog" aria-modal="true" aria-labelledby="merge-videos-title">
    <header class="merge-header">
      <div><h2 id="merge-videos-title">合并视频</h2><span>按列表顺序拼接为一个新文件，原视频不会被修改。</span></div>
      <button class="icon-button" type="button" id="close-merge-modal" aria-label="关闭合并视频弹窗">×</button>
    </header>
    <div class="merge-body">
      <div class="merge-mode-group" role="radiogroup" aria-label="合并方式">
        <button type="button" class="merge-mode${state.mergeMode === "copy" ? " is-active" : ""}" data-merge-mode="copy" aria-pressed="${state.mergeMode === "copy"}" ${busy ? "disabled" : ""}><strong>快速无损</strong><span>直接拼接数据流，速度快；要求各视频编码格式一致</span></button>
        <button type="button" class="merge-mode${state.mergeMode === "reencode" ? " is-active" : ""}" data-merge-mode="reencode" aria-pressed="${state.mergeMode === "reencode"}" ${busy ? "disabled" : ""}><strong>兼容重编码</strong><span>统一转码为 H.264/AAC，可混合不同格式，速度较慢</span></button>
      </div>
      <p class="merge-hint">拖动 ⠿ 或使用 ↑↓ 调整拼接顺序（自上而下播放）。</p>
      <ul class="merge-list${busy ? " is-busy" : ""}">${rows}</ul>
      <label class="merge-recycle"><input id="merge-recycle-sources" type="checkbox" ${state.mergeRecycleSources ? "checked" : ""} ${busy ? "disabled" : ""} /><span>合并后将原视频移入回收站</span></label>
    </div>
    <footer class="merge-footer" id="merge-modal-footer">${renderMergeFooterInner()}</footer>
  </div>`;
}

export function renderMergeFooterInner(): string {
  const busy = Boolean(state.mergeJobId || state.mergeBusy);
  if (busy) {
    const progress = state.mergeProgress;
    const percent = progress
      ? (progress.percent ?? (progress.bytesTotal > 0 ? (progress.bytesProcessed / progress.bytesTotal) * 100 : null))
      : null;
    const trackClass = percent == null ? " is-indeterminate" : "";
    const trackWidth = percent == null ? "35%" : `${Math.round(percent)}%`;
    const speed = progress?.speedBytesPerSec ? ` · ${formatSpeed(progress.speedBytesPerSec)}` : "";
    const eta = progress?.etaSeconds ? ` · 剩余 ${formatEtaSeconds(progress.etaSeconds)}` : "";
    const phaseLabel =
      state.mergeNotice ??
      (progress?.phase === "preparing"
        ? "正在准备…"
        : progress?.phase === "finalizing"
          ? "正在提交…"
          : state.mergeMode === "reencode"
            ? "正在重编码合并…"
            : "正在无损合并…");
    return `<div class="merge-progress">
      <div class="merge-progress-copy"><span class="spinner"></span><span>${phaseLabel}${speed}${eta}</span><strong>${percent == null ? "" : `${Math.round(percent)}%`}</strong></div>
      <div class="progress-track${trackClass}"><span style="width:${trackWidth}"></span></div>
    </div>
    <span class="merge-actions"><button class="outline-button" type="button" id="merge-cancel-job">取消合并</button></span>`;
  }
  const totalBytes = state.mergeItems.reduce((sum, item) => sum + item.totalSizeBytes, 0);
  const feedback = state.mergeError ?? state.mergeNotice;
  return `<span class="merge-feedback${state.mergeError ? " is-error" : ""}">${escapeHtml(feedback ?? "")}</span>
    <span class="merge-actions">
      <button class="outline-button" type="button" id="close-merge-modal-footer">取消</button>
      <button class="primary-button" type="button" id="merge-confirm" ${state.mergeItems.length < 2 ? "disabled" : ""}>开始合并（${formatCount(state.mergeItems.length)} 段 · 约 ${formatSize(totalBytes)}）</button>
    </span>`;
}

export function updateMergeModal(): void {
  const dialog = app.querySelector<HTMLElement>("#merge-videos-modal .merge-modal");
  if (!dialog) return;
  dialog.outerHTML = renderMergeDialog();
  // dialog 是新的，但 backdrop 还是原来那个——清掉容器级标记让 binder 重跑。
  const backdrop = app.querySelector<HTMLElement>("#merge-videos-modal");
  if (backdrop) delete backdrop.dataset.boundRegion;
  bindMergeModalEvents();
  // The replaced dialog lost its inline geometry and resize handles.
  applyDialogSizes();
  setupDialogResizing();
}

export function mergeUpdateFooter(): void {
  const footer = app.querySelector<HTMLElement>("#merge-modal-footer");
  if (!footer) return;
  footer.innerHTML = renderMergeFooterInner();
  bindMergeFooterEvents();
}

export function renderLibraryEmpty(): string {
  if (state.loading)
    return `<div class="empty-state"><span class="empty-icon spinner large"></span><h2>正在读取媒体库</h2><p>正在从 Tauri 后端加载索引。</p></div>`;
  if (state.availability === "unconfigured")
    return `<div class="empty-state setup-state"><span class="empty-icon">⌂</span><h2>还没有媒体库</h2><p>选择一个本地媒体目录，Camlib 会建立可搜索的索引。</p><div class="library-form"><button class="primary-button" id="choose-folder-button" type="button">选择文件夹…</button><details class="manual-path"><summary>手动输入路径</summary><form id="library-form"><input id="library-path" required placeholder="例如：D:\\照片" aria-label="媒体库路径" /><button class="outline-button" type="submit">连接媒体库</button></form></details></div></div>`;
  if (!state.library)
    return `<div class="empty-state"><span class="empty-icon">◎</span><h2>找不到媒体库记录</h2><p>请重新连接媒体库。</p></div>`;
  if (!state.page.total)
    return `<div class="empty-state"><span class="empty-icon">✦</span><h2>${hasAnyFilter(state) ? "没有匹配的媒体" : "媒体库还是空的"}</h2><p>${hasAnyFilter(state) ? "试试调整搜索或筛选条件。" : "点击右上角“扫描媒体库”开始建立索引。"}</p></div>`;
  return "";
}

export function renderTagManager(): string {
  if (!state.tagsManagerOpen) return "";
  const busy = state.tagsManagerBusy;
  const rows = state.tags.length
    ? state.tags
        .map((tag) => {
          const confirming = state.tagDeleteConfirmId === tag.id;
          return `<li class="tag-manager-row" data-tag-id="${escapeHtml(tag.id)}">
          <span class="tag-manager-swatch" ${tag.color ? `style="background:${escapeHtml(tag.color)}"` : ""}></span>
          <input class="tag-manager-name" data-rename-tag="${escapeHtml(tag.id)}" value="${escapeHtml(tag.name)}" aria-label="标签名称" ${busy ? "disabled" : ""} />
          <span class="tag-manager-count">${formatCount(tag.mediaCount ?? 0)} 项</span>
          ${
            confirming
              ? `<span class="tag-manager-confirm"><span>删除后无法恢复</span><button type="button" class="danger-button" data-confirm-delete-tag="${escapeHtml(tag.id)}" ${busy ? "disabled" : ""}>确认删除</button><button type="button" class="text-button" data-cancel-delete-tag>取消</button></span>`
              : `<button type="button" class="text-button" data-start-delete-tag="${escapeHtml(tag.id)}" ${busy ? "disabled" : ""}>删除</button>`
          }
        </li>`;
        })
        .join("")
    : `<li class="tag-manager-empty">还没有标签，在上方新建一个吧。</li>`;
  return `<div class="modal-backdrop tag-manager-backdrop" id="tag-manager-backdrop" role="presentation">
    <div class="tag-manager" role="dialog" aria-modal="true" aria-labelledby="tag-manager-title">
      <header class="tag-manager-header">
        <div>
          <h2 id="tag-manager-title">标签管理</h2>
          <span>新建、改名或删除标签。给媒体打标时只能选用已有标签。</span>
        </div>
        <button class="icon-button" type="button" id="close-tag-manager" aria-label="关闭标签管理">×</button>
      </header>
      <form class="tag-manager-create" id="tag-create-form">
        <input id="tag-create-name" placeholder="新标签名称" aria-label="新标签名称" autocomplete="off" ${busy ? "disabled" : ""} />
        <button class="primary-button" type="submit" ${busy ? "disabled" : ""}>${busy ? "处理中…" : "新建"}</button>
      </form>
      ${state.tagsManagerError ? `<div class="notice-banner is-error" role="alert"><span class="notice-icon">!</span><span>${escapeHtml(state.tagsManagerError)}</span></div>` : ""}
      <ul class="tag-manager-list">${rows}</ul>
      <footer class="tag-manager-footer">
        <span>改名请直接编辑后按回车或失焦保存</span>
        <button class="outline-button" type="button" id="close-tag-manager-footer">完成</button>
      </footer>
    </div>
  </div>`;
}
