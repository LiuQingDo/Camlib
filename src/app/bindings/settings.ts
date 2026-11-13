// 由 main.ts 拆分而来：仅做搬移，未改动逻辑。
import { AiRunMode } from "../../api/ai";
import { app } from "../../render/context";
import { persistUiPrefs, render } from "../../render/paint";
import { SettingsSection, state } from "../../state";
import { applyDialogSizes, mergeGroupMatches } from "../../views/dialogs";
import { commitDialogSizeInputs, updateSettingsPanel } from "../../views/settings";
import {
  cancelCurrentScan,
  cancelLibraryMergeJob,
  loadLibraryMergePreview,
  openBackupPanel,
  refreshMergeSelectionView,
  startLibraryMergeJob,
} from "../library";
import {
  cancelAiRun,
  cancelThumbnailRebuild,
  chooseThumbnailCacheFolder,
  closeSettings,
  loadSettingsSectionData,
  openDirectory,
  previewAiRun,
  purgeMissingEntries,
  runSettingsScan,
  runThumbnailRebuild,
  saveAiSettings,
  saveBackupDefaults,
  savePreviewModeSetting,
  saveSystemSettings,
  saveThemeSetting,
  saveThumbnailCacheDir,
  startAiRun,
  testAiConnectionFor,
} from "../settings-ops";

export function bindSettingsEvents(): void {
  const once = (element: HTMLElement | null, handler: (event: Event) => void): void => {
    if (!element || element.dataset.bound) return;
    element.dataset.bound = "1";
    element.addEventListener("click", handler);
  };
  // #settings-button / #settings-button-top 属于侧栏与骨架，由 bindSidebarEvents
  // 负责（侧栏页脚会被 patchSidebar 重建，不能只在这里绑一次）。
  once(app.querySelector<HTMLElement>("#settings-close"), () => closeSettings());
  const backdrop = app.querySelector<HTMLElement>("#settings-backdrop");
  if (backdrop && !backdrop.dataset.bound) {
    backdrop.dataset.bound = "1";
    backdrop.addEventListener("click", (event) => {
      if (event.target === event.currentTarget) closeSettings();
    });
  }
  app.querySelectorAll<HTMLButtonElement>("[data-settings-section]").forEach((button) => {
    if (button.dataset.bound) return;
    button.dataset.bound = "1";
    button.addEventListener("click", () => {
      const section = button.dataset.settingsSection as SettingsSection | undefined;
      if (!section || section === state.settingsSection) return;
      state.settingsSection = section;
      state.settingsError = null;
      state.settingsNotice = null;
      state.fullRebuildConfirm = false;
      state.purgeMissingConfirm = false;
      state.aiConfirming = false;
      state.settingsLoading = true;
      updateSettingsPanel();
      void loadSettingsSectionData().finally(() => {
        state.settingsLoading = false;
        updateSettingsPanel();
      });
    });
  });
  bindSettingsBodyEvents();
}

/** Rebind only controls inside the patchable settings content area. */
export function bindSettingsBodyEvents(): void {
  app.querySelectorAll<HTMLButtonElement>("[data-copy-path]").forEach((button) => {
    button.addEventListener("click", () => {
      const path = button.dataset.copyPath;
      if (!path) return;
      void navigator.clipboard
        .writeText(path)
        .then(() => {
          state.settingsNotice = "已复制完整路径";
          updateSettingsPanel();
        })
        .catch(() => {
          state.settingsError = "复制路径失败";
          updateSettingsPanel();
        });
    });
  });
  app.querySelectorAll<HTMLButtonElement>("[data-open-dir]").forEach((button) => {
    button.addEventListener(
      "click",
      () => void openDirectory(button.dataset.openDir as "app_data" | "app_cache" | "thumbnail_cache" | "library"),
    );
  });
  app.querySelector<HTMLButtonElement>("#settings-change-library")?.addEventListener("click", () => {
    closeSettings(false);
    state.libraryFormOpen = true;
    render();
  });
  app
    .querySelector<HTMLButtonElement>("#settings-rescan-library")
    ?.addEventListener("click", () => void runSettingsScan(false));
  app
    .querySelector<HTMLButtonElement>("#settings-incremental-scan")
    ?.addEventListener("click", () => void runSettingsScan(false));
  app.querySelector<HTMLButtonElement>("#settings-full-rebuild")?.addEventListener("click", () => {
    state.fullRebuildConfirm = true;
    state.settingsError = null;
    updateSettingsPanel();
  });
  app.querySelector<HTMLButtonElement>("#settings-full-rebuild-cancel")?.addEventListener("click", () => {
    state.fullRebuildConfirm = false;
    updateSettingsPanel();
  });
  app
    .querySelector<HTMLButtonElement>("#settings-full-rebuild-confirm")
    ?.addEventListener("click", () => void runSettingsScan(true));
  app
    .querySelector<HTMLButtonElement>("#settings-scan-cancel")
    ?.addEventListener("click", () => void cancelCurrentScan());
  app.querySelector<HTMLButtonElement>("#settings-purge-missing")?.addEventListener("click", () => {
    state.purgeMissingConfirm = true;
    state.settingsError = null;
    updateSettingsPanel();
  });
  app.querySelector<HTMLButtonElement>("#settings-purge-missing-cancel")?.addEventListener("click", () => {
    state.purgeMissingConfirm = false;
    updateSettingsPanel();
  });
  app
    .querySelector<HTMLButtonElement>("#settings-purge-missing-confirm")
    ?.addEventListener("click", () => void purgeMissingEntries());
  app
    .querySelector<HTMLButtonElement>("#library-merge-preview")
    ?.addEventListener("click", () => void loadLibraryMergePreview());
  app.querySelector<HTMLButtonElement>("#library-merge-start")?.addEventListener("click", () => {
    if (!state.libraryMergePreview || state.libraryMergeSelected.size === 0) return;
    state.libraryMergeConfirm = true;
    updateSettingsPanel();
  });
  app.querySelector<HTMLInputElement>("#library-merge-filter")?.addEventListener("input", (event) => {
    state.libraryMergeFilter = (event.target as HTMLInputElement).value;
    refreshMergeSelectionView();
  });
  app.querySelector<HTMLButtonElement>("#library-merge-select-visible")?.addEventListener("click", () => {
    if (!state.libraryMergePreview) return;
    const query = state.libraryMergeFilter.trim().toLowerCase();
    const next = new Set(state.libraryMergeSelected);
    for (const group of state.libraryMergePreview.groups) {
      if (mergeGroupMatches(group, query)) next.add(group.destinationRelative);
    }
    state.libraryMergeSelected = next;
    state.libraryMergeConfirm = false;
    refreshMergeSelectionView();
  });
  app.querySelector<HTMLButtonElement>("#library-merge-clear-visible")?.addEventListener("click", () => {
    if (!state.libraryMergePreview) return;
    const query = state.libraryMergeFilter.trim().toLowerCase();
    const next = new Set(state.libraryMergeSelected);
    for (const group of state.libraryMergePreview.groups) {
      if (mergeGroupMatches(group, query)) next.delete(group.destinationRelative);
    }
    state.libraryMergeSelected = next;
    state.libraryMergeConfirm = false;
    refreshMergeSelectionView();
  });
  app.querySelector<HTMLElement>("#library-merge-list")?.addEventListener("change", (event) => {
    const box = event.target;
    if (!(box instanceof HTMLInputElement) || !box.dataset.mergeDest) return;
    const next = new Set(state.libraryMergeSelected);
    if (box.checked) next.add(box.dataset.mergeDest);
    else next.delete(box.dataset.mergeDest);
    state.libraryMergeSelected = next;
    state.libraryMergeConfirm = false;
    refreshMergeSelectionView();
  });
  app.querySelector<HTMLButtonElement>("#library-merge-confirm-cancel")?.addEventListener("click", () => {
    state.libraryMergeConfirm = false;
    updateSettingsPanel();
  });
  app
    .querySelector<HTMLButtonElement>("#library-merge-confirm-start")
    ?.addEventListener("click", () => void startLibraryMergeJob());
  app
    .querySelector<HTMLButtonElement>("#library-merge-cancel")
    ?.addEventListener("click", () => void cancelLibraryMergeJob());
  app.querySelector<HTMLInputElement>("#library-merge-recycle")?.addEventListener("change", (event) => {
    state.libraryMergeRecycle = (event.target as HTMLInputElement).checked;
  });
  app
    .querySelector<HTMLButtonElement>("#settings-choose-thumbnail")
    ?.addEventListener("click", () => void chooseThumbnailCacheFolder());
  app.querySelector<HTMLFormElement>("#settings-thumbnail-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const input = app.querySelector<HTMLInputElement>("#settings-thumbnail-path");
    if (input?.value.trim()) void saveThumbnailCacheDir(input.value.trim());
  });
  app
    .querySelector<HTMLButtonElement>("#settings-rebuild-thumbnails")
    ?.addEventListener("click", () => void runThumbnailRebuild());
  app
    .querySelector<HTMLButtonElement>("#settings-thumbnail-cancel")
    ?.addEventListener("click", () => void cancelThumbnailRebuild());
  app
    .querySelector<HTMLButtonElement>("#settings-save-backup-defaults")
    ?.addEventListener("click", () => void saveBackupDefaults());
  app.querySelector<HTMLButtonElement>("#settings-save-ai")?.addEventListener("click", () => void saveAiSettings());
  app.querySelector<HTMLInputElement>("#settings-ai-enabled")?.addEventListener("change", (event) => {
    if (state.aiConfig) state.aiConfig.enabled = (event.target as HTMLInputElement).checked;
  });
  app
    .querySelector<HTMLButtonElement>("#settings-ai-test-chat")
    ?.addEventListener("click", () => void testAiConnectionFor("chat"));
  app
    .querySelector<HTMLButtonElement>("#settings-ai-test-embed")
    ?.addEventListener("click", () => void testAiConnectionFor("embedding"));
  app.querySelector<HTMLSelectElement>("#settings-ai-mode")?.addEventListener("change", (event) => {
    state.aiProcessMode = (event.target as HTMLSelectElement).value as AiRunMode;
    state.aiConfirming = false;
    state.aiPreview = null;
    updateSettingsPanel();
  });
  app.querySelector<HTMLButtonElement>("#settings-ai-preview")?.addEventListener("click", () => void previewAiRun());
  app.querySelector<HTMLButtonElement>("#settings-ai-start")?.addEventListener("click", () => {
    state.aiConfirming = true;
    state.settingsError = null;
    updateSettingsPanel();
  });
  app.querySelector<HTMLButtonElement>("#settings-ai-start-cancel")?.addEventListener("click", () => {
    state.aiConfirming = false;
    updateSettingsPanel();
  });
  app
    .querySelector<HTMLButtonElement>("#settings-ai-start-confirm")
    ?.addEventListener("click", () => void startAiRun());
  app.querySelector<HTMLButtonElement>("#settings-ai-cancel")?.addEventListener("click", () => void cancelAiRun());
  app
    .querySelector<HTMLButtonElement>("#settings-save-system")
    ?.addEventListener("click", () => void saveSystemSettings());
  app
    .querySelector<HTMLButtonElement>("#settings-save-preview-mode")
    ?.addEventListener("click", () => void savePreviewModeSetting());
  app
    .querySelector<HTMLSelectElement>("#settings-preview-mode")
    ?.addEventListener("change", () => void savePreviewModeSetting());
  app.querySelector<HTMLSelectElement>("#settings-theme")?.addEventListener("change", () => void saveThemeSetting());
  app.querySelector<HTMLButtonElement>("#settings-open-backup-panel")?.addEventListener("click", () => {
    closeSettings();
    void openBackupPanel();
  });
  app
    .querySelector<HTMLButtonElement>("#settings-open-app-data")
    ?.addEventListener("click", () => void openDirectory("app_data"));
  app
    .querySelector<HTMLButtonElement>("#settings-open-thumbnail-cache")
    ?.addEventListener("click", () => void openDirectory("thumbnail_cache"));
  // 弹窗大小：数值微调 + 恢复默认（单个 / 全部）。
  app.querySelectorAll<HTMLInputElement>("[data-dialog-size-width], [data-dialog-size-height]").forEach((input) => {
    input.addEventListener("change", () => {
      const id = input.dataset.dialogSizeWidth ?? input.dataset.dialogSizeHeight;
      if (id) commitDialogSizeInputs(id);
    });
  });
  app.querySelectorAll<HTMLButtonElement>("[data-dialog-size-reset]").forEach((button) => {
    button.addEventListener("click", () => {
      const id = button.dataset.dialogSizeReset;
      if (!id) return;
      delete state.dialogSizes[id];
      applyDialogSizes();
      void persistUiPrefs({ uiDialogSizes: state.dialogSizes });
      updateSettingsPanel();
    });
  });
  app.querySelector<HTMLButtonElement>("#settings-reset-dialog-sizes")?.addEventListener("click", () => {
    state.dialogSizes = {};
    applyDialogSizes();
    void persistUiPrefs({ uiDialogSizes: state.dialogSizes });
    updateSettingsPanel();
  });
}
