import { MediaItemDto, PreviewMetaDto } from "../../api/media";
import { formatCaptureAt, formatCount, formatDuration, formatSize } from "../../lib/format";
import { starsHtml } from "../../render/grid";
import { escapeHtml, fileRoleLabel, formatDate, formatDimensions, kindLabel } from "../../render/text";
import { state } from "../../state";
import { previewUi } from "./state";

// 由 main.ts 拆分而来：仅做搬移，未改动逻辑。

export function renderStars(rating: number, interactive: boolean, mediaId?: string): string {
  return starsHtml(rating, { interactive, mediaId });
}

export function renderMetaPanel(meta: PreviewMetaDto | null, item: MediaItemDto): string {
  if (!meta) return `<div class="meta-placeholder">元数据加载中…</div>`;
  const rows: Array<[string, string]> = [
    ["类型", kindLabel(item.kind)],
    ["尺寸", formatDimensions(meta)],
    ["大小", formatSize(meta.totalSizeBytes)],
  ];
  if (meta.durationMs != null && meta.durationMs > 0) rows.push(["时长", formatDuration(meta.durationMs)]);
  const captureAt = formatCaptureAt(meta.captureAt);
  if (captureAt) rows.push(["拍摄时间", captureAt]);
  if (meta.captureDate) rows.push(["拍摄日期", formatDate(meta.captureDate)]);
  rows.push([
    "状态",
    meta.scanState === "present"
      ? "在库"
      : meta.scanState === "missing"
        ? "离线"
        : meta.scanState === "ambiguous"
          ? "待确认"
          : "错误",
  ]);
  if (meta.burstGroup) rows.push(["连拍组", meta.burstGroup]);
  if (meta.favorite) rows.push(["收藏", "是"]);
  const files = meta.files
    .map(
      (file) =>
        `<li class="meta-file ${file.existsNow ? "" : "is-missing"}"><span class="meta-file-role">${fileRoleLabel(file.role)}</span><span class="meta-file-name" title="${escapeHtml(file.relativePath)}">${escapeHtml(file.fileName)}</span><span class="meta-file-size">${formatSize(file.sizeBytes)}</span>${file.existsNow ? "" : `<span class="meta-file-state">缺失</span>`}</li>`,
    )
    .join("");
  // One merged tag block: user chips first, then AI-only chips. A tag the
  // item carries through both tables renders once — as the user chip with an
  // AI badge (hasAi is item-level for preview tags) — so its × always removes
  // the manual attachment first.
  const aiTags = meta.aiTags ?? [];
  const manualIds = new Set(meta.tags.map((tag) => tag.id));
  const aiOnlyTags = aiTags
    .filter((tag) => !manualIds.has(tag.id))
    .sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN"));
  const tagChips = [
    ...meta.tags.map(
      (tag) =>
        `<span class="tag-chip${tag.hasAi ? " tag-chip-ai" : ""}" ${tag.color ? `style="--tag-accent:${escapeHtml(tag.color)}"` : ""}>${tag.hasAi ? `<i class="ai-badge" aria-label="该标签同时由 AI 打标">AI</i>` : ""}<span>${escapeHtml(tag.name)}</span><button type="button" class="tag-remove" data-remove-tag="${escapeHtml(tag.id)}" aria-label="移除标签 ${escapeHtml(tag.name)}">×</button></span>`,
    ),
    ...aiOnlyTags.map(
      (tag) =>
        `<span class="tag-chip tag-chip-ai"><i class="ai-badge" aria-hidden="true">AI</i><span>${escapeHtml(tag.name)}</span><button type="button" class="tag-remove" data-remove-ai-tag="${escapeHtml(tag.id)}" aria-label="移除 AI 标签 ${escapeHtml(tag.name)}">×</button></span>`,
    ),
  ].join("");
  const remainingTags = state.tags
    .filter((tag) => !manualIds.has(tag.id) && !aiTags.some((attached) => attached.id === tag.id))
    .sort((a, b) => (b.mediaCount ?? 0) - (a.mediaCount ?? 0) || a.name.localeCompare(b.name, "zh-Hans-CN"));
  // With AI tagging the tag pool can grow large, so remaining tags live in a
  // searchable picker instead of a flat row of every suggestion.
  const tagPickerRows = remainingTags
    .map(
      (tag) =>
        `<button type="button" class="tag-picker-row" data-add-tag="${escapeHtml(tag.id)}" data-tag-name="${escapeHtml(tag.name.toLowerCase())}"><span class="tag-picker-name">${escapeHtml(tag.name)}</span>${tag.mediaCount != null ? `<span class="tag-picker-count">${formatCount(tag.mediaCount)} 项</span>` : ""}</button>`,
    )
    .join("");
  const tagAddControl = remainingTags.length
    ? previewUi.tagPickerOpen
      ? `<div class="tag-picker" id="preview-tag-picker"><div class="tag-picker-search"><span aria-hidden="true">⌕</span><input id="preview-tag-picker-input" type="text" placeholder="搜索标签" value="${escapeHtml(previewUi.tagPickerQuery)}" aria-label="搜索标签" /></div><div class="tag-picker-list" id="preview-tag-picker-list">${tagPickerRows}<div class="tag-picker-empty" data-picker-empty hidden>没有匹配的标签</div></div></div>`
      : `<button type="button" class="tag-add-button" id="toggle-preview-tag-picker">＋ 添加标签</button>`
    : state.tags.length
      ? `<div class="tag-empty">该媒体已带有全部标签</div>`
      : `<div class="tag-empty">还没有标签，请先在「标签管理」中新建</div>`;
  return `<div class="meta-panel-body">
    <h3>媒体信息</h3>
    <div class="meta-rating-block">
      <span class="meta-rating-label">评分</span>
      ${renderStars(meta.rating, true, item.id)}
      ${meta.rating > 0 ? `<button type="button" class="text-button" data-set-rating="0" data-media-id="${escapeHtml(item.id)}">清除</button>` : ""}
    </div>
    <dl class="meta-list">${rows.map(([label, value]) => `<div class="meta-row"><dt>${label}</dt><dd>${escapeHtml(String(value))}</dd></div>`).join("")}</dl>
    <div class="meta-tags-block">
      <div class="meta-tags-head">
        <h4>标签</h4>
        <button type="button" class="text-button" id="open-tag-manager-from-preview">管理标签</button>
      </div>
      <div class="tag-chip-row" id="preview-tag-chips">${tagChips || `<span class="tag-empty">暂无标签</span>`}</div>
      ${tagAddControl}
    </div>
    ${
      item.kind !== "video"
        ? `<div class="meta-ai-block">
      <div class="meta-tags-head"><h4>AI 描述</h4><span class="ai-badge" aria-hidden="true">AI</span><span class="meta-ai-tools"><button type="button" class="text-button" id="preview-ask-ai" title="关闭预览并打开 AI 助手，自动带上这张照片的上下文">问 AI 助手</button>${meta.aiCaption || (meta.aiTags && meta.aiTags.length) ? `<button type="button" class="text-button" id="preview-ai-tag" data-media-id="${escapeHtml(item.id)}" ${state.aiSingleBusy || state.aiJobId ? "disabled" : ""}>重新打标</button>` : `<button type="button" class="text-button" id="preview-ai-tag" data-media-id="${escapeHtml(item.id)}" ${state.aiSingleBusy || state.aiJobId ? "disabled" : ""}>AI 打标</button>`}</span></div>
      ${meta.aiCaption ? `<p class="meta-ai-caption">${escapeHtml(meta.aiCaption)}</p>` : `<p class="meta-ai-caption meta-ai-empty">尚未生成。将发送该照片缩略图到你配置的 AI 服务。</p>`}
    </div>`
        : ""
    }
    <h4>关联文件</h4>
    <ul class="meta-files">${files}</ul>
  </div>`;
}
