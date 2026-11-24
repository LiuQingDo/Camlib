import { beforeEach, describe, expect, it } from "vitest";
import type { BackupPreviewDto, BackupVolumeDto, ConflictPolicy } from "../api/media";

// render/context 在模块加载时就要 #app；本文件只调纯字符串渲染函数，给个空壳即可。
const stub = { querySelector: () => null } as unknown as HTMLElement;
Object.defineProperty(globalThis, "document", {
  configurable: true,
  value: { querySelector: () => stub },
});

const { state } = await import("../state");
const { renderBackupPanel } = await import("./backup");

const source: BackupVolumeDto = {
  id: "vol-1",
  volumeLabel: "EOS_DIGITAL",
  rootPath: "E:\\",
  freeBytes: 64_000_000_000,
} as unknown as BackupVolumeDto;

function makePreview(patch: Partial<Record<string, unknown>> = {}): BackupPreviewDto {
  return {
    id: "preview-1",
    backupRunId: "run-1",
    readyFiles: 120,
    conflictPolicy: "skip_same" as ConflictPolicy,
    conflictFiles: 3,
    alreadyExistsFiles: 7,
    ignoredFiles: 2,
    totalFiles: 132,
    totalBytes: 8_000_000_000,
    requiredBytes: 7_500_000_000,
    freeBytes: 64_000_000_000,
    spaceSufficient: true,
    deepVerify: false,
    mergeGroupCount: 2,
    mergeSegmentCount: 5,
    mergeGroups: [
      { fileName: "MVI_0001.MP4", sizeBytes: 900_000_000, segments: ["MVI_0001_001.MP4", "MVI_0001_002.MP4"] },
    ],
    ...patch,
  } as unknown as BackupPreviewDto;
}

describe("导入抽屉渲染", () => {
  beforeEach(() => {
    state.backupStep = "select";
    state.importTab = "import";
    state.backupPreview = null;
    state.backupProgress = null;
    state.backupJobId = null;
    state.backupSources = [source];
    state.backupSourceId = source.id;
    state.backupTargetId = null;
    state.libraries = [];
    state.backupConflictPolicy = "skip_same";
    state.backupMergeSegments = true;
    state.backupDeepVerify = false;
    state.backupIgnoreExtensions = ".dng, .lrv";
    state.backupAdvancedOpen = false;
    state.backupDetailOpen = false;
    state.backupFailedItems = [];
    state.backupLastRunId = null;
    state.libraryMergePreview = null;
    state.libraryMergeProgress = null;
    state.libraryMergeJobId = null;
    state.libraryMergeSelected = new Set();
  });

  it("第 1 步首屏只有两个下拉，其余四个控件收在高级选项里", () => {
    const html = renderBackupPanel();
    const advancedAt = html.indexOf('class="backup-advanced"');
    expect(advancedAt).toBeGreaterThan(-1);
    // 源盘 / 目标在折叠之外，其余四个 id 全部落在 details 之内。
    expect(html.indexOf('id="backup-source"')).toBeLessThan(advancedAt);
    expect(html.indexOf('id="backup-target"')).toBeLessThan(advancedAt);
    for (const id of ["backup-conflict", "backup-merge", "backup-ignore", "backup-deep-verify"]) {
      expect(html.indexOf(`id="${id}"`)).toBeGreaterThan(advancedAt);
    }
    expect(html).toContain("高级选项");
  });

  it("高级选项收起时仍显示当前生效值，并随选项变化", () => {
    expect(renderBackupPanel()).toContain("跳过同名 · 合并分段 · 不深度校验 · 忽略 2 种扩展名");
    state.backupConflictPolicy = "rename";
    state.backupMergeSegments = false;
    state.backupDeepVerify = true;
    state.backupIgnoreExtensions = "";
    expect(renderBackupPanel()).toContain("自动重命名 · 保留分段 · 深度校验 · 不忽略扩展名");
  });

  it("没有可移动盘时给出三行排查与刷新按钮", () => {
    state.backupSources = [];
    state.backupSourceId = null;
    const html = renderBackupPanel();
    expect(html).toContain("未发现包含 DCIM 的可移动盘");
    expect(html).toContain("USB 存储 / 文件传输");
    expect(html).toContain("盘符");
    expect(html).toContain("DCIM");
    expect(html).toContain('id="backup-refresh-sources"');
  });

  it("第 2 步首屏是三块大数字加一行冲突结论，明细默认收起", () => {
    state.backupStep = "confirm";
    state.backupPreview = makePreview();
    const html = renderBackupPanel();
    expect(html).toContain("backup-hero-stats");
    expect(html).toContain("<span>将复制</span>");
    expect(html).toContain("<span>需要</span>");
    expect(html).toContain("<span>剩余</span>");
    expect(html).toContain("3 个同名文件将跳过");
    expect(html).toContain("<summary>查看明细</summary>");
    expect(html).toContain("技术说明");
    expect(html).toContain('id="backup-step-back"');
  });

  it("运行中隐藏上一步，只留取消", () => {
    state.backupStep = "running";
    state.backupProgress = {
      jobId: "job-1",
      kind: "backup",
      seq: 2,
      phase: "copying",
      state: "running",
      currentFile: "DCIM/100/MVI_1.MP4",
      fileProcessed: 1,
      fileTotal: 120,
      bytesProcessed: 10,
      bytesTotal: 100,
      speedBytesPerSec: 0,
      etaSeconds: null,
      errors: [],
      error: null,
    } as never;
    const html = renderBackupPanel();
    expect(html).not.toContain('id="backup-step-back"');
    expect(html).toContain('id="backup-cancel-button"');
    expect(html).toContain("正在备份");
  });

  it("取消后停在选择步，但结果卡留着可以继续未完成文件", () => {
    state.backupStep = "select";
    state.backupLastRunId = "run-1";
    state.backupFailedItems = [{ id: "item-1", sourceRelative: "DCIM/100/MVI_1.MP4", errorMessage: "中断" }] as never;
    state.backupProgress = {
      jobId: "job-1",
      kind: "backup",
      seq: 9,
      phase: "copying",
      state: "cancelled",
      currentFile: null,
      fileProcessed: 88,
      fileTotal: 120,
      bytesProcessed: 1,
      bytesTotal: 2,
      speedBytesPerSec: 0,
      etaSeconds: null,
      errors: [],
      error: null,
    } as never;
    const html = renderBackupPanel();
    // 步骤条回到 1，而不是停在「3. 执行」。
    expect(html).toContain('class="backup-step is-active">1. 选择</span>');
    expect(html).not.toContain('class="backup-step is-active">3. 执行</span>');
    expect(html).toContain("备份已取消");
    expect(html).toContain('id="backup-retry-button"');
  });

  it("完成后提供再导入一次与查看新导入", () => {
    state.backupStep = "done";
    state.backupLastRunId = "run-1";
    state.backupProgress = { state: "completed", jobId: "job-1", fileProcessed: 120 } as never;
    const html = renderBackupPanel();
    expect(html).toContain('id="backup-restart"');
    expect(html).toContain('id="backup-view-new"');
  });

  it("整理分段 tab 迁移后六条路径的控件都在", () => {
    state.importTab = "merge";
    const html = renderBackupPanel();
    expect(html).toContain('id="import-merge-body"');
    expect(html).toContain('data-import-tab="import"');
    expect(html).toContain('data-import-tab="merge"');

    state.libraryMergePreview = {
      libraryId: "lib-1",
      groupCount: 2,
      segmentCount: 5,
      totalBytes: 1,
      requiredTempBytes: 1,
      freeBytes: 64_000_000_000,
      spaceSufficient: true,
      groups: [
        { destinationRelative: "a.mp4", fileName: "a.mp4", groupKey: "k", sizeBytes: 10, sources: ["a_001.mp4", "a_002.mp4"] },
      ],
    } as never;
    state.libraryMergeSelected = new Set(["a.mp4"]);
    const withPreview = renderBackupPanel();
    for (const id of [
      "library-merge-preview",
      "library-merge-start",
      "library-merge-list",
      "library-merge-filter",
      "library-merge-select-visible",
      "library-merge-clear-visible",
      "library-merge-recycle",
    ]) {
      expect(withPreview).toContain(`id="${id}"`);
    }
    expect(withPreview).toContain('data-merge-dest="a.mp4"');

    state.libraryMergeProgress = { state: "running", jobId: "job", groupProcessed: 1, groupTotal: 2 } as never;
    expect(renderBackupPanel()).toContain('id="library-merge-cancel"');
  });
});
