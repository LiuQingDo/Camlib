import { ConflictPolicy } from "../api/media";
import { formatCaptureAt, formatCount, formatEtaSeconds, formatSize, formatSpeed } from "../lib/format";
import { app } from "../render/context";
import { backupStatusLabel, conflictPolicyLabel, escapeHtml, pathBaseName, willCopyCount } from "../render/text";
import { state } from "../state";
import { mergeGroupMatches } from "./dialogs";

/** 冲突策略的短标签：高级选项收起时右侧那一行要能一眼读完。 */
const CONFLICT_SHORT: Record<ConflictPolicy, string> = {
  skip_same: "跳过同名",
  rename: "自动重命名",
  overwrite: "覆盖目标",
};

/** 高级选项收起时右侧显示的「当前生效值」。默认值也是值，不能藏起来。 */
function advancedSummary(): string {
  const ignoreCount = state.backupIgnoreExtensions
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean).length;
  return [
    CONFLICT_SHORT[state.backupConflictPolicy],
    state.backupMergeSegments ? "合并分段" : "保留分段",
    state.backupDeepVerify ? "深度校验" : "不深度校验",
    ignoreCount > 0 ? `忽略 ${ignoreCount} 种扩展名` : "不忽略扩展名",
  ].join(" · ");
}

function tabButton(id: "import" | "merge", label: string): string {
  const active = state.importTab === id;
  return `<button class="import-tab${active ? " is-active" : ""}" type="button" role="tab" aria-selected="${active}" data-import-tab="${id}">${label}</button>`;
}

export function renderBackupPanel(): string {
  const body =
    state.importTab === "merge"
      ? `<div class="backup-body"><div id="import-merge-body">${renderMergeSegmentsBody()}</div></div>`
      : `${renderStepsBar()}<div class="backup-body">${renderSourceStep()}${renderPreviewBlock()}${renderProgressBlock()}${renderHistoryBlock()}</div>${renderImportFooter()}`;

  return `<aside class="backup-drawer" role="dialog" aria-modal="true" aria-label="导入照片">
    <div class="backup-heading">
      <div><strong>导入照片</strong><span>相机备份 · 源盘只读 · 临时文件校验后提交</span></div>
      <button class="icon-button" id="close-backup" type="button" aria-label="关闭导入面板">×</button>
    </div>
    <div class="import-tabs" role="tablist" aria-label="导入方式">${tabButton("import", "从相机导入")}${tabButton("merge", "整理分段")}</div>
    ${body}
  </aside>`;
}

/** 步骤条：状态来自 state.backupStep，不再由 preview / progress 反推。 */
function renderStepsBar(): string {
  const step = state.backupStep;
  const activeStep = step === "select" ? 1 : step === "confirm" ? 2 : 3;
  const stepChip = (index: number, label: string): string => {
    const settled = activeStep > index || (index === 3 && step === "done");
    const active = activeStep === index && !(index === 3 && step === "done");
    const failed = index === 3 && step === "failed";
    return `<span class="backup-step${active ? " is-active" : ""}${settled ? " is-done" : ""}${failed ? " is-failed" : ""}">${index}. ${label}</span>`;
  };
  // 只在确认步给「上一步」：选择步没有上一屏，完成/失败步的出口是「再导入一次」，
  // 运行中则不该让用户回头改参数。
  const canGoBack = step === "confirm";
  return `<div class="backup-steps" aria-label="备份步骤">${stepChip(1, "选择")}${stepChip(2, "确认")}${stepChip(3, "执行")}${
    canGoBack ? `<button class="text-button backup-step-back" id="backup-step-back" type="button">上一步</button>` : ""
  }</div>`;
}

/** 第 1 步：只留源盘与目标两个下拉，其余进折叠。 */
function renderSourceStep(): string {
  const formDisabled = state.backupStep === "running" || state.backupLoading || state.availability !== "available";
  const noSources = state.backupSources.length === 0;
  const sourceOptions = noSources
    ? '<option value="">未发现包含 DCIM 的可移动盘</option>'
    : state.backupSources
        .map((source) => {
          const selected = (state.backupSourceId ?? state.backupSources[0]?.id) === source.id;
          return `<option value="${escapeHtml(source.id)}" ${selected ? "selected" : ""}>${escapeHtml(source.volumeLabel || source.rootPath)} · ${escapeHtml(source.rootPath)}</option>`;
        })
        .join("");
  const targetOptions = state.libraries
    .map((library) => {
      const selected = (state.backupTargetId ?? state.library?.id ?? state.libraries[0]?.id) === library.id;
      return `<option value="${escapeHtml(library.id)}" ${selected ? "selected" : ""}>${escapeHtml(library.volumeLabel || library.rootPath)}</option>`;
    })
    .join("");

  return `<div class="backup-step-block">
    <div class="backup-step-title">第 1 步 · 选择源盘与目标</div>
    <div class="backup-form">
      <label><span>源相机盘</span><select id="backup-source" ${formDisabled || noSources ? "disabled" : ""}>${sourceOptions}</select></label>
      <label><span>目标媒体库</span><select id="backup-target" ${formDisabled || !state.libraries.length ? "disabled" : ""}>${targetOptions}</select></label>
    </div>
    ${renderAdvancedOptions(formDisabled)}
    ${noSources ? renderSourceEmptyState() : ""}
  </div>`;
}

/** 无盘空态：三行排查 + 刷新（复用 discoverBackupSources）。 */
function renderSourceEmptyState(): string {
  return `<div class="backup-empty">
    <strong>没有找到可导入的相机盘</strong>
    <ol class="backup-empty-steps">
      <li>相机端已选择「USB 存储 / 文件传输」模式，而不是「充电」。</li>
      <li>系统资源管理器里出现了新的盘符（例如 E:），并且能打开。</li>
      <li>该盘根目录下有 DCIM 文件夹。</li>
    </ol>
    <button class="outline-button" id="backup-refresh-sources" type="button" ${state.backupLoading ? "disabled" : ""}>${state.backupLoading ? "正在刷新…" : "刷新"}</button>
  </div>`;
}

/** 高级选项：默认收起，summary 右侧常显当前生效值。 */
function renderAdvancedOptions(disabled: boolean): string {
  const summary = advancedSummary();
  return `<details class="backup-advanced"${state.backupAdvancedOpen ? " open" : ""}>
    <summary>
      <span class="backup-advanced-label">高级选项</span>
      <span class="backup-advanced-current" title="${escapeHtml(summary)}">${escapeHtml(summary)}</span>
    </summary>
    <div class="backup-form">
      <label><span>冲突策略</span><select id="backup-conflict" ${disabled ? "disabled" : ""}><option value="skip_same" ${state.backupConflictPolicy === "skip_same" ? "selected" : ""}>跳过冲突</option><option value="rename" ${state.backupConflictPolicy === "rename" ? "selected" : ""}>自动重命名</option><option value="overwrite" ${state.backupConflictPolicy === "overwrite" ? "selected" : ""}>覆盖目标</option></select></label>
      <label><span>合并分段</span><select id="backup-merge" ${disabled ? "disabled" : ""}><option value="on" ${state.backupMergeSegments ? "selected" : ""}>合并为完整视频</option><option value="off" ${state.backupMergeSegments ? "" : "selected"}>保留原分段</option></select></label>
      <label><span>忽略扩展名</span><input id="backup-ignore" value="${escapeHtml(state.backupIgnoreExtensions)}" aria-label="忽略扩展名" ${disabled ? "disabled" : ""} /></label>
      <label class="backup-check" title="按文件内容比对源文件与目标文件；较慢，但能发现传输损坏">
        <input id="backup-deep-verify" type="checkbox" ${state.backupDeepVerify ? "checked" : ""} ${disabled ? "disabled" : ""} />
        <span>深度校验</span>
      </label>
    </div>
    <div class="backup-note">深度校验会按文件内容逐块比对源文件与写入后的目标文件，能发现大小不变的内容损坏，速度低于仅比对大小（默认关闭）。冲突策略与分段合并同时作为默认值保存。</div>
  </details>`;
}

/** 第 2 步：三块大数字 + 一行冲突结论，其余全部进「查看明细」。 */
function renderPreviewBlock(): string {
  const preview = state.backupPreview;
  if (!preview || state.backupStep === "select") return "";
  const willCopy = willCopyCount(preview);
  const spaceOk = preview.spaceSufficient !== false;
  const freeLabel = preview.freeBytes === null ? "不可用" : formatSize(preview.freeBytes);
  const conflictLine =
    preview.conflictFiles > 0
      ? `冲突策略「${conflictPolicyLabel(preview.conflictPolicy)}」：${formatCount(preview.conflictFiles)} 个同名文件${
          preview.conflictPolicy === "skip_same"
            ? "将跳过"
            : preview.conflictPolicy === "rename"
              ? "将自动重命名后复制"
              : "将覆盖目标中的旧文件"
        }`
      : `冲突策略「${conflictPolicyLabel(preview.conflictPolicy)}」：没有同名冲突`;
  const mergeDetail = preview.mergeGroupCount > 0
    ? `<span>分段合并 <strong>${formatCount(preview.mergeGroupCount)}</strong> 组（${formatCount(preview.mergeSegmentCount)} 个分段）</span>`
    : "";
  const mergeGroups = preview.mergeGroups.length
    ? `<div class="backup-failed-list">${preview.mergeGroups
        .slice(0, 8)
        .map(
          (group) =>
            `<div class="backup-failed-item"><span>${escapeHtml(group.segments.join(" + "))}</span><span>→ ${escapeHtml(group.fileName)} · ${formatSize(group.sizeBytes)}</span></div>`,
        )
        .join(
          "",
        )}${preview.mergeGroups.length > 8 ? `<div class="backup-failed-item"><span>…</span><span>共 ${formatCount(preview.mergeGroups.length)} 组</span></div>` : ""}</div>`
    : "";
  const techLines = [
    "相机源盘始终只读，复制完成后会自动扫描入库。",
    preview.mergeGroupCount > 0
      ? "同一 VID_日期_时间 且序号连续的分段会合并成完整视频（ffmpeg 无损拼接）；时间不同的相邻序号保持分开。"
      : "",
    preview.deepVerify
      ? preview.mergeGroupCount > 0
        ? "深度校验：逐个文件回读目标并比对内容哈希；分段合并生成的视频例外（ffmpeg 重新封装，字节不同，仍按大小窗口校验）。"
        : "深度校验：每个文件复制后都会回读目标文件并比对内容哈希，较慢，但能发现大小不变的内容损坏。"
      : "",
  ]
    .filter(Boolean)
    .map((line) => `<div class="backup-note">${line}</div>`)
    .join("");

  return `<div class="backup-step-block">
    <div class="backup-step-title">第 2 步 · 确认摘要</div>
    <div class="backup-hero-stats">
      <div><span>将复制</span><strong>${formatCount(willCopy)}</strong><em>个文件</em></div>
      <div><span>需要</span><strong>${formatSize(preview.requiredBytes)}</strong><em>目标空间</em></div>
      <div${spaceOk ? "" : ' class="is-danger"'}><span>剩余</span><strong>${freeLabel}</strong><em>${spaceOk ? "可用空间" : "空间不足"}</em></div>
    </div>
    <div class="backup-conflict-line${preview.conflictFiles > 0 ? " is-warning" : ""}">${conflictLine}</div>
    ${
      !spaceOk
        ? `<div class="backup-note is-danger">目标盘空间不足：还需约 ${formatSize(Math.max(0, preview.requiredBytes - (preview.freeBytes ?? 0)))}。请更换目标盘或释放空间后再开始；预览已保存但不会执行复制。</div>`
        : ""
    }
    <details class="backup-detail"${state.backupDetailOpen ? " open" : ""}>
      <summary>查看明细</summary>
      <div class="backup-summary">
        <span>已存在跳过 ${formatCount(preview.alreadyExistsFiles)}</span>
        <span>冲突 ${formatCount(preview.conflictFiles)}</span>
        <span>忽略 ${formatCount(preview.ignoredFiles)}</span>
        <span>素材总量 ${formatCount(preview.totalFiles)} · ${formatSize(preview.totalBytes)}</span>
        ${mergeDetail}
        <span>深度校验 <strong>${preview.deepVerify ? "开启" : "关闭"}</strong></span>
      </div>
      ${mergeGroups}
      <div class="backup-detail-title">技术说明</div>
      ${techLines}
    </details>
  </div>`;
}

function renderProgressBlock(): string {
  const progress = state.backupProgress;
  const step = state.backupStep;
  // 已点开始、首个进度事件还没到：给一条 indeterminate 状态，别让界面看起来没反应。
  if (step === "running" && !progress) {
    return `<div class="scan-banner" role="status" aria-live="polite">
      <div class="scan-copy"><span class="spinner"></span><span>正在准备备份</span><strong data-backup-percent>0%</strong></div>
      <div class="progress-track is-indeterminate" data-backup-track><span data-backup-track-fill style="width:35%"></span></div>
      <div class="scan-current" data-backup-current>准备中</div>
    </div>`;
  }
  // 取消后步骤条已经回到选择步，但结果卡仍要留着：已复制的文件数、以及
  // 「继续未完成文件」都在里面，撤掉等于把唯一的重试入口藏了。
  if (!progress || (step !== "running" && step !== "done" && step !== "failed" && progress.state !== "cancelled")) return "";
  const progressPercent =
    progress.bytesTotal > 0 ? Math.min(100, Math.max(0, Math.round((progress.bytesProcessed / progress.bytesTotal) * 100))) : 0;
  const done = progress.state === "completed";
  const failed = progress.state === "failed";
  const cancelled = progress.state === "cancelled";
  const title = done ? "备份完成" : failed ? "备份失败" : cancelled ? "备份已取消" : "正在备份";
  const filesLabel = `${formatCount(progress.fileProcessed)} / ${formatCount(progress.fileTotal)} 个文件`;
  const bytesLabel = `${formatSize(progress.bytesProcessed)} / ${formatSize(progress.bytesTotal)}`;
  const liveMeta =
    progress.state === "running" ? `${formatSpeed(progress.speedBytesPerSec)} · ${formatEtaSeconds(progress.etaSeconds)}` : "";
  const safePoint =
    progress.state === "running"
      ? progress.phase === "merging"
        ? "正在合并分段视频。取消会在安全点停止：当前临时文件不会提交；已复制完成的文件会保留。"
        : "取消会在安全点停止：当前临时文件不会提交；已复制完成的文件会保留。"
      : cancelled
        ? `已取消。已复制 ${formatCount(progress.fileProcessed)} 个文件保留在目标盘；可继续重试未完成项，或重新预览。`
        : done
          ? `已复制 ${formatCount(progress.fileProcessed)} 个文件（${formatSize(progress.bytesProcessed)}）。后台将自动扫描入库。`
          : "可只重试失败文件，已成功的文件不会重复复制。";
  return `<div class="scan-banner" role="status" aria-live="polite">
    <div class="scan-copy">
      ${progress.state === "running" ? `<span class="spinner"></span>` : ""}
      <span>${title}</span>
      <strong data-backup-percent>${progress.state === "running" ? `${progressPercent}%` : filesLabel}</strong>
      ${progress.state === "running" ? `<button class="text-button" id="backup-cancel-button" type="button">取消</button>` : ""}
    </div>
    <div class="progress-track${progress.state === "running" && progress.bytesTotal <= 0 ? " is-indeterminate" : ""}" data-backup-track>
      <span data-backup-track-fill style="width:${progress.state === "running" && progress.bytesTotal <= 0 ? "35%" : `${progressPercent}%`}"></span>
    </div>
    <div class="scan-current" data-backup-current>${escapeHtml(progress.currentFile || (progress.state === "running" ? (progress.phase === "merging" ? "正在合并分段" : "准备中") : ""))}${liveMeta ? ` · ${liveMeta}` : ""} · ${bytesLabel}</div>
    <div class="backup-note">${safePoint}</div>
    ${progress.error || failed ? `<div class="backup-note is-danger">${escapeHtml(progress.error || "备份过程中出现错误")}</div>` : ""}
    ${
      (failed || cancelled) && state.backupLastRunId && state.backupFailedItems.length
        ? `
      <div class="backup-actions">
        <button class="primary-button" id="backup-retry-button" type="button" ${state.backupRetrying || progress.state === "running" ? "disabled" : ""}>${state.backupRetrying ? "重试中…" : failed ? "重试失败文件" : "继续未完成文件"}</button>
      </div>
      <div class="backup-failed-list">${state.backupFailedItems
        .slice(0, 8)
        .map(
          (item) =>
            `<div class="backup-failed-item"><span>${escapeHtml(item.sourceRelative)}</span><span>${escapeHtml(item.errorMessage || "未完成")}</span></div>`,
        )
        .join(
          "",
        )}${state.backupFailedItems.length > 8 ? `<div class="backup-failed-item"><span>…</span><span>共 ${formatCount(state.backupFailedItems.length)} 项</span></div>` : ""}</div>
    `
        : (failed || cancelled) && state.backupLastRunId
          ? `<div class="backup-note">没有可重试的文件项。可重新生成预览后再备份。</div>`
          : ""
    }
  </div>`;
}

function renderHistoryBlock(): string {
  const historyRows = state.backupHistory.length
    ? state.backupHistory
        .map((run) => {
          const expanded = state.backupExpandedRunId === run.id;
          const detail = expanded ? state.backupHistoryItems : [];
          return `<div class="backup-history-item${expanded ? " is-expanded" : ""}">
          <button type="button" class="backup-history-row" data-backup-run="${escapeHtml(run.id)}">
            <span class="status">${backupStatusLabel(run.status)}</span>
            <span class="time">${escapeHtml(formatCaptureAt(run.startedAt) || run.startedAt)}</span>
            <span class="src">${escapeHtml(run.sourceRootPath)}</span>
            <span class="nums">成功 ${formatCount(run.copiedFiles)} · 跳过 ${formatCount(run.skippedFiles)} · 失败 ${formatCount(run.failedFiles)} · ${formatSize(run.copiedBytes)}</span>
          </button>
          ${
            expanded
              ? `
            ${run.errorSummary ? `<div class="backup-note is-danger">${escapeHtml(run.errorSummary)}</div>` : ""}
            ${
              detail.length
                ? `<div class="backup-failed-list">${detail
                    .slice(0, 10)
                    .map(
                      (item) =>
                        `<div class="backup-failed-item"><span>${escapeHtml(item.sourceRelative)}</span><span>${escapeHtml(item.errorMessage || "未完成")}</span></div>`,
                    )
                    .join("")}</div>`
                : `<div class="backup-note">该次没有失败/未完成文件。</div>`
            }
          `
              : ""
          }
        </div>`;
        })
        .join("")
    : `<div class="backup-note">还没有备份记录。完成一次备份后会出现在这里。</div>`;

  return `<div class="backup-step-block">
      <div class="backup-step-title">最近备份</div>
      <div class="backup-history">${historyRows}</div>
    </div>`;
}

/** 页脚按步骤给动作：选择/确认是预览与开始，完成/失败是「再导入一次」。 */
function renderImportFooter(): string {
  const step = state.backupStep;
  const preview = state.backupPreview;
  const progress = state.backupProgress;
  const running = step === "running";
  const spaceOk = preview?.spaceSufficient !== false;
  const willCopy = preview ? willCopyCount(preview) : 0;
  const canPreview =
    !running &&
    !state.backupLoading &&
    state.availability === "available" &&
    state.backupSources.length > 0 &&
    state.libraries.length > 0;
  const parts: string[] = [];
  if (step === "select" || step === "confirm") {
    parts.push(
      `<button class="${preview ? "outline-button" : "primary-button"} backup-footer-preview" id="backup-preview-button" type="button" ${canPreview ? "" : "disabled"}>${state.backupLoading ? "生成预览中…" : preview ? "刷新预览" : "生成预览"}</button>`,
    );
  }
  if (step === "confirm" && preview) {
    parts.push(
      `<button class="primary-button" id="backup-start-button" type="button" ${running || state.backupLoading || !spaceOk || willCopy === 0 ? "disabled" : ""}>${willCopy === 0 ? "没有需要复制的文件" : spaceOk ? "确认并开始备份" : "空间不足，无法开始"}</button>`,
    );
  }
  if (step === "done" || step === "failed") {
    parts.push(`<button class="primary-button" id="backup-restart" type="button">再导入一次</button>`);
  }
  if (step === "done" && progress?.state === "completed" && state.backupLastRunId) {
    parts.push(`<button class="text-button" id="backup-view-new-later" type="button">稍后再看</button>`);
    parts.push(`<button class="outline-button" id="backup-view-new" type="button">查看新导入</button>`);
  }
  return `<div class="backup-footer">${parts.join("")}</div>`;
}

/**
 * 「整理分段」标签页的内容。
 *
 * 从设置页「扫描与索引」分区整块搬来：DOM 结构与 id 原样保留（`library-merge-*`、
 * `.merge-pick-*`），只换容器。状态与命令仍是 libraryMerge* 系列，没有分叉。
 */
export function renderMergeSegmentsBody(): string {
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

  const previewBlock = mergePreview
    ? `<div class="settings-stat-grid">
        <div><span>已选</span><strong>${formatCount(selectedGroups.length)} / ${formatCount(mergePreview.groupCount)} 组</strong></div>
        <div><span>分段</span><strong>${formatCount(selectedSegments)}</strong></div>
        <div><span>大小</span><strong>${formatSize(selectedBytes)}</strong></div>
        <div><span>目标剩余</span><strong class="${mergeSpaceOk ? "" : "is-danger"}">${mergePreview.freeBytes === null ? "不可用" : formatSize(mergePreview.freeBytes)}</strong></div>
      </div>
      ${
        mergePreview.groupCount === 0
          ? `<div class="backup-note">没有需要合并的分段视频。</div>`
          : `
      <div class="merge-pick-tools">
        <input id="library-merge-filter" value="${escapeHtml(state.libraryMergeFilter)}" placeholder="筛选文件名或时间戳" aria-label="筛选分段" ${mergeRunning ? "disabled" : ""} />
        <button class="text-button" type="button" id="library-merge-select-visible" ${mergeRunning || visibleGroups.length === 0 ? "disabled" : ""}>${mergeQuery ? "全选当前" : "全选"}</button>
        <button class="text-button" type="button" id="library-merge-clear-visible" ${mergeRunning || visibleGroups.length === 0 ? "disabled" : ""}>${mergeQuery ? "清除当前" : "全不选"}</button>
      </div>
      <div class="merge-pick-list" id="library-merge-list">${visibleGroups.map((group) => `<label class="merge-pick"><input type="checkbox" data-merge-dest="${escapeHtml(group.destinationRelative)}" ${state.libraryMergeSelected.has(group.destinationRelative) ? "checked" : ""} ${mergeRunning ? "disabled" : ""} /><span class="merge-pick-name">${escapeHtml(group.sources.map(pathBaseName).join(" + "))}</span><span class="merge-pick-meta">→ ${escapeHtml(group.fileName)} · ${formatSize(group.sizeBytes)}</span></label>`).join("")}${visibleGroups.length === 0 ? `<div class="backup-note">没有符合筛选的分组。</div>` : ""}</div>
      ${selectedGroups.length === 0 ? `<div class="backup-note">请至少勾选一组再合并。</div>` : ""}
      ${selectedGroups.length > 0 && !mergeSpaceOk ? `<div class="backup-note is-danger">所选分段需要的空间超过目标盘剩余，无法开始合并。</div>` : ""}`
      }`
    : `<div class="backup-note">${state.libraryMergeLoading ? "正在扫描分段…" : "先生成预览，再勾选要合并的组。"}</div>`;

  const recycleBlock =
    mergePreview && mergePreview.groupCount > 0 && !mergeRunning
      ? `<label class="backup-note backup-merge-recycle"><input type="checkbox" id="library-merge-recycle" ${state.libraryMergeRecycle ? "checked" : ""} /> 合并成功后把原分段移入回收站（可再从回收站恢复）</label>`
      : "";

  const confirmBlock = state.libraryMergeConfirm
    ? `<div class="settings-confirm">
        <p>将合并已勾选的 ${formatCount(selectedGroups.length)} 组（约 ${formatSize(selectedBytes)}，共 ${formatCount(mergePreview?.groupCount ?? 0)} 组可选）。合并过程用 ffmpeg 无损拼接，源分段在校验成功前不会删除。${state.libraryMergeRecycle ? "成功后原分段会移入回收站。" : "原分段会保留在库里。"}是否开始？</p>
        <div class="backup-actions">
          <button class="outline-button" type="button" id="library-merge-confirm-cancel">取消</button>
          <button class="primary-button" type="button" id="library-merge-confirm-start">确认合并</button>
        </div>
      </div>`
    : "";

  const progressBlock = mergeProgress
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
    : "";

  return `<div class="backup-step-block backup-merge">
    <div class="backup-step-title">整理历史分段</div>
    <div class="backup-note">把媒体库里相机自动截断的分段视频无损合并成完整长视频。只合并同一 VID_日期_时间、且末尾序号连续的文件；时间不同的相邻序号（例如 150035_122 和 150534_123）不会合并。生成预览后可以勾选其中几组，不必一次处理全部。</div>
    ${state.libraryMergeNotice ? `<div class="backup-note">${escapeHtml(state.libraryMergeNotice)}</div>` : ""}
    ${previewBlock}
    <div class="backup-actions">
      <button class="outline-button" type="button" id="library-merge-preview" ${!state.library || state.availability !== "available" || mergeRunning || state.libraryMergeLoading ? "disabled" : ""}>${state.libraryMergeLoading ? "扫描中…" : mergePreview ? "刷新预览" : "生成预览"}</button>
      <button class="primary-button" type="button" id="library-merge-start" ${canStartMerge ? "" : "disabled"}>${mergeRunning ? "合并中…" : selectedGroups.length > 0 && mergePreview && selectedGroups.length < mergePreview.groupCount ? `合并所选 ${formatCount(selectedGroups.length)}` : "开始合并"}</button>
    </div>
    ${recycleBlock}
    ${confirmBlock}
    ${progressBlock}
  </div>`;
}

/**
 * 只替换「整理分段」体：整块重建抽屉会丢筛选框焦点与滚动位置，勾选/筛选都
 * 是高频操作，不能每次都把整面 DOM 换掉。
 */
export function patchImportMergeView(): void {
  if (!state.backupOpen || state.importTab !== "merge") return;
  const host = app.querySelector<HTMLElement>('[data-overlay="backup"]');
  const body = host?.querySelector<HTMLElement>("#import-merge-body");
  if (!host || !body) return;
  const scroller = host.querySelector<HTMLElement>(".backup-body");
  const scrollTop = scroller?.scrollTop ?? 0;
  const list = body.querySelector<HTMLElement>("#library-merge-list");
  const listScroll = list?.scrollTop ?? 0;
  const filter = body.querySelector<HTMLInputElement>("#library-merge-filter");
  const filterFocused = filter !== null && document.activeElement === filter;
  const cursor = filterFocused ? filter.selectionStart : null;
  body.innerHTML = renderMergeSegmentsBody();
  if (scroller) scroller.scrollTop = scrollTop;
  const nextList = host.querySelector<HTMLElement>("#library-merge-list");
  if (nextList) nextList.scrollTop = listScroll;
  if (filterFocused) {
    const next = host.querySelector<HTMLInputElement>("#library-merge-filter");
    if (next) {
      next.focus();
      if (cursor !== null) next.setSelectionRange(cursor, cursor);
    }
  }
}
