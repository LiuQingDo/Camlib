// 由 main.ts 拆分而来：仅做搬移，未改动逻辑。
import { AiConfigDto, AiProfileDto, AiRunMode } from "../api/ai";
import type { AiProviderPreset } from "../lib/ai-providers";
import {
  consoleHost,
  filterProviderPresets,
  findProfile,
  findProvider,
  pickActiveProfile,
  pickerPresets,
  profileLabel,
  profileSummary,
  profileTitle,
  protocolMeta,
  providerEndpoints,
  providerRegions,
  regionForBaseUrl,
  resolveProviderId,
} from "../lib/ai-providers";
import { formatCaptureAt, formatCount, formatEtaSeconds, formatSize, formatSpeed, truncatePath } from "../lib/format";
import { app } from "../render/context";
import { bindSettingsEvents, persistUiPrefs, render } from "../render/paint";
import {
  backupStatusLabel,
  escapeHtml,
  facetTotal,
  libraryAvailabilityLabel,
  pathBaseName,
  scanRunStatusLabel,
} from "../render/text";
import { scanPercentLabel, scanStatusLabel } from "../render/toolbar";
import { SettingsSection, state } from "../state";
import { DIALOG_SPECS, applyDialogSizes, mergeGroupMatches } from "./dialogs";

export const SETTINGS_SECTIONS: Array<{ id: SettingsSection; label: string }> = [
  { id: "library", label: "媒体库" },
  { id: "index", label: "扫描与索引" },
  { id: "thumbnails", label: "缩略图" },
  { id: "backup", label: "备份默认" },
  { id: "ai", label: "AI 增强" },
  { id: "system", label: "系统" },
  { id: "about", label: "关于" },
];

export function pathRow(label: string, path: string | null | undefined, openKind?: string): string {
  const full = path ?? "";
  return `<div class="settings-path-row">
    <div class="settings-path-copy">
      <span class="settings-path-label">${escapeHtml(label)}</span>
      <span class="settings-path-value" title="${escapeHtml(full)}">${escapeHtml(truncatePath(full))}</span>
    </div>
    <div class="settings-path-actions">
      ${full ? `<button class="text-button" type="button" data-copy-path="${escapeHtml(full)}" title="复制完整路径">复制</button>` : ""}
      ${full && openKind ? `<button class="text-button" type="button" data-open-dir="${escapeHtml(openKind)}">打开</button>` : ""}
    </div>
  </div>`;
}

export function renderSettingsLibrarySection(): string {
  const library = state.library;
  const summary = state.indexSummary;
  return `<div class="settings-section-body">
    <div class="settings-status-card">
      <div class="settings-status-head">
        <div>
          <strong>${escapeHtml(library?.volumeLabel || library?.driveLetter ? `${library?.volumeLabel ?? "本地磁盘"} ${library?.driveLetter ? `(${library.driveLetter}:)` : ""}`.trim() : "媒体库")}</strong>
          <span class="settings-status-pill is-${state.availability}">${libraryAvailabilityLabel(state.availability)}</span>
        </div>
      </div>
      ${state.rootPath ? pathRow("根路径", state.rootPath, "library") : `<div class="settings-note">尚未选择媒体库目录。</div>`}
      ${state.libraryStatusReason ? `<div class="settings-note is-warning">${escapeHtml(state.libraryStatusReason)}</div>` : ""}
      <dl class="settings-kv">
        <div><dt>最后扫描</dt><dd>${escapeHtml(formatCaptureAt(library?.lastScanAt ?? null) || "尚未扫描")}</dd></div>
        <div><dt>扫描代数</dt><dd>${library ? formatCount(library.scanGeneration) : "—"}</dd></div>
        <div><dt>媒体项</dt><dd>${summary ? formatCount(summary.totalItems) : library && state.availability === "available" ? formatCount(facetTotal()) : "—"}</dd></div>
        <div><dt>卷 ID</dt><dd class="mono" title="${escapeHtml(library?.volumeId ?? "")}">${escapeHtml(truncatePath(library?.volumeId ?? null, 28))}</dd></div>
      </dl>
      <div class="settings-actions">
        <button class="primary-button" type="button" id="settings-change-library">更换媒体库</button>
        <button class="outline-button" type="button" id="settings-rescan-library" ${state.scanning || !library || state.availability !== "available" ? "disabled" : ""}>${state.scanning ? "扫描中…" : "重新扫描"}</button>
        <button class="outline-button" type="button" id="settings-open-app-data">打开数据目录</button>
        <button class="outline-button" type="button" id="settings-open-thumbnail-cache">打开缓存目录</button>
      </div>
    </div>
  </div>`;
}

export function renderSettingsIndexSection(): string {
  const summary = state.indexSummary;
  const runs = state.scanRuns;
  const mergePreview = state.libraryMergePreview;
  const mergeProgress = state.libraryMergeProgress;
  const mergeRunning = Boolean(state.libraryMergeJobId) || mergeProgress?.state === "running";
  const mergePercent =
    mergeProgress && mergeProgress.bytesTotal > 0
      ? Math.min(100, Math.max(0, Math.round((mergeProgress.bytesProcessed / mergeProgress.bytesTotal) * 100)))
      : 0;
  const selectedGroups = mergePreview
    ? mergePreview.groups.filter((group) => state.libraryMergeSelected.has(group.destinationRelative))
    : [];
  const selectedBytes = selectedGroups.reduce((sum, group) => sum + group.sizeBytes, 0);
  const selectedSegments = selectedGroups.reduce((sum, group) => sum + group.sources.length, 0);
  const mergeSpaceOk = !mergePreview || mergePreview.freeBytes === null || mergePreview.freeBytes >= selectedBytes;
  const mergeQuery = state.libraryMergeFilter.trim().toLowerCase();
  const visibleGroups = mergePreview ? mergePreview.groups.filter((group) => mergeGroupMatches(group, mergeQuery)) : [];
  const canStartMerge = Boolean(mergePreview) && selectedGroups.length > 0 && mergeSpaceOk && !mergeRunning;
  return `<div class="settings-section-body">
    <div class="settings-status-card">
      <h3>索引摘要</h3>
      ${
        summary
          ? `<div class="settings-stat-grid">
        <div><span>照片</span><strong>${formatCount(summary.photos)}</strong></div>
        <div><span>视频</span><strong>${formatCount(summary.videos)}</strong></div>
        <div><span>实况</span><strong>${formatCount(summary.live)}</strong></div>
        <div><span>收藏</span><strong>${formatCount(summary.favorites)}</strong></div>
        <div><span>离线</span><strong>${formatCount(summary.missing)}</strong></div>
        <div><span>占用</span><strong>${formatSize(summary.totalSizeBytes)}</strong></div>
      </div>
      <div class="settings-note">最后扫描：${escapeHtml(formatCaptureAt(summary.lastScanAt) || "尚未扫描")} · 代数 ${summary.scanGeneration}</div>`
          : `<div class="settings-note">${state.library ? "加载索引摘要…" : "请先连接媒体库。"}</div>`
      }
      <div class="settings-actions">
        <button class="outline-button" type="button" id="settings-incremental-scan" ${state.scanning || !state.library || state.availability !== "available" ? "disabled" : ""}>${state.scanning ? "扫描中…" : "增量扫描"}</button>
        <button class="danger-button" type="button" id="settings-full-rebuild" ${state.scanning || !state.library || state.availability !== "available" ? "disabled" : ""}>全量重建索引</button>
        <button class="danger-button" type="button" id="settings-purge-missing" ${state.scanning || !state.library || state.availability !== "available" || !summary || summary.missing <= 0 ? "disabled" : ""}>清理离线条目</button>
      </div>
      ${
        state.fullRebuildConfirm
          ? `<div class="settings-confirm">
        <p>全量重建会重新读取库内全部文件的元数据，比增量扫描更耗时。收藏、标签与评分会保留。是否继续？</p>
        <div class="settings-actions">
          <button class="outline-button" type="button" id="settings-full-rebuild-cancel">取消</button>
          <button class="danger-button confirm-danger" type="button" id="settings-full-rebuild-confirm">确认全量重建</button>
        </div>
      </div>`
          : ""
      }
      ${
        state.purgeMissingConfirm
          ? `<div class="settings-confirm">
        <p>将从索引中移除全部 ${formatCount(summary?.missing ?? 0)} 个离线条目（文件已不在媒体库里的卡片，例如合并后回收的分段）。只影响索引记录，不会删除任何文件。是否继续？</p>
        <div class="settings-actions">
          <button class="outline-button" type="button" id="settings-purge-missing-cancel">取消</button>
          <button class="danger-button confirm-danger" type="button" id="settings-purge-missing-confirm">确认清理</button>
        </div>
      </div>`
          : ""
      }
      ${state.scanning && state.scanProgress ? `<div class="settings-note">当前：${escapeHtml(scanStatusLabel(state.scanProgress))} · ${escapeHtml(scanPercentLabel(state.scanProgress))}<button class="text-button" type="button" id="settings-scan-cancel">取消扫描</button></div>` : ""}
    </div>
    <div class="settings-status-card">
      <h3>整理历史分段</h3>
      <div class="settings-note">把媒体库里相机自动截断的分段视频无损合并成完整长视频。只合并同一 VID_日期_时间、且末尾序号连续的文件；时间不同的相邻序号（例如 150035_122 和 150534_123）不会合并。生成预览后可以勾选其中几组，不必一次处理全部。合并成功后可选把原分段移入回收站，并自动增量扫描入库。</div>
      ${state.libraryMergeNotice ? `<div class="settings-note">${escapeHtml(state.libraryMergeNotice)}</div>` : ""}
      ${
        mergePreview
          ? `<div class="settings-stat-grid">
        <div><span>已选</span><strong>${formatCount(selectedGroups.length)} / ${formatCount(mergePreview.groupCount)} 组</strong></div>
        <div><span>分段</span><strong>${formatCount(selectedSegments)}</strong></div>
        <div><span>大小</span><strong>${formatSize(selectedBytes)}</strong></div>
        <div><span>目标剩余</span><strong class="${mergeSpaceOk ? "" : "is-danger"}">${mergePreview.freeBytes === null ? "不可用" : formatSize(mergePreview.freeBytes)}</strong></div>
      </div>
      ${
        mergePreview.groupCount === 0
          ? `<div class="settings-note">没有需要合并的分段视频。</div>`
          : `
      <div class="merge-pick-tools">
        <input id="library-merge-filter" value="${escapeHtml(state.libraryMergeFilter)}" placeholder="筛选文件名或时间戳" aria-label="筛选分段" ${mergeRunning ? "disabled" : ""} />
        <button class="text-button" type="button" id="library-merge-select-visible" ${mergeRunning || visibleGroups.length === 0 ? "disabled" : ""}>${mergeQuery ? "全选当前" : "全选"}</button>
        <button class="text-button" type="button" id="library-merge-clear-visible" ${mergeRunning || visibleGroups.length === 0 ? "disabled" : ""}>${mergeQuery ? "清除当前" : "全不选"}</button>
      </div>
      <div class="merge-pick-list" id="library-merge-list">${visibleGroups.map((group) => `<label class="merge-pick"><input type="checkbox" data-merge-dest="${escapeHtml(group.destinationRelative)}" ${state.libraryMergeSelected.has(group.destinationRelative) ? "checked" : ""} ${mergeRunning ? "disabled" : ""} /><span class="merge-pick-name">${escapeHtml(group.sources.map(pathBaseName).join(" + "))}</span><span class="merge-pick-meta">→ ${escapeHtml(group.fileName)} · ${formatSize(group.sizeBytes)}</span></label>`).join("")}${visibleGroups.length === 0 ? `<div class="settings-note">没有符合筛选的分组。</div>` : ""}</div>
      ${selectedGroups.length === 0 ? `<div class="settings-note">请至少勾选一组再合并。</div>` : ""}
      ${selectedGroups.length > 0 && !mergeSpaceOk ? `<div class="settings-note is-danger">所选分段需要的空间超过目标盘剩余，无法开始合并。</div>` : ""}`
      }`
          : `<div class="settings-note">${state.libraryMergeLoading ? "正在扫描分段…" : "先生成预览，再勾选要合并的组。"}</div>`
      }
      <div class="settings-actions">
        <button class="outline-button" type="button" id="library-merge-preview" ${!state.library || state.availability !== "available" || mergeRunning || state.libraryMergeLoading ? "disabled" : ""}>${state.libraryMergeLoading ? "扫描中…" : mergePreview ? "刷新预览" : "生成预览"}</button>
        <button class="primary-button" type="button" id="library-merge-start" ${canStartMerge ? "" : "disabled"}>${mergeRunning ? "合并中…" : selectedGroups.length > 0 && mergePreview && selectedGroups.length < mergePreview.groupCount ? `合并所选 ${formatCount(selectedGroups.length)}` : "开始合并"}</button>
      </div>
      ${mergePreview && mergePreview.groupCount > 0 && !mergeRunning ? `<label class="settings-note"><input type="checkbox" id="library-merge-recycle" ${state.libraryMergeRecycle ? "checked" : ""} /> 合并成功后把原分段移入回收站（可再从回收站恢复）</label>` : ""}
      ${
        state.libraryMergeConfirm
          ? `<div class="settings-confirm">
        <p>将合并已勾选的 ${formatCount(selectedGroups.length)} 组（约 ${formatSize(selectedBytes)}，共 ${formatCount(mergePreview?.groupCount ?? 0)} 组可选）。合并过程用 ffmpeg 无损拼接，源分段在校验成功前不会删除。${state.libraryMergeRecycle ? "成功后原分段会移入回收站。" : "原分段会保留在库里。"}是否开始？</p>
        <div class="settings-actions">
          <button class="outline-button" type="button" id="library-merge-confirm-cancel">取消</button>
          <button class="primary-button" type="button" id="library-merge-confirm-start">确认合并</button>
        </div>
      </div>`
          : ""
      }
      ${
        mergeProgress
          ? `<div class="scan-banner" role="status" aria-live="polite">
        <div class="scan-copy">
          ${mergeProgress.state === "running" ? `<span class="spinner"></span>` : ""}
          <span>${mergeProgress.state === "completed" ? "分段整理完成" : mergeProgress.state === "cancelled" ? "分段整理已取消" : mergeProgress.state === "failed" ? "分段整理失败" : "正在合并分段"}</span>
          <strong>${mergeProgress.state === "running" ? `${mergePercent}%` : `${formatCount(mergeProgress.groupProcessed)} / ${formatCount(mergeProgress.groupTotal)} 组`}</strong>
          ${mergeRunning ? `<button class="text-button" type="button" id="library-merge-cancel">取消</button>` : ""}
        </div>
        <div class="progress-track${mergeProgress.state === "running" && mergeProgress.bytesTotal <= 0 ? " is-indeterminate" : ""}">
          <span style="width:${mergeProgress.state === "running" && mergeProgress.bytesTotal <= 0 ? "35%" : `${mergePercent}%`}"></span>
        </div>
        <div class="scan-current">${escapeHtml(mergeProgress.currentFile || (mergeProgress.state === "running" ? "准备中" : ""))} · ${formatCount(mergeProgress.groupProcessed)} / ${formatCount(mergeProgress.groupTotal)} 组 · ${formatSize(mergeProgress.bytesProcessed)} / ${formatSize(mergeProgress.bytesTotal)}${mergeProgress.speedBytesPerSec > 0 ? ` · ${formatSpeed(mergeProgress.speedBytesPerSec)}` : ""}${mergeProgress.etaSeconds ? ` · 剩余 ${formatEtaSeconds(mergeProgress.etaSeconds)}` : ""}</div>
        <div class="backup-note">${mergeProgress.state === "running" ? "取消会在当前分段的安全点停止：未提交的临时文件会删除；已合并完成的文件会保留。" : mergeProgress.error ? escapeHtml(mergeProgress.error) : ""}</div>
      </div>`
          : ""
      }
    </div>
    <div class="settings-status-card">
      <h3>最近扫描</h3>
      ${
        runs.length
          ? `<div class="settings-scan-runs">${runs
              .map(
                (run) => `<div class="settings-scan-run">
        <span class="run-status is-${run.status}">${scanRunStatusLabel(run.status)}</span>
        <span>${escapeHtml(formatCaptureAt(run.startedAt) || run.startedAt)}</span>
        <span>文件 ${formatCount(run.filesSeen)} · 新增 ${formatCount(run.itemsAdded)} · 更新 ${formatCount(run.itemsUpdated)} · 缺失 ${formatCount(run.itemsMissing)}</span>
        ${run.errorSummary ? `<span class="run-error" title="${escapeHtml(run.errorSummary)}">${escapeHtml(run.errorSummary)}</span>` : ""}
      </div>`,
              )
              .join("")}</div>`
          : `<div class="settings-note">还没有扫描记录。</div>`
      }
    </div>
  </div>`;
}

export function renderSettingsThumbnailSection(): string {
  const stats = state.thumbnailStats;
  const progress = state.thumbnailProgress;
  return `<div class="settings-section-body">
    <div class="settings-status-card">
      <h3>缩略图缓存</h3>
      {pathRowPlaceholder}
      <dl class="settings-kv">
        <div><dt>缓存文件</dt><dd>${stats ? formatCount(stats.fileCount) : "—"}</dd></div>
        <div><dt>占用空间</dt><dd>${stats ? formatSize(stats.totalBytes) : "—"}</dd></div>
      </dl>
      <form class="settings-form" id="settings-thumbnail-form">
        <label><span>缓存目录</span><input id="settings-thumbnail-path" value="${escapeHtml(state.thumbnailCacheDir)}" spellcheck="false" /></label>
        <div class="settings-actions">
          <button class="outline-button" type="button" id="settings-choose-thumbnail">选择文件夹…</button>
          <button class="primary-button" type="submit">保存目录</button>
          <button class="outline-button" type="button" id="settings-rebuild-thumbnails" ${!state.library || state.thumbnailRebuilding || state.availability !== "available" ? "disabled" : ""}>${state.thumbnailRebuilding ? "重建中…" : "重建缩略图"}</button>
        </div>
      </form>
      ${progress ? `<div class="settings-note">${progress.state === "running" ? `重建中：${formatCount(progress.processed)} / ${formatCount(progress.total)}` : progress.state === "completed" ? "缩略图重建完成。" : progress.state === "cancelled" ? "缩略图重建已取消。" : `缩略图重建失败：${escapeHtml(progress.error ?? "未知错误")}`}${progress.state === "running" && state.thumbnailJobId ? `<button class="text-button" type="button" id="settings-thumbnail-cancel">取消</button>` : ""}</div>` : ""}
      <div class="settings-note">修改目录后，旧缓存仍留在原位置；需要时可手动清理。</div>
    </div>
  </div>`.replace("{pathRowPlaceholder}", pathRow("当前缓存路径", state.thumbnailCacheDir, "thumbnail_cache"));
}

export function renderSettingsBackupSection(): string {
  return `<div class="settings-section-body">
    <div class="settings-status-card">
      <h3>备份默认项</h3>
      <div class="settings-note">这里保存的默认值会与「相机备份」面板共用，避免两处真相。预览时仍可临时调整。</div>
      <div class="settings-form">
        <label><span>默认忽略扩展名</span><input id="settings-ignore-extensions" value="${escapeHtml(state.backupIgnoreExtensions)}" spellcheck="false" placeholder=".dng, .lrv" /></label>
        <label><span>默认冲突策略</span><select id="settings-conflict-policy">
          <option value="skip_same" ${state.backupConflictPolicy === "skip_same" ? "selected" : ""}>跳过冲突</option>
          <option value="rename" ${state.backupConflictPolicy === "rename" ? "selected" : ""}>自动重命名</option>
          <option value="overwrite" ${state.backupConflictPolicy === "overwrite" ? "selected" : ""}>覆盖目标</option>
        </select></label>
        <label><span>默认分段合并</span><select id="settings-merge-segments">
          <option value="on" ${state.backupMergeSegments ? "selected" : ""}>合并为完整视频</option>
          <option value="off" ${state.backupMergeSegments ? "" : "selected"}>保留原分段</option>
        </select></label>
        <div class="settings-actions">
          <button class="primary-button" type="button" id="settings-save-backup-defaults">保存默认项</button>
          <button class="outline-button" type="button" id="settings-open-backup-panel">打开备份面板</button>
        </div>
      </div>
    </div>
  </div>`;
}

/** AI 增强（可选）：供应商面板（列表 / 添加 / 配置）、批量处理入口。 */
export function renderSettingsAiSection(): string {
  const config = state.aiDraft ?? state.aiConfig;
  if (!config) {
    return `<div class="settings-section-body"><div class="settings-status-card"><div class="settings-note">加载 AI 配置…</div></div></div>`;
  }
  const running = Boolean(state.aiJobId) || state.aiProgress?.state === "running";
  const progress = state.aiProgress;
  const percent =
    progress && progress.total > 0
      ? Math.min(100, Math.max(0, Math.round((progress.processed / progress.total) * 100)))
      : 0;
  const stats = state.aiStats;
  const preview = state.aiPreview;
  const active = pickActiveProfile(config);
  const modeLabels: Record<AiRunMode, string> = {
    incremental: "增量处理（仅未处理过的照片）",
    full: "全量重跑（重新打标所有照片）",
    retry: "仅重试失败项",
  };
  const activePreset = active ? findProvider(active.provider) : null;
  const statusLine = active
    ? `${escapeHtml(profileLabel(active))}${config.enabled ? " · 已启用" : " · 未启用"}`
    : "尚未添加供应商";
  return `<div class="settings-section-body">
    <div class="settings-status-card">
      <div class="ai-card-head">
        <div class="ai-card-title">
          <h3>AI 模型</h3>
          <p class="settings-note">可选增强，<strong>默认关闭</strong>。开启并执行处理后，照片缩略图（约 512px 压缩图，非原图）会发送到你选择的服务商；标签与描述只存在本地索引。</p>
        </div>
        <label class="ai-switch" title="${config.profiles.length === 0 ? "请先添加供应商" : "启用 AI 增强"}">
          <input type="checkbox" id="settings-ai-enabled" ${config.enabled ? "checked" : ""} ${config.profiles.length === 0 ? "disabled" : ""} aria-label="启用 AI 增强" />
          <span class="ai-switch-track"><span class="ai-switch-thumb"></span></span>
        </label>
      </div>
      <div class="ai-current-bar">
        <span class="ai-current-dot ${active && config.enabled ? "is-on" : ""}" aria-hidden="true"></span>
        <span class="ai-current-copy"><span>当前使用</span><strong>${statusLine}</strong></span>
        ${activePreset ? `<span class="ai-provider-mark is-chip" style="--mark:${activePreset.tint}">${escapeHtml(activePreset.mark)}</span>` : ""}
      </div>
      ${renderAiProviderPanel(config)}
    </div>
    <div class="settings-status-card">
      <h3>批量处理</h3>
      <div class="settings-form">
        <label><span>处理方式</span><select id="settings-ai-mode">
          ${(Object.keys(modeLabels) as AiRunMode[]).map((mode) => `<option value="${mode}" ${state.aiProcessMode === mode ? "selected" : ""}>${modeLabels[mode]}</option>`).join("")}
        </select></label>
        <div class="settings-actions">
          <button class="outline-button" type="button" id="settings-ai-preview" ${!state.library || running || state.aiPreviewLoading ? "disabled" : ""}>${state.aiPreviewLoading ? "统计中…" : "生成预览"}</button>
          <button class="outline-button" type="button" id="settings-ai-start" ${!state.library || running || !active || !preview || preview.estimatedCalls === 0 ? "disabled" : ""}>开始处理</button>
          ${running ? `<button class="outline-button" type="button" id="settings-ai-cancel">取消</button>` : ""}
        </div>
      </div>
      ${
        preview && preview.mode === state.aiProcessMode
          ? `<dl class="settings-kv">
        <div><dt>预计 API 调用</dt><dd>${formatCount(preview.estimatedCalls)} 次</dd></div>
        <div><dt>涉及照片</dt><dd>${formatCount(preview.mode === "full" ? preview.totalPhotos : preview.mode === "retry" ? preview.failed : preview.pending)}</dd></div>
      </dl>
      ${state.aiConfirming ? `<div class="settings-confirm"><span>将向所选服务商发送约 ${formatCount(preview.estimatedCalls)} 次请求，确认执行？</span><button class="outline-button" type="button" id="settings-ai-start-cancel">取消</button><button class="primary-button" type="button" id="settings-ai-start-confirm">确认执行</button></div>` : ""}`
          : ""
      }
      ${
        progress
          ? `<div class="settings-note ai-progress-note">
        ${progress.state === "running" ? `<span class="spinner"></span>` : ""}
        ${
          progress.state === "running"
            ? `处理中：${formatCount(progress.processed)} / ${formatCount(progress.total)} · 成功 ${formatCount(progress.succeeded)} · 失败 ${formatCount(progress.failed)} · 跳过 ${formatCount(progress.skipped)}`
            : progress.state === "completed"
              ? `处理完成：成功 ${formatCount(progress.succeeded)} · 失败 ${formatCount(progress.failed)} · 跳过 ${formatCount(progress.skipped)}`
              : progress.state === "cancelled"
                ? `已取消：成功 ${formatCount(progress.succeeded)} · 失败 ${formatCount(progress.failed)}`
                : `处理失败：${escapeHtml(progress.error ?? "未知错误")}`
        }
      </div>
      ${progress.state === "running" ? `<div class="progress-track${progress.total > 0 ? "" : " is-indeterminate"}"><span style="width:${progress.total > 0 ? percent : 35}%"></span></div>` : ""}
      ${progress.state === "running" && progress.current ? `<div class="settings-note">${escapeHtml(progress.current)}</div>` : ""}
      ${progress.errors.length ? `<div class="settings-note is-danger">${progress.errors.slice(0, 3).map(escapeHtml).join("；")}</div>` : ""}`
          : ""
      }
      ${!running && state.aiStats && state.aiStats.failed > 0 ? `<div class="settings-note">有 ${formatCount(state.aiStats.failed)} 个失败项，可用「仅重试失败项」重新处理。</div>` : ""}
      <div class="settings-note">处理只读缩略图缓存与索引，不修改原始文件；完成后可关闭窗口，任务不会自动续跑。</div>
    </div>
    ${
      stats
        ? `<div class="settings-status-card">
      <h3>处理统计</h3>
      <dl class="settings-kv ai-stats">
        <div><dt>可处理照片</dt><dd>${formatCount(stats.totalPhotos)}</dd></div>
        <div><dt>已处理</dt><dd>${formatCount(stats.processed)}</dd></div>
        <div><dt>待处理</dt><dd>${formatCount(stats.pending)}</dd></div>
        <div><dt>失败</dt><dd class="${stats.failed > 0 ? "is-danger" : ""}">${formatCount(stats.failed)}</dd></div>
      </dl>
    </div>`
        : ""
    }
  </div>`;
}

/** 供应商面板：三段式视图的入口。 */
function renderAiProviderPanel(config: AiConfigDto): string {
  if (state.aiView === "picker") return renderAiProviderPicker();
  const editing = findProfile(config.profiles, state.aiEditingId);
  if (state.aiView === "edit" && editing) return renderAiProviderEditor(config, editing);
  return renderAiProviderList(config);
}

function providerMarkHtml(preset: AiProviderPreset, extraClass = ""): string {
  return `<span class="ai-provider-mark ${extraClass}" style="--mark:${preset.tint}">${escapeHtml(preset.mark)}</span>`;
}

/** 草稿与已保存配置是否不一致：决定列表页要不要露出「保存配置」。 */
function aiDraftDirty(config: AiConfigDto): boolean {
  const saved = state.aiConfig;
  if (!saved) return true;
  return JSON.stringify(config) !== JSON.stringify(saved);
}

/** 视图一：已添加的供应商列表（面板主视图）。 */
function renderAiProviderList(config: AiConfigDto): string {
  const active = pickActiveProfile(config);
  const dirty = aiDraftDirty(config);
  if (config.profiles.length === 0) {
    return `<div class="ai-provider-panel">
      <div class="ai-panel-head">
        <div class="ai-panel-title"><h4>供应商</h4><p>自动打标与对话都需要至少一个供应商。</p></div>
      </div>
      <div class="ai-empty">
        <strong>先添加一个供应商</strong>
        <span>选 <em>模型厂商的 API</em>、粘贴密钥即可。国内厂商直连可用，海外厂商需要你的网络能访问其服务。</span>
        <button class="primary-button" type="button" id="settings-ai-add">＋ 添加供应商</button>
      </div>
    </div>`;
  }
  const rows = config.profiles
    .map((profile) => {
      const preset = findProvider(profile.provider);
      const isActive = profile.id === active?.id;
      const summary = profileSummary(profile);
      return `<div class="ai-provider-row ${isActive ? "is-active" : ""}">
        ${providerMarkHtml(preset)}
        <div class="ai-provider-row-main">
          <div class="ai-provider-row-title">
            <strong>${escapeHtml(profileTitle(profile))}</strong>
            ${isActive ? `<span class="ai-usage-pill">使用中</span>` : ""}
          </div>
          <span class="ai-provider-row-sub" title="${escapeHtml(summary)}">${escapeHtml(summary)}</span>
        </div>
        <div class="ai-provider-row-actions">
          ${isActive ? "" : `<button class="text-button" type="button" data-ai-activate="${escapeHtml(profile.id)}">设为使用中</button>`}
          <button class="text-button" type="button" data-ai-edit="${escapeHtml(profile.id)}">编辑</button>
          <button class="text-button is-danger" type="button" data-ai-remove="${escapeHtml(profile.id)}">删除</button>
        </div>
      </div>`;
    })
    .join("");
  return `<div class="ai-provider-panel">
    <div class="ai-panel-head">
      <div class="ai-panel-title">
        <h4>供应商</h4>
        <p>已添加 ${config.profiles.length} 个。打标与对话都用标着「使用中」的那一个；同一厂商可以加多条（两个账号、或成本低的模型 + 效果好的模型），各自独立保存 Key。</p>
      </div>
      <div class="ai-panel-actions">
        ${dirty ? `<button class="outline-button" type="button" id="settings-save-ai" ${state.settingsBusy ? "disabled" : ""}>${state.settingsBusy ? "保存中…" : "保存配置"}</button>` : ""}
        <button class="primary-button" type="button" id="settings-ai-add">＋ 添加供应商</button>
      </div>
    </div>
    ${dirty ? `<div class="ai-dirty-hint">有未保存的改动，点「保存配置」写入本地设置后才生效。</div>` : ""}
    <div class="ai-provider-list">${rows}</div>
  </div>`;
}

/** 视图二：添加供应商——只列模型厂商的 API，搜索 + 三列卡片网格。 */
function renderAiProviderPicker(): string {
  const presets = filterProviderPresets(pickerPresets(), state.aiPickerQuery);
  const head = `<div class="ai-panel-head">
    <div class="ai-panel-title">
      <button class="ai-back" type="button" data-ai-back>← 返回</button>
      <h4>添加供应商</h4>
      <p>模型厂商的 API。国内厂商直连可用；海外厂商需要你的网络能访问其服务。地址与模型清单核对自各家官方文档（2026-11）。</p>
    </div>
  </div>`;
  return `<div class="ai-provider-panel">
    ${head}
    <input id="settings-ai-search" class="ai-picker-search" value="${escapeHtml(state.aiPickerQuery)}" spellcheck="false" placeholder="搜索厂商或模型，例如 deepseek / glm / 视觉" aria-label="搜索厂商" />
    <div class="ai-provider-grid" id="ai-picker-grid">${renderAiProviderCards(presets)}</div>
    <div class="ai-picker-foot"><span>共 ${presets.length} 家</span><span>找不到？选「自定义」填自己的 Base URL</span></div>
  </div>`;
}

/** 卡片网格单独抽出来：搜索时只换这一块，输入框不丢焦点。 */
export function renderAiProviderCards(presets: readonly AiProviderPreset[]): string {
  if (presets.length === 0) {
    return `<div class="ai-grid-empty">没有匹配的厂商，换个关键词试试。</div>`;
  }
  return presets
    .map(
      (item) => `<button type="button" class="ai-provider-card" data-ai-add="${item.id}">
      ${providerMarkHtml(item)}
      <span class="ai-provider-copy"><strong>${escapeHtml(item.name)}</strong><span>${escapeHtml(item.hint)}</span></span>
    </button>`,
    )
    .join("");
}

/**
 * 视图三：单个供应商的配置。
 *
 * 版式照着厂商控制台的「添加供应商」弹窗做：头部是厂商标识与控制台域名，下面依次是
 * 密钥、端点、区域、模型，最后是「取消 / 添加」。端点按协议逐行列出——应用只走
 * OpenAI 兼容协议，其余两个协议标「仅展示」，免得用户以为填了就能用。
 */
function renderAiProviderEditor(config: AiConfigDto, profile: AiProfileDto): string {
  const providerId = resolveProviderId(profile.provider, profile.baseUrl);
  const provider = findProvider(providerId);
  const regions = providerRegions(provider);
  const region = regionForBaseUrl(provider, profile.baseUrl);
  const endpoints = provider.custom ? [] : providerEndpoints(provider, region.id);
  const isActive = profile.id === pickActiveProfile(config)?.id;
  const isNew = state.aiCreating;
  const testResult = state.aiTestResult;
  const host = consoleHost(provider.keyUrl);

  const keyRow = `<div class="ai-config-row">
    <span class="ai-config-label">API 密钥${provider.keyOptional ? "（可选）" : ""}</span>
    <div class="ai-key-line">
      <input id="settings-ai-chat-key" type="${state.aiKeyVisible ? "text" : "password"}" value="${escapeHtml(profile.apiKey)}" spellcheck="false" autocomplete="off" placeholder="${escapeHtml(provider.keyPlaceholder)}" />
      <button class="text-button" type="button" id="settings-ai-key-toggle" aria-label="显示或隐藏 API 密钥">${state.aiKeyVisible ? "隐藏" : "显示"}</button>
      ${provider.keyUrl ? `<button class="ai-key-link" type="button" data-ai-open-url="${escapeHtml(provider.keyUrl)}">获取密钥 ↗</button>` : ""}
    </div>
  </div>`;

  const urlRow = provider.custom
    ? `<div class="ai-config-row">
    <span class="ai-config-label">接口地址</span>
    <input id="settings-ai-chat-url" class="ai-config-input" value="${escapeHtml(profile.baseUrl)}" spellcheck="false" placeholder="https://your-host/v1" />
  </div>`
    : "";

  const endpointRow = provider.custom
    ? ""
    : `<div class="ai-config-row is-top">
    <span class="ai-config-label">端点</span>
    <div class="ai-endpoint-list">
      ${endpoints
        .map((endpoint) => {
          const meta = protocolMeta(endpoint.protocol);
          const using = endpoint.protocol === "openai";
          return `<div class="ai-endpoint-row ${using ? "is-using" : ""}" title="${escapeHtml(meta.note)}">
            <span class="ai-endpoint-proto">${escapeHtml(meta.label)}</span>
            <code>${escapeHtml(endpoint.url)}</code>
            <span class="ai-endpoint-tag ${using ? "" : "is-muted"}">${using ? "使用中" : "仅展示"}</span>
          </div>`;
        })
        .join("")}
    </div>
  </div>`;

  const regionRow =
    regions.length > 1
      ? `<div class="ai-config-row">
    <span class="ai-config-label">区域</span>
    <div class="ai-region-tabs" role="tablist" aria-label="接入区域">
      ${regions
        .map(
          (item) =>
            `<button class="ai-region-tab ${item.id === region.id ? "is-active" : ""}" type="button" role="tab" aria-selected="${item.id === region.id}" data-ai-region="${escapeHtml(item.id)}">${escapeHtml(item.label)}</button>`,
        )
        .join("")}
    </div>
  </div>`
      : "";

  const modelRow = `<div class="ai-config-row is-top">
    <span class="ai-config-label">模型</span>
    <div class="ai-model-picker">
      <div class="ai-model-line">
        <input id="settings-ai-model" class="ai-model-input" value="${escapeHtml(profile.model)}" spellcheck="false" autocomplete="off" placeholder="点「获取模型」挑一个，或手填模型 ID" />
        <button class="outline-button" type="button" id="settings-ai-fetch-models" ${state.aiModelsBusy ? "disabled" : ""}>${state.aiModelsBusy ? "获取中…" : state.aiModels ? "重新获取" : "获取模型"}</button>
      </div>
      ${renderAiModelResults(profile)}
    </div>
  </div>`;

  const nameRow = `<div class="ai-config-row">
    <span class="ai-config-label">备注名</span>
    <input id="settings-ai-profile-name" class="ai-config-input" value="${escapeHtml(profile.name)}" spellcheck="false" placeholder="可选，例如「打标用」" />
  </div>`;

  const advanced = `<details class="ai-advanced ai-config-advanced">
    <summary>高级</summary>
    <div class="settings-form">
      ${provider.custom ? "" : `<label><span>接口地址</span><input id="settings-ai-chat-url" value="${escapeHtml(profile.baseUrl)}" spellcheck="false" placeholder="https://your-host/v1" /></label>`}
      <label><span>并发请求数</span><select id="settings-ai-concurrency">
        ${[1, 2, 3, 4].map((value) => `<option value="${value}" ${config.concurrency === value ? "selected" : ""}>${value} 个并行</option>`).join("")}
      </select></label>
    </div>
    <div class="settings-note">接口地址填到 SDK 的 base_url 那一级，应用自己在后面拼 /chat/completions。切换区域会覆盖这里手改过的地址。</div>
  </details>`;

  return `<div class="ai-provider-panel">
    <div class="ai-panel-head">
      <div class="ai-panel-title">
        <button class="ai-back" type="button" data-ai-cancel>← 返回</button>
        <h4>${isNew ? "添加供应商" : "配置供应商"}</h4>
        <p>${escapeHtml(provider.hint)}${
          provider.docsUrl
            ? ` · <button class="ai-doc-link" type="button" data-ai-open-url="${escapeHtml(provider.docsUrl)}">官方文档 ↗</button>`
            : ""
        }</p>
      </div>
    </div>
    <div class="ai-config-card">
      <header class="ai-config-head">
        ${providerMarkHtml(provider, "is-large")}
        <div class="ai-config-head-copy">
          <strong>${escapeHtml(provider.name)}</strong>
          <span>${escapeHtml(provider.hint)}</span>
        </div>
        ${
          isActive
            ? `<span class="ai-usage-pill">使用中</span>`
            : `<button class="text-button" type="button" data-ai-activate="${escapeHtml(profile.id)}">设为使用中</button>`
        }
        ${
          provider.keyUrl && host
            ? `<button class="ai-console-link" type="button" data-ai-open-url="${escapeHtml(provider.keyUrl)}">${escapeHtml(host)} ↗</button>`
            : ""
        }
      </header>
      <div class="ai-config-body">
        ${keyRow}
        ${urlRow}
        ${endpointRow}
        ${regionRow}
        ${modelRow}
        ${nameRow}
        ${advanced}
      </div>
      <footer class="ai-config-foot">
        <button class="text-button" type="button" id="settings-ai-test" ${state.aiTestBusy || state.settingsBusy ? "disabled" : ""}>${state.aiTestBusy ? "测试中…" : "测试连接"}</button>
        ${
          testResult
            ? `<span class="ai-test-pill ${testResult.ok ? "is-ok" : "is-error"}">${escapeHtml(testResult.message)}</span>`
            : `<span class="ai-config-hint">测试会先按当前表单保存一次</span>`
        }
        <span class="ai-config-foot-spacer"></span>
        <button class="outline-button" type="button" data-ai-cancel>取消</button>
        <button class="primary-button" type="button" id="settings-save-ai" ${state.settingsBusy ? "disabled" : ""}>${state.settingsBusy ? "保存中…" : isNew ? "添加" : "保存"}</button>
      </footer>
    </div>
  </div>`;
}

/**
 * 「获取模型」下方的结果区：未取 / 取中 / 失败 / 已取回 四态。
 *
 * 清单最多可能上百条，超过一屏才给一个过滤框；过滤只重绘这一块（绑定层调
 * `renderAiModelResults`），输入框不丢焦点。
 */
export function renderAiModelResults(profile: AiProfileDto): string {
  if (state.aiModelsBusy) {
    return `<div class="ai-model-status">正在向上游请求模型清单…</div>`;
  }
  if (state.aiModelsError) {
    return `<div class="ai-model-status is-error">${escapeHtml(state.aiModelsError)}</div>
      <span class="ai-config-hint">拿不到清单不影响使用：直接在上面手填厂商文档里的模型 ID 即可。</span>`;
  }
  if (!state.aiModels) {
    return `<span class="ai-config-hint">模型不预置：点「获取模型」按当前地址与密钥向厂商拉取可用清单，也可以直接手填模型 ID。</span>`;
  }
  const filter =
    state.aiModels.length > 8
      ? `<input id="settings-ai-model-filter" class="ai-model-filter" value="${escapeHtml(state.aiModelQuery)}" spellcheck="false" placeholder="过滤模型名" aria-label="过滤模型" />`
      : "";
  return `<div class="ai-model-results">
    ${filter}
    <div class="ai-model-list" id="ai-model-list" role="radiogroup" aria-label="上游模型">${renderAiModelList(profile)}</div>
    <span class="ai-config-hint" id="ai-model-count">${aiModelCountHint()}</span>
  </div>`;
}

/**
 * 清单本体。过滤时只换这一块（连同下面的计数），过滤输入框留在原地——
 * 整块替换会把正在输入的那个框换掉，光标和焦点一起丢。
 */
export function renderAiModelList(profile: AiProfileDto): string {
  if (!state.aiModels) return "";
  const query = state.aiModelQuery.trim().toLowerCase();
  const matched = query ? state.aiModels.filter((id) => id.toLowerCase().includes(query)) : state.aiModels;
  const selected = profile.model.trim();
  if (matched.length === 0) return `<div class="ai-model-status">没有匹配的模型</div>`;
  return matched
    .map(
      (
        id,
      ) => `<button type="button" class="ai-model-choice ${id === selected ? "is-active" : ""}" role="radio" aria-checked="${id === selected}" data-ai-model="${escapeHtml(id)}">
        <span class="ai-model-choice-name">${escapeHtml(id)}</span>
      </button>`,
    )
    .join("");
}

/** 列表下方的计数说明；过滤时与列表一起刷新。 */
export function aiModelCountHint(): string {
  if (!state.aiModels) return "";
  const query = state.aiModelQuery.trim().toLowerCase();
  const matched = query ? state.aiModels.filter((id) => id.toLowerCase().includes(query)) : state.aiModels;
  return `上游共 ${state.aiModels.length} 个可用模型${query ? `，匹配 ${matched.length} 个` : ""}。自动打标需要支持图片输入的模型。`;
}

export function renderSettingsAboutSection(): string {
  const about = state.aboutInfo;
  if (!about) {
    return `<div class="settings-section-body"><div class="settings-status-card"><div class="settings-note">加载关于信息…</div></div></div>`;
  }
  const ffmpegOk = about.ffmpeg.available;
  return `<div class="settings-section-body">
    <div class="settings-status-card">
      <h3>Camlib ${escapeHtml(about.version)}</h3>
      <div class="settings-note">本地媒体库。索引与备份数据保存在应用数据目录；设置写入 settings.json。</div>
      ${pathRow("应用数据目录", about.appDataDir, "app_data")}
      ${pathRow("应用缓存目录", about.appCacheDir, "app_cache")}
      ${pathRow("数据库", about.databasePath)}
      ${pathRow("设置文件", about.settingsPath)}
      ${pathRow("缩略图缓存", about.thumbnailCacheDir, "thumbnail_cache")}
      <div class="settings-ffmpeg ${ffmpegOk ? "is-ok" : "is-missing"}">
        <strong>ffmpeg</strong>
        <span>${ffmpegOk ? "可用" : "不可用"}</span>
        ${about.ffmpeg.path ? `<span class="mono" title="${escapeHtml(about.ffmpeg.path)}">${escapeHtml(truncatePath(about.ffmpeg.path))}</span>` : ""}
        ${about.ffmpeg.message ? `<span class="settings-note">${escapeHtml(about.ffmpeg.message)}</span>` : ""}
      </div>
      <div class="settings-note">缺失 ffmpeg 时，视频缩略图与部分预览会失败。开发环境可安装到 PATH（winget install ffmpeg），打包环境请提供 resources/ffmpeg/ffmpeg.exe。</div>
    </div>
  </div>`;
}

export function renderSettingsSystemSection(): string {
  return `<div class="settings-section-body">
    <div class="settings-status-card">
      <h3>查看偏好</h3>
      <div class="settings-note">主题与默认查看方式即时保存。查看过程中仍可用底部「沉浸」按钮临时切换。</div>
      <div class="settings-form">
        <label><span>主题</span><select id="settings-theme" aria-label="界面主题">
          <option value="light" ${state.theme === "light" ? "selected" : ""}>浅色</option>
          <option value="dark" ${state.theme === "dark" ? "selected" : ""}>深色</option>
        </select></label>
        <label><span>默认查看方式</span><select id="settings-preview-mode" aria-label="默认媒体查看方式">
          <option value="standard" ${state.previewMode === "standard" ? "selected" : ""}>标准查看（带信息与工具栏）</option>
          <option value="immersive" ${state.previewMode === "immersive" ? "selected" : ""}>沉浸式查看（纯媒体展示）</option>
        </select></label>
        <div class="settings-actions">
          <button class="primary-button" type="button" id="settings-save-preview-mode">保存查看方式</button>
        </div>
      </div>
      <div class="settings-note">沉浸式：无多余边框，支持任意位置拖动平移，Ctrl+滚轮缩放，Esc 退出。主题与侧栏按钮同步。</div>
    </div>
    <div class="settings-status-card">
      <h3>弹窗大小</h3>
      <div class="settings-note">拖动弹窗边缘或角落即可调整大小，松开后自动保存，下次打开保持该尺寸。也可以按数值微调（像素），留空表示使用默认。</div>
      <div class="settings-form dialog-size-form">${renderDialogSizeRows()}</div>
      <div class="settings-actions">
        <button class="outline-button" type="button" id="settings-reset-dialog-sizes" ${Object.keys(state.dialogSizes).length ? "" : "disabled"}>全部恢复默认</button>
      </div>
    </div>
    <div class="settings-status-card">
      <h3>系统集成</h3>
      <div class="settings-note">托盘与通知初始化失败不会影响主窗口。单实例启动：再次打开应用会聚焦已有窗口。</div>
      <div class="settings-form">
        <label><span>关闭窗口时</span><select id="settings-close-behavior" aria-label="关闭窗口行为">
          <option value="minimize_to_tray" ${state.closeBehavior === "minimize_to_tray" ? "selected" : ""}>最小化到托盘</option>
          <option value="quit" ${state.closeBehavior === "quit" ? "selected" : ""}>退出应用</option>
        </select></label>
        <label class="settings-checkbox"><input type="checkbox" id="settings-notifications" ${state.notificationsEnabled ? "checked" : ""} aria-label="启用系统通知" /><span>启用系统通知（扫描 / 备份 / 断盘）</span></label>
        <div class="settings-actions">
          <button class="primary-button" type="button" id="settings-save-system" ${state.settingsBusy ? "disabled" : ""}>${state.settingsBusy ? "保存中…" : "保存系统设置"}</button>
        </div>
      </div>
      <div class="settings-note">托盘图标支持左键显示主窗口；右键菜单可退出。关闭行为为「最小化到托盘」时，点击关闭按钮仅隐藏窗口。</div>
    </div>
    <div class="settings-status-card">
      <h3>最近任务结果</h3>
      ${renderRecentTasksSummary()}
      <div class="settings-note">应用重启后不会恢复未完成任务，只展示 runs 表中的历史结果；中断的任务会标记为失败。</div>
    </div>
  </div>`;
}

/** One numeric width/height row per resizable dialog for the settings page. */
export function renderDialogSizeRows(): string {
  return Object.entries(DIALOG_SPECS)
    .map(([id, spec]) => {
      const saved = state.dialogSizes[id];
      const width = saved?.width ?? spec.width;
      const height = saved?.height ?? spec.height;
      return `<div class="dialog-size-row" data-dialog-size-row="${id}">
        <span class="dialog-size-name">${spec.label}</span>
        <label class="dialog-size-field">宽 <input type="number" data-dialog-size-width="${id}" min="${spec.minWidth}" max="16384" step="10" value="${width ?? ""}" placeholder="${spec.width ?? "自动"}" aria-label="${spec.label}宽度" /></label>
        <label class="dialog-size-field">高 <input type="number" data-dialog-size-height="${id}" min="${spec.minHeight}" max="16384" step="10" value="${height ?? ""}" placeholder="${spec.height ?? "自动"}" aria-label="${spec.label}高度" /></label>
        <button class="text-button" type="button" data-dialog-size-reset="${id}" ${saved ? "" : "disabled"}>恢复默认</button>
      </div>`;
    })
    .join("");
}

/**
 * Commit one dialog row's numeric inputs. An empty input falls back to the
 * stylesheet default (auto height for content-sized dialogs); a row equal to
 * its defaults removes the stored override entirely.
 */
export function commitDialogSizeInputs(id: string): void {
  const spec = DIALOG_SPECS[id];
  if (!spec) return;
  const row = app.querySelector<HTMLElement>(`[data-dialog-size-row="${id}"]`);
  const parse = (input: HTMLInputElement | null | undefined, min: number): number | null => {
    const raw = input?.value.trim() ?? "";
    if (!raw) return null;
    const value = Math.round(Number(raw));
    if (!Number.isFinite(value)) return null;
    return Math.max(min, Math.min(16384, value));
  };
  const width = parse(row?.querySelector<HTMLInputElement>("[data-dialog-size-width]"), spec.minWidth);
  const height = parse(row?.querySelector<HTMLInputElement>("[data-dialog-size-height]"), spec.minHeight);
  const isDefault = (width == null || width === spec.width) && (height == null || height === spec.height);
  if (isDefault) delete state.dialogSizes[id];
  else state.dialogSizes[id] = { ...(width != null ? { width } : {}), ...(height != null ? { height } : {}) };
  applyDialogSizes();
  void persistUiPrefs({ uiDialogSizes: state.dialogSizes });
  updateSettingsPanel();
}

export function renderRecentTasksSummary(): string {
  const scans = state.scanRuns.slice(0, 5);
  const backups = state.backupHistory.slice(0, 5);
  const scanRows = scans.length
    ? scans
        .map(
          (run) => `<div class="settings-scan-run">
        <span class="run-status is-${run.status}">${scanRunStatusLabel(run.status)}</span>
        <span>扫描 · ${escapeHtml(formatCaptureAt(run.startedAt) || run.startedAt)}</span>
        <span>文件 ${formatCount(run.filesSeen)} · 新增 ${formatCount(run.itemsAdded)}</span>
      </div>`,
        )
        .join("")
    : `<div class="settings-note">还没有扫描记录。</div>`;
  const backupRows = backups.length
    ? backups
        .map(
          (run) => `<div class="settings-scan-run">
        <span class="run-status is-${run.status}">${backupStatusLabel(run.status)}</span>
        <span>备份 · ${escapeHtml(formatCaptureAt(run.startedAt) || run.startedAt)}</span>
        <span>成功 ${formatCount(run.copiedFiles)} · 失败 ${formatCount(run.failedFiles)}</span>
      </div>`,
        )
        .join("")
    : `<div class="settings-note">还没有备份记录。</div>`;
  return `<div class="settings-scan-runs">${scanRows}${backupRows}</div>`;
}

export function settingsSectionBodyHtml(): string {
  if (state.settingsSection === "library") return renderSettingsLibrarySection();
  if (state.settingsSection === "index") return renderSettingsIndexSection();
  if (state.settingsSection === "thumbnails") return renderSettingsThumbnailSection();
  if (state.settingsSection === "backup") return renderSettingsBackupSection();
  if (state.settingsSection === "ai") return renderSettingsAiSection();
  if (state.settingsSection === "system") return renderSettingsSystemSection();
  return renderSettingsAboutSection();
}

export function settingsContentHtml(): string {
  return `${state.settingsLoading ? `<div class="settings-note">加载中…</div>` : ""}${state.settingsError ? `<div class="settings-note is-danger">${escapeHtml(state.settingsError)}</div>` : ""}${state.settingsNotice ? `<div class="settings-note is-success">${escapeHtml(state.settingsNotice)}</div>` : ""}${settingsSectionBodyHtml()}`;
}

export function renderSettingsPanel(): string {
  if (!state.settingsOpen) return "";
  return `<div class="modal-backdrop settings-backdrop" id="settings-backdrop" role="presentation">
    <div class="settings-panel" role="dialog" aria-modal="true" aria-labelledby="settings-title">
      <header class="settings-header">
        <div>
          <h2 id="settings-title">设置</h2>
          <span>${SETTINGS_SECTIONS.map((section) => section.label).join(" · ")}</span>
        </div>
        <button class="icon-button" type="button" id="settings-close" aria-label="关闭设置">×</button>
      </header>
      <div class="settings-layout">
        <nav class="settings-nav" aria-label="设置分区">
          ${SETTINGS_SECTIONS.map((section) => `<button type="button" class="settings-nav-item ${state.settingsSection === section.id ? "is-active" : ""}" data-settings-section="${section.id}">${section.label}</button>`).join("")}
        </nav>
        <div class="settings-content" id="settings-content">
          ${settingsContentHtml()}
        </div>
      </div>
    </div>
  </div>`;
}

/**
 * Patch only the settings dialog. Full `render()` rebuilds the whole shell and
 * remounts every media thumbnail — that is what made tab switches flicker.
 */
export function updateSettingsPanel(options?: { animate?: boolean }): void {
  if (!state.settingsOpen) return;
  const content = app.querySelector<HTMLElement>("#settings-content");
  if (!content) {
    render();
    return;
  }
  content.innerHTML = settingsContentHtml();
  if (options?.animate !== false) fadeSettingsContent(content);
  app.querySelectorAll<HTMLButtonElement>("[data-settings-section]").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.settingsSection === state.settingsSection);
  });
  bindSettingsEvents();
}

/** 上一次的分区切换动画：连切时先撤掉，避免多条动画叠在同一个元素上。 */
let swapAnimation: Animation | null = null;

/**
 * 分区切换的淡入。
 *
 * 原来是「摘类 → 读一次 offsetWidth → 加类」重启 CSS 动画：那次 `offsetWidth`
 * 读在 innerHTML 写入之后，等于逼浏览器当场同步回流一遍新内容。WAAPI 不碰布局，
 * 动画由合成器直接跑，连切也只是把上一条动画换掉。
 */
function fadeSettingsContent(content: HTMLElement): void {
  swapAnimation?.cancel();
  swapAnimation = null;
  const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  if (reduce || typeof content.animate !== "function") return;
  swapAnimation = content.animate([{ opacity: 0.55 }, { opacity: 1 }], { duration: 160, easing: "ease" });
}
