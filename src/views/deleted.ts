/**
 * 侧栏「已删除」只读列表（overlay：`[data-overlay="deleted"]`）。
 *
 * 只读是硬约束：没有应用内还原。Windows 回收站才是唯一还原入口，所以文案必须
 * 指向系统回收站；这里不给任何看起来能撤销的按钮。
 */
import { DELETED_ITEMS_LIMIT, type DeletedItemDto } from "../api/deleted";
import { formatCaptureAt, formatCount, truncatePath } from "../lib/format";
import { escapeHtml } from "../render/text";
import { state } from "../state";

const KIND_LABEL: Record<DeletedItemDto["kind"], string> = {
  photo: "照片",
  video: "视频",
  live: "实况",
};

/** 缩略图占位：文件已进回收站，缩略图缓存也已失效，用字形代替图片。 */
const KIND_GLYPH: Record<DeletedItemDto["kind"], string> = {
  photo: "▣",
  video: "▶",
  live: "◉",
};

function renderRow(item: DeletedItemDto): string {
  const path = item.relativePath || "（路径已不可用）";
  const capture = item.captureDate ? ` · 拍摄于 ${escapeHtml(item.captureDate)}` : "";
  // 日志里的相对路径理论上不会为空（写入时必带）；真为空时按钮禁用并说明原因，
  // 而不是留一个点了没反应的按钮。
  const openButton = item.relativePath
    ? `<button class="outline-button deleted-open" type="button" data-open-deleted="${escapeHtml(item.relativePath)}">在资源管理器中打开</button>`
    : `<button class="outline-button deleted-open" type="button" disabled title="这条删除记录没有保存原始路径">路径不可用</button>`;
  return `<div class="deleted-row" data-deleted-row="${escapeHtml(item.id)}">
      <span class="deleted-thumb deleted-thumb-${item.kind}" aria-hidden="true">${KIND_GLYPH[item.kind]}</span>
      <span class="deleted-main">
        <strong class="deleted-name" title="${escapeHtml(item.displayName)}">${escapeHtml(item.displayName)}</strong>
        <span class="deleted-path" title="${escapeHtml(path)}">${escapeHtml(truncatePath(path, 64))}</span>
      </span>
      <span class="deleted-kind">${KIND_LABEL[item.kind]}${capture}</span>
      <time class="deleted-time">${escapeHtml(formatCaptureAt(item.deletedAt) ?? "时间未知")}</time>
      ${openButton}
    </div>`;
}

function renderBody(): string {
  if (state.deletedLoading) {
    return `<div class="deleted-state"><span class="spinner" aria-hidden="true"></span><span>正在读取删除记录…</span></div>`;
  }
  if (state.deletedError) {
    return `<div class="deleted-state is-error" role="alert"><span>${escapeHtml(state.deletedError)}</span><button class="outline-button" type="button" id="deleted-retry">重试</button></div>`;
  }
  if (!state.deletedItems.length) {
    return `<div class="deleted-state"><strong>还没有删除记录</strong><span>在媒体库中删除的媒体会出现在这里。文件在 Windows 回收站，可从系统回收站还原。</span></div>`;
  }
  return `<div class="deleted-table" role="table" aria-label="已删除媒体">
      <div class="deleted-table-head" role="row">
        <span role="columnheader">媒体</span>
        <span role="columnheader">类型</span>
        <span role="columnheader">删除时间</span>
        <span role="columnheader"><span class="visually-hidden">操作</span></span>
      </div>
      ${state.deletedItems.map(renderRow).join("")}
    </div>`;
}

function renderFooterNote(): string {
  const limit = formatCount(DELETED_ITEMS_LIMIT);
  if (state.deletedTotal > state.deletedItems.length) {
    return `只显示最近 ${limit} 条删除记录 · 共 ${formatCount(state.deletedTotal)} 条`;
  }
  return `只显示最近 ${limit} 条删除记录`;
}

export function renderDeletedPanel(): string {
  if (!state.deletedOpen) return "";
  return `<div class="modal-backdrop deleted-backdrop" id="deleted-backdrop" role="presentation">
      <div class="deleted-panel" role="dialog" aria-modal="true" aria-labelledby="deleted-title" aria-describedby="deleted-hint">
        <header class="deleted-header">
          <div>
            <h2 id="deleted-title">已删除</h2>
            <span id="deleted-hint">文件在 Windows 回收站，可从系统回收站还原。</span>
          </div>
          <button class="icon-button" type="button" id="close-deleted" aria-label="关闭已删除列表" data-autofocus>×</button>
        </header>
        <div class="deleted-body">${renderBody()}</div>
        <footer class="deleted-footer">
          <span>${renderFooterNote()}</span>
          <button class="text-button" type="button" id="deleted-close-footer">关闭</button>
        </footer>
      </div>
    </div>`;
}
