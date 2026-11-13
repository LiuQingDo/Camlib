// 由 main.ts 拆分而来：仅做搬移，未改动逻辑。
import { AiRunMode } from "../api/ai";
import {
  formatCaptureAt,
  formatCount,
  formatEtaSeconds,
  formatSize,
  formatSpeed,
  truncatePath,
} from "../lib/format";
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

/** AI 增强（可选）：总开关、两组模型配置、连通性测试、批量处理入口。 */
export function renderSettingsAiSection(): string {
  const config = state.aiConfig;
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
  const testPill = (target: "chat" | "embedding"): string => {
    const result = state.aiTestResult?.target === target ? state.aiTestResult : null;
    if (!result) return "";
    return `<span class="ai-test-pill ${result.ok ? "is-ok" : "is-error"}">${escapeHtml(result.message)}</span>`;
  };
  const preview = state.aiPreview;
  const modeLabels: Record<AiRunMode, string> = {
    incremental: "增量处理（仅未处理 + 补算向量）",
    full: "全量重跑（重新打标所有照片）",
    retry: "仅重试失败项",
    embeddings: "仅补算描述向量（不重新打标）",
  };
  return `<div class="settings-section-body">
    <div class="settings-status-card">
      <h3>AI 自动打标与语义搜索</h3>
      <div class="settings-note">可选增强功能，<strong>默认关闭</strong>。开启并执行处理后，照片缩略图（约 512px 压缩图，非原图）将发送到你配置的第三方 API；标签与描述保存在本地索引中。</div>
      <label class="settings-checkbox"><input type="checkbox" id="settings-ai-enabled" ${config.enabled ? "checked" : ""} /><span>启用 AI 增强（对话模型打标 + 语义搜索）</span></label>
      ${
        stats
          ? `<dl class="settings-kv">
        <div><dt>可处理照片</dt><dd>${formatCount(stats.totalPhotos)}</dd></div>
        <div><dt>已处理</dt><dd>${formatCount(stats.processed)}</dd></div>
        <div><dt>待处理</dt><dd>${formatCount(stats.pending)}</dd></div>
        <div><dt>失败</dt><dd>${formatCount(stats.failed)}</dd></div>
        <div><dt>缺向量</dt><dd>${formatCount(stats.missingEmbedding)}</dd></div>
      </dl>${stats.embeddingModel ? `<div class="settings-note">当前向量模型：${escapeHtml(stats.embeddingModel)}。更换模型后需「全量重跑」重新计算向量。</div>` : `<div class="settings-note">未配置 Embedding 模型：语义搜索将降级为描述/标签关键字匹配。</div>`}`
          : `<div class="settings-note">统计需要已配置的媒体库。</div>`
      }
      <div class="settings-form">
        <label><span>对话模型 Base URL</span><input id="settings-ai-chat-url" value="${escapeHtml(config.chatBaseUrl)}" spellcheck="false" placeholder="https://api.openai.com/v1" /></label>
        <label><span>对话模型名称</span><input id="settings-ai-chat-model" value="${escapeHtml(config.chatModel)}" spellcheck="false" placeholder="gpt-4o-mini / qwen-vl-…（需支持图片输入）" /></label>
        <label><span>对话模型 API Key</span><input id="settings-ai-chat-key" type="password" value="${escapeHtml(config.chatApiKey)}" spellcheck="false" placeholder="本地服务的兼容接口可留空" /></label>
        <label><span>Embedding Base URL</span><input id="settings-ai-embed-url" value="${escapeHtml(config.embeddingBaseUrl)}" spellcheck="false" placeholder="https://api.openai.com/v1（留空则停用向量检索）" /></label>
        <label><span>Embedding 模型名称</span><input id="settings-ai-embed-model" value="${escapeHtml(config.embeddingModel)}" spellcheck="false" placeholder="text-embedding-3-small / bge-…" /></label>
        <label><span>Embedding API Key</span><input id="settings-ai-embed-key" type="password" value="${escapeHtml(config.embeddingApiKey)}" spellcheck="false" placeholder="留空则沿用对话模型 Key 不发送鉴权头" /></label>
        <label><span>并发请求数</span><select id="settings-ai-concurrency">
          ${[1, 2, 3, 4].map((value) => `<option value="${value}" ${config.concurrency === value ? "selected" : ""}>${value} 个并行</option>`).join("")}
        </select></label>
        <div class="settings-actions">
          <button class="primary-button" type="button" id="settings-save-ai" ${state.settingsBusy ? "disabled" : ""}>${state.settingsBusy ? "保存中…" : "保存 AI 配置"}</button>
          <button class="outline-button" type="button" id="settings-ai-test-chat" ${state.aiTestBusy || state.settingsBusy ? "disabled" : ""}>${state.aiTestBusy === "chat" ? "测试中…" : "测试对话模型"}</button>
          <button class="outline-button" type="button" id="settings-ai-test-embed" ${state.aiTestBusy || state.settingsBusy ? "disabled" : ""}>${state.aiTestBusy === "embedding" ? "测试中…" : "测试 Embedding"}</button>
        </div>
        ${testPill("chat")}${testPill("embedding")}
      </div>
      <div class="settings-note">Base URL 填到 /v1 这一级；任何支持图片输入的 OpenAI 兼容对话模型均可。</div>
    </div>
    <div class="settings-status-card">
      <h3>批量处理</h3>
      <div class="settings-form">
        <label><span>处理方式</span><select id="settings-ai-mode">
          ${(Object.keys(modeLabels) as AiRunMode[]).map((mode) => `<option value="${mode}" ${state.aiProcessMode === mode ? "selected" : ""}>${modeLabels[mode]}</option>`).join("")}
        </select></label>
        <div class="settings-actions">
          <button class="outline-button" type="button" id="settings-ai-preview" ${!state.library || running || state.aiPreviewLoading ? "disabled" : ""}>${state.aiPreviewLoading ? "统计中…" : "生成预览"}</button>
          <button class="outline-button" type="button" id="settings-ai-start" ${!state.library || running || !preview || preview.estimatedCalls === 0 ? "disabled" : ""}>开始处理</button>
          ${running ? `<button class="outline-button" type="button" id="settings-ai-cancel">取消</button>` : ""}
        </div>
      </div>
      ${
        preview && preview.mode === state.aiProcessMode
          ? `<dl class="settings-kv">
        <div><dt>预计 API 调用</dt><dd>${formatCount(preview.estimatedCalls)} 次（对话 ${formatCount(preview.chatCalls)} + 向量 ${formatCount(preview.embeddingCalls)}）</dd></div>
        <div><dt>涉及照片</dt><dd>${formatCount(preview.mode === "full" ? preview.totalPhotos : preview.mode === "retry" ? preview.failed : preview.pending + preview.missingEmbedding)}</dd></div>
      </dl>
      ${state.aiConfirming ? `<div class="settings-confirm"><span>将向上方配置的第三方 API 发送约 ${formatCount(preview.estimatedCalls)} 次请求，确认执行？</span><button class="outline-button" type="button" id="settings-ai-start-cancel">取消</button><button class="primary-button" type="button" id="settings-ai-start-confirm">确认执行</button></div>` : ""}`
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
  </div>`;
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
  if (options?.animate !== false) {
    content.classList.remove("is-swap");
    // Restart the fade so consecutive tab switches stay calm instead of popping.
    void content.offsetWidth;
    content.classList.add("is-swap");
  }
  app.querySelectorAll<HTMLButtonElement>("[data-settings-section]").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.settingsSection === state.settingsSection);
  });
  bindSettingsEvents();
}
