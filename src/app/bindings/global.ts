// 由 main.ts 拆分而来：仅做搬移，未改动逻辑。
import { onAiProgress } from "../../api/ai";
import {
  listBackupRunItems,
  onBackupProgress,
  onDeleteProgress,
  onEditProgress,
  onLibraryMergeProgress,
  onPreviewProgress,
  onScanProgress,
  onVideoMergeProgress,
} from "../../api/media";
import { previewAssetCache } from "../../media/cache";
import { app } from "../../render/context";
import { render, renderSettingsAware } from "../../render/paint";
import { closeTagFilterPopover, patchToolbar, tagPopoverOpen, updateScanProgressView } from "../../render/toolbar";
import { invalidateGridGeometry, scheduleGridPaint } from "../../render/virtual";
import { state } from "../../state";
import { closeAiChatDrawer } from "../../views/ai-chat";
import { applyDialogSizes, mergeUpdateFooter } from "../../views/dialogs";
import { closeEditor } from "../../views/editor";
import { editorUpdateFooter } from "../../views/editor/shared";
import {
  closePreview,
  movePreview,
  toggleLivePreview,
  togglePreviewFullscreen,
  togglePreviewImmersive,
  togglePreviewInfo,
  togglePreviewMute,
  togglePreviewPlayback,
} from "../../views/preview";
import { previewUi } from "../../views/preview/state";
import { updateSettingsPanel } from "../../views/settings";
import { closeMergeModal, closeTagManager } from "../dialogs-ops";
import { bootstrap, loadBackupHistory } from "../library";
import { cancelDeleteConfirm, runConfirmedDelete } from "../media-ops";
import { refreshTags } from "../media-query";
import { closeSettings, loadAiStats, loadSettingsSectionData } from "../settings-ops";
import { handleCutCompleted, handleEditSaved, handleMergeCompleted } from "./editor";
import { rerenderPreviewMetaPanel } from "./preview";

window.addEventListener("keydown", (event) => {
  if (state.editorOpen) {
    if (event.key === "Escape") {
      event.preventDefault();
      closeEditor();
    }
    return;
  }
  if (state.tagsManagerOpen) {
    if (event.key === "Escape") {
      event.preventDefault();
      closeTagManager();
    }
    return;
  }
  if (state.settingsOpen) {
    if (event.key === "Escape") {
      event.preventDefault();
      if (state.fullRebuildConfirm) {
        state.fullRebuildConfirm = false;
        updateSettingsPanel();
      } else if (state.purgeMissingConfirm) {
        state.purgeMissingConfirm = false;
        updateSettingsPanel();
      } else {
        closeSettings();
      }
      return;
    }
    return;
  }
  if (state.mergeModalOpen) {
    if (event.key === "Escape") {
      event.preventDefault();
      closeMergeModal();
    }
    return;
  }
  if (state.deleteConfirm && !state.deleting) {
    if (event.key === "Escape") {
      event.preventDefault();
      cancelDeleteConfirm();
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      void runConfirmedDelete();
      return;
    }
  }
  // The toolbar tag popover closes before the "/" shortcut / preview Escape
  // paths can act on the same keypress.
  if (tagPopoverOpen && event.key === "Escape") {
    event.preventDefault();
    closeTagFilterPopover();
    return;
  }
  if (state.previewIndex === null) {
    if (event.key === "/" && document.activeElement?.tagName !== "INPUT") {
      event.preventDefault();
      app.querySelector<HTMLInputElement>("#search-input")?.focus();
    }
    // AI 助手抽屉层级低于预览：仅当没有更高层浮层时才用 Esc 关它。
    if (state.aiChatOpen && event.key === "Escape") {
      event.preventDefault();
      closeAiChatDrawer();
      return;
    }
    return;
  }
  const target = event.target as HTMLElement | null;
  const typing = target?.tagName === "INPUT" || target?.tagName === "TEXTAREA" || target?.isContentEditable === true;
  // The preview tag picker swallows Escape first so it closes without taking
  // the whole preview down, even while its search input holds focus.
  if (previewUi.tagPickerOpen && event.key === "Escape") {
    event.preventDefault();
    previewUi.tagPickerOpen = false;
    previewUi.tagPickerQuery = "";
    rerenderPreviewMetaPanel();
    return;
  }
  if (typing) return;
  if (event.key === "Escape") {
    // Fullscreen Escape should only leave fullscreen, not close the modal.
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => undefined);
      return;
    }
    if (state.previewImmersive) {
      togglePreviewImmersive(false);
      return;
    }
    closePreview();
    return;
  }
  if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
    event.preventDefault();
    movePreview(-1);
    return;
  }
  if (event.key === "ArrowRight" || event.key === "ArrowDown") {
    event.preventDefault();
    movePreview(1);
    return;
  }
  if (event.key === " " || event.key === "Spacebar") {
    const tag = target?.tagName;
    // Let focused controls keep their native Space activation; the video
    // element already toggles playback when it has focus.
    if (
      tag === "BUTTON" ||
      tag === "A" ||
      tag === "INPUT" ||
      tag === "SELECT" ||
      tag === "VIDEO" ||
      tag === "SUMMARY" ||
      tag === "LABEL"
    ) {
      return;
    }
    event.preventDefault();
    togglePreviewPlayback();
    return;
  }
  if (event.key === "f" || event.key === "F") {
    event.preventDefault();
    togglePreviewFullscreen();
    return;
  }
  if (event.key === "i" || event.key === "I") {
    event.preventDefault();
    togglePreviewInfo();
    return;
  }
  if (event.key === "e" || event.key === "E") {
    event.preventDefault();
    togglePreviewImmersive();
    return;
  }
  if (event.key === "l" || event.key === "L") {
    event.preventDefault();
    toggleLivePreview();
    return;
  }
  if (event.key === "m" || event.key === "M") {
    event.preventDefault();
    togglePreviewMute();
    return;
  }
  if (event.key === "/" && document.activeElement?.tagName !== "INPUT") {
    event.preventDefault();
    app.querySelector<HTMLInputElement>("#search-input")?.focus();
  }
});

void onScanProgress((progress) => {
  const terminal = progress.state === "completed" || progress.state === "cancelled" || progress.state === "failed";
  if (terminal) {
    // Fast scans finish before library_scan_start returns, so scanProgress may
    // still be null. Accept that terminal event; drop only a different known job.
    if (state.scanProgress && progress.jobId !== state.scanProgress.jobId) return;
    if (!state.scanProgress && !state.scanning) return;
    state.scanning = false;
    state.scanProgress = progress;
    if (progress.state === "failed") state.error = progress.error ?? "扫描失败";
    if (progress.state === "completed") {
      state.settingsNotice = "扫描完成";
      state.fullRebuildConfirm = false;
    }
    if (state.settingsOpen) {
      updateSettingsPanel();
      void bootstrap().then(() => {
        if (state.settingsOpen) void loadSettingsSectionData().then(() => updateSettingsPanel());
      });
    } else {
      render();
      void bootstrap();
    }
    return;
  }
  if (!state.scanProgress || progress.jobId !== state.scanProgress.jobId) {
    state.scanning = true;
    state.scanProgress = progress;
    renderSettingsAware();
    return;
  }
  state.scanProgress = progress;
  updateScanProgressView();
});

void onPreviewProgress((progress) => {
  if (!state.thumbnailJobId && progress.state === "running") return;
  if (state.thumbnailJobId && progress.jobId !== state.thumbnailJobId && progress.state === "running") return;
  state.thumbnailProgress = progress;
  if (progress.state === "running") {
    state.thumbnailRebuilding = true;
    renderSettingsAware();
    return;
  }
  state.thumbnailRebuilding = false;
  if (state.thumbnailJobId && progress.jobId !== state.thumbnailJobId) return;
  state.thumbnailJobId = null;
  state.settingsNotice =
    progress.state === "completed"
      ? "缩略图重建完成"
      : progress.state === "cancelled"
        ? "缩略图重建已取消"
        : progress.error
          ? `缩略图重建失败：${progress.error}`
          : "缩略图重建结束";
  if (state.settingsOpen) void loadSettingsSectionData().then(() => updateSettingsPanel());
  else patchToolbar();
});

void onDeleteProgress((progress) => {
  if (!state.deleting) return;
  state.deleteProgress = progress;
  if (progress.state === "completed") return;
  // 进度条在状态区；网格一张卡都不用动。
  patchToolbar();
});

void onBackupProgress((progress) => {
  // Accept a terminal event that raced with startBackup's response, but never
  // adopt a different job's progress.
  if (state.backupJobId && progress.jobId !== state.backupJobId) return;
  if (!state.backupJobId && progress.state === "running") return;
  state.backupProgress = progress;
  if (progress.state === "running") {
    // running 态只改状态区里的进度面板。
    patchToolbar();
    return;
  }
  state.backupJobId = null;
  if (progress.state === "failed") state.error = progress.error ?? "备份失败";
  void loadBackupHistory().then(() => patchToolbar());
  if (state.backupLastRunId) {
    void listBackupRunItems(state.backupLastRunId, true)
      .then((items) => {
        state.backupFailedItems = items;
        patchToolbar();
      })
      .catch(() => {
        state.backupFailedItems = [];
        patchToolbar();
      });
  }
  patchToolbar();
});

void onLibraryMergeProgress((progress) => {
  if (state.libraryMergeJobId && progress.jobId !== state.libraryMergeJobId && progress.state === "running") return;
  if (!state.libraryMergeJobId && progress.state === "running") return;
  state.libraryMergeProgress = progress;
  if (progress.state === "running") {
    state.libraryMergeJobId = progress.jobId;
    if (state.settingsOpen) updateSettingsPanel();
    return;
  }
  state.libraryMergeJobId = null;
  state.libraryMergeConfirm = false;
  const detail = progress.errors.slice(0, 3).join("；");
  state.libraryMergeNotice =
    progress.state === "completed"
      ? "分段整理完成，已触发增量扫描"
      : progress.state === "cancelled"
        ? "分段整理已取消"
        : progress.error
          ? `分段整理失败：${progress.error}${detail ? `｜${detail}` : ""}`
          : "分段整理结束";
  if (progress.state !== "completed") {
    // Keep the preview so the user can retry after fixing the cause.
  } else {
    state.libraryMergePreview = null;
  }
  if (state.settingsOpen) {
    updateSettingsPanel();
    void loadSettingsSectionData().then(() => updateSettingsPanel());
  } else {
    render();
    void bootstrap();
  }
});

void onAiProgress((progress) => {
  if (state.aiJobId && progress.jobId !== state.aiJobId && progress.state === "running") return;
  if (!state.aiJobId && progress.state === "running") return;
  state.aiProgress = progress;
  if (progress.state === "running") {
    state.aiJobId = progress.jobId;
    if (state.settingsOpen) updateSettingsPanel();
    return;
  }
  state.aiJobId = null;
  state.aiConfirming = false;
  // The batch may have retagged any item in the library; drop every cached
  // preview so an open/reopened modal refetches fresh AI meta.
  previewAssetCache.clear();
  state.settingsNotice =
    progress.state === "completed"
      ? `AI 处理完成：成功 ${progress.succeeded}，失败 ${progress.failed}${progress.skipped ? `，跳过 ${progress.skipped}` : ""}`
      : progress.state === "cancelled"
        ? "AI 处理已取消"
        : `AI 处理失败：${progress.error ?? "未知错误"}`;
  // Refresh counters (and tags, since AI tagging may add new ones) after a run.
  void refreshTags();
  if (state.library) void loadAiStats().then(() => renderSettingsAware());
  if (state.settingsOpen) {
    updateSettingsPanel();
    void loadSettingsSectionData().then(() => updateSettingsPanel());
  } else {
    renderSettingsAware();
  }
});

void onEditProgress((progress) => {
  if (!state.editorJobId || progress.jobId !== state.editorJobId) return;
  state.editorProgress = progress;
  if (progress.state === "running") {
    editorUpdateFooter();
    return;
  }
  state.editorJobId = null;
  if (progress.state === "completed" && progress.result) {
    handleEditSaved(progress.result);
  } else if (progress.state === "completed" && progress.results) {
    handleCutCompleted(progress.results, progress.mergedResult ?? null);
  } else if (progress.state === "cancelled") {
    state.editorNotice = "剪辑已取消";
    state.editorProgress = null;
    editorUpdateFooter();
  } else {
    state.editorError = progress.error ?? "剪辑失败";
    state.editorProgress = null;
    editorUpdateFooter();
  }
});

void onVideoMergeProgress((progress) => {
  if (!state.mergeJobId || progress.jobId !== state.mergeJobId) return;
  state.mergeProgress = progress;
  if (progress.state === "running") {
    mergeUpdateFooter();
    return;
  }
  state.mergeJobId = null;
  if (progress.state === "completed" && progress.result) {
    handleMergeCompleted(progress.result);
  } else if (progress.state === "cancelled") {
    state.mergeProgress = null;
    state.mergeNotice = "合并已取消";
    state.mergeError = null;
    mergeUpdateFooter();
  } else {
    state.mergeProgress = null;
    state.mergeError = progress.error ?? "合并失败";
    mergeUpdateFooter();
  }
});

// Keep open dialogs inside the viewport when the window shrinks; stored sizes
// are never rewritten, so maximizing the window restores them again.
export let dialogSizeResizeFrame = 0;

window.addEventListener("resize", () => {
  if (dialogSizeResizeFrame) cancelAnimationFrame(dialogSizeResizeFrame);
  dialogSizeResizeFrame = requestAnimationFrame(() => {
    dialogSizeResizeFrame = 0;
    applyDialogSizes();
  });
  // 宽度变了 ⇒ 列数/列宽变了 ⇒ 行高与行盒作废，按新几何重排一帧。
  invalidateGridGeometry();
  scheduleGridPaint();
});
