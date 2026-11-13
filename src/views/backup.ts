import { formatCaptureAt, formatCount, formatEtaSeconds, formatSize, formatSpeed } from "../lib/format";
import { backupStatusLabel, conflictPolicyLabel, escapeHtml, willCopyCount } from "../render/text";
import { state } from "../state";

export function renderBackupPanel(): string {
  if (!state.backupOpen) return "";
  const preview = state.backupPreview;
  const progress = state.backupProgress;
  const running = Boolean(state.backupJobId) || progress?.state === "running";
  // Keep step 3 visible while running or after a terminal event so the result
  // card and retry actions stay next to the progress they describe.
  const activeStep = running || (progress && progress.state !== "running") ? 3 : preview ? 2 : 1;
  const progressPercent =
    progress && progress.bytesTotal > 0
      ? Math.min(100, Math.max(0, Math.round((progress.bytesProcessed / progress.bytesTotal) * 100)))
      : 0;
  const stepChip = (index: number, label: string): string =>
    `<span class="backup-step${activeStep === index ? " is-active" : activeStep > index ? " is-done" : ""}">${index}. ${label}</span>`;

  const sourceOptions = state.backupSources.length
    ? state.backupSources
        .map((source) => {
          const selected = (state.backupSourceId ?? state.backupSources[0]?.id) === source.id;
          return `<option value="${escapeHtml(source.id)}" ${selected ? "selected" : ""}>${escapeHtml(source.volumeLabel || source.rootPath)} · ${escapeHtml(source.rootPath)}</option>`;
        })
        .join("")
    : '<option value="">未发现包含 DCIM 的可移动盘</option>';
  const targetOptions = state.libraries
    .map((library) => {
      const selected = (state.backupTargetId ?? state.library?.id ?? state.libraries[0]?.id) === library.id;
      return `<option value="${escapeHtml(library.id)}" ${selected ? "selected" : ""}>${escapeHtml(library.volumeLabel || library.rootPath)}</option>`;
    })
    .join("");

  const formDisabled = running || state.backupLoading || state.availability !== "available";
  const canPreview = !formDisabled && state.backupSources.length > 0 && state.libraries.length > 0;

  let previewBlock = "";
  if (preview) {
    const willCopy = willCopyCount(preview);
    const spaceOk = preview.spaceSufficient !== false;
    const conflictNote =
      preview.conflictFiles > 0
        ? preview.conflictPolicy === "skip_same"
          ? `${formatCount(preview.conflictFiles)} 个同名冲突文件将按「跳过冲突」忽略`
          : preview.conflictPolicy === "rename"
            ? `${formatCount(preview.conflictFiles)} 个同名冲突文件将自动重命名后复制`
            : `${formatCount(preview.conflictFiles)} 个同名冲突文件将覆盖目标中的旧文件`
        : "无同名冲突";
    previewBlock = `
      <div class="backup-step-block">
        <div class="backup-step-title">第 2 步 · 确认摘要</div>
        <div class="backup-summary">
          <span>将复制 <strong>${formatCount(willCopy)}</strong> 个文件</span>
          <span>所需空间 <strong>${formatSize(preview.requiredBytes)}</strong></span>
          <span class="${spaceOk ? "" : "is-danger"}">目标剩余 <strong>${preview.freeBytes === null ? "不可用" : formatSize(preview.freeBytes)}</strong></span>
          <span>已存在跳过 ${formatCount(preview.alreadyExistsFiles)}</span>
          <span>冲突 ${formatCount(preview.conflictFiles)}</span>
          <span>忽略 ${formatCount(preview.ignoredFiles)}</span>
          <span>素材总量 ${formatCount(preview.totalFiles)} · ${formatSize(preview.totalBytes)}</span>
          ${
            preview.mergeGroupCount > 0
              ? `<span>分段合并 <strong>${formatCount(preview.mergeGroupCount)}</strong> 组（${formatCount(preview.mergeSegmentCount)} 个分段）</span>`
              : ""
          }
          <span>深度校验 <strong>${preview.deepVerify ? "开启" : "关闭"}</strong></span>
        </div>
        ${
          preview.mergeGroups.length
            ? `<div class="backup-failed-list">${preview.mergeGroups
                .slice(0, 8)
                .map(
                  (group) =>
                    `<div class="backup-failed-item"><span>${escapeHtml(group.segments.join(" + "))}</span><span>→ ${escapeHtml(group.fileName)} · ${formatSize(group.sizeBytes)}</span></div>`,
                )
                .join(
                  "",
                )}${preview.mergeGroups.length > 8 ? `<div class="backup-failed-item"><span>…</span><span>共 ${formatCount(preview.mergeGroups.length)} 组</span></div>` : ""}</div>`
            : ""
        }
        <div class="backup-note${spaceOk ? "" : " is-danger"}">${
          !spaceOk
            ? `目标盘空间不足：还需约 ${formatSize(Math.max(0, preview.requiredBytes - (preview.freeBytes ?? 0)))}。请更换目标盘或释放空间后再开始；预览已保存但不会执行复制。`
            : preview.mergeGroupCount > 0
              ? `冲突策略「${conflictPolicyLabel(preview.conflictPolicy)}」：${conflictNote}。同一 VID_日期_时间 且序号连续的分段会合并成完整视频；时间不同的相邻序号保持分开。源盘只读，合并用 ffmpeg 无损拼接。复制完成后会自动扫描入库。`
              : `冲突策略「${conflictPolicyLabel(preview.conflictPolicy)}」：${conflictNote}。相机源盘始终只读，复制完成后会自动扫描入库。`
        }${
          preview.deepVerify
            ? preview.mergeGroupCount > 0
              ? "深度校验已开启：逐个文件比对内容哈希，仅分段合并生成的视频例外（ffmpeg 重新封装，字节不同，仍按大小窗口校验）。"
              : "深度校验已开启：每个文件复制后都会回读目标文件并比对内容哈希，较慢，但能发现大小不变的内容损坏。"
            : ""
        }</div>
        <div class="backup-actions">
          <button class="primary-button" id="backup-start-button" type="button" ${running || state.backupLoading || !spaceOk || willCopy === 0 ? "disabled" : ""}>${willCopy === 0 ? "没有需要复制的文件" : spaceOk ? "确认并开始备份" : "空间不足，无法开始"}</button>
        </div>
      </div>`;
  }

  let progressBlock = "";
  if (progress) {
    const done = progress.state === "completed";
    const failed = progress.state === "failed";
    const cancelled = progress.state === "cancelled";
    const title = done ? "备份完成" : failed ? "备份失败" : cancelled ? "备份已取消" : "正在备份";
    const filesLabel = `${formatCount(progress.fileProcessed)} / ${formatCount(progress.fileTotal)} 个文件`;
    const bytesLabel = `${formatSize(progress.bytesProcessed)} / ${formatSize(progress.bytesTotal)}`;
    const liveMeta =
      progress.state === "running"
        ? `${formatSpeed(progress.speedBytesPerSec)} · ${formatEtaSeconds(progress.etaSeconds)}`
        : "";
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
    progressBlock = `
      <div class="scan-banner" role="status" aria-live="polite">
        <div class="scan-copy">
          ${progress.state === "running" ? `<span class="spinner"></span>` : ""}
          <span>${title}</span>
          <strong>${progress.state === "running" ? `${progressPercent}%` : filesLabel}</strong>
          ${progress.state === "running" ? `<button class="text-button" id="backup-cancel-button" type="button">取消</button>` : ""}
        </div>
        <div class="progress-track${progress.state === "running" && progress.bytesTotal <= 0 ? " is-indeterminate" : ""}">
          <span style="width:${progress.state === "running" && progress.bytesTotal <= 0 ? "35%" : `${progressPercent}%`}"></span>
        </div>
        <div class="scan-current">${escapeHtml(progress.currentFile || (progress.state === "running" ? (progress.phase === "merging" ? "正在合并分段" : "准备中") : ""))}${liveMeta ? ` · ${liveMeta}` : ""} · ${bytesLabel}</div>
        <div class="backup-note">${safePoint}</div>
        ${progress.error || failed ? `<div class="backup-note is-danger">${escapeHtml(progress.error || "备份过程中出现错误")}</div>` : ""}
        ${
          (failed || cancelled) && state.backupLastRunId && state.backupFailedItems.length
            ? `
          <div class="backup-actions">
            <button class="primary-button" id="backup-retry-button" type="button" ${state.backupRetrying || running ? "disabled" : ""}>${state.backupRetrying ? "重试中…" : failed ? "重试失败文件" : "继续未完成文件"}</button>
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
        ${
          done && state.backupLastRunId
            ? `
          <div class="backup-actions">
            <button class="primary-button" id="backup-view-new" type="button">查看新导入</button>
            <button class="text-button" id="backup-view-new-later" type="button">稍后再看</button>
          </div>
        `
            : ""
        }
      </div>`;
  }

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

  return `<section class="backup-panel" aria-label="相机备份">
    <div class="backup-heading">
      <div><strong>相机备份</strong><span>源盘只读 · 临时文件校验后提交</span></div>
      <button class="icon-button" id="close-backup" type="button" aria-label="关闭备份面板">×</button>
    </div>
    <div class="backup-steps" aria-label="备份步骤">${stepChip(1, "选择")}${stepChip(2, "确认")}${stepChip(3, "执行")}</div>
    <div class="backup-step-block">
      <div class="backup-step-title">第 1 步 · 选择源盘与目标</div>
      <div class="backup-form">
        <label><span>源相机盘</span><select id="backup-source" ${formDisabled || !state.backupSources.length ? "disabled" : ""}>${sourceOptions}</select></label>
        <label><span>目标媒体库</span><select id="backup-target" ${formDisabled || !state.libraries.length ? "disabled" : ""}>${targetOptions}</select></label>
        <label><span>冲突策略</span><select id="backup-conflict" ${formDisabled ? "disabled" : ""}><option value="skip_same" ${state.backupConflictPolicy === "skip_same" ? "selected" : ""}>跳过冲突</option><option value="rename" ${state.backupConflictPolicy === "rename" ? "selected" : ""}>自动重命名</option><option value="overwrite" ${state.backupConflictPolicy === "overwrite" ? "selected" : ""}>覆盖目标</option></select></label>
        <label><span>合并分段</span><select id="backup-merge" ${formDisabled ? "disabled" : ""}><option value="on" ${state.backupMergeSegments ? "selected" : ""}>合并为完整视频</option><option value="off" ${state.backupMergeSegments ? "" : "selected"}>保留原分段</option></select></label>
        <label><span>忽略扩展名</span><input id="backup-ignore" value="${escapeHtml(state.backupIgnoreExtensions)}" aria-label="忽略扩展名" ${formDisabled ? "disabled" : ""} /></label>
        <label class="backup-check" title="按文件内容比对源文件与目标文件；较慢，但能发现传输损坏">
          <input id="backup-deep-verify" type="checkbox" ${state.backupDeepVerify ? "checked" : ""} ${formDisabled ? "disabled" : ""} />
          <span>深度校验</span>
        </label>
        <button class="primary-button" id="backup-preview-button" type="button" ${canPreview ? "" : "disabled"}>${state.backupLoading ? "生成预览中…" : preview ? "刷新预览" : "生成预览"}</button>
      </div>
      <div class="backup-note">深度校验：较慢，但能发现传输损坏。开启后会按文件内容逐块比对源文件与写入后的目标文件，速度会低于仅比对大小（默认关闭）。</div>
      ${!state.backupSources.length ? `<div class="backup-note">未检测到包含 DCIM 的可移动盘。请插入相机存储卡或 U 盘后重新打开。</div>` : ""}
    </div>
    ${previewBlock}
    ${progressBlock}
    <div class="backup-step-block">
      <div class="backup-step-title">最近备份</div>
      <div class="backup-history">${historyRows}</div>
    </div>
  </section>`;
}
