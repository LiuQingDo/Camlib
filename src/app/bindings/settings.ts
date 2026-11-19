// 由 main.ts 拆分而来：仅做搬移，未改动逻辑。
import { openUrl } from "@tauri-apps/plugin-opener";
import { AiRunMode } from "../../api/ai";
import { filterProviderPresets, findProfile, pickerPresets } from "../../lib/ai-providers";
import { app } from "../../render/context";
import { persistUiPrefs, render } from "../../render/paint";
import { SettingsSection, state } from "../../state";
import { applyDialogSizes, mergeGroupMatches } from "../../views/dialogs";
import {
  aiModelCountHint,
  commitDialogSizeInputs,
  renderAiModelList,
  renderAiProviderCards,
  updateSettingsPanel,
} from "../../views/settings";
import {
  cancelCurrentScan,
  cancelLibraryMergeJob,
  loadLibraryMergePreview,
  openBackupPanel,
  refreshMergeSelectionView,
  startLibraryMergeJob,
} from "../library";
import {
  addAiProvider,
  backToAiProviderList,
  cancelAiEditing,
  cancelAiRun,
  cancelThumbnailRebuild,
  chooseThumbnailCacheFolder,
  closeSettings,
  editAiProvider,
  fetchAiModels,
  loadSettingsSectionData,
  openAiProviderPicker,
  openDirectory,
  previewAiRun,
  purgeMissingEntries,
  removeAiProvider,
  runSettingsScan,
  runThumbnailRebuild,
  saveAiFromPanel,
  saveBackupDefaults,
  savePreviewModeSetting,
  saveSystemSettings,
  saveThemeSetting,
  saveThumbnailCacheDir,
  selectAiModel,
  selectAiRegion,
  setActiveAiProvider,
  setAiModelQuery,
  setAiPickerQuery,
  startAiRun,
  syncAiDraftFromDom,
  testAiConnectionNow,
  toggleAiKeyVisibility,
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
  app.querySelector<HTMLButtonElement>("#settings-save-ai")?.addEventListener("click", () => void saveAiFromPanel());
  app.querySelector<HTMLInputElement>("#settings-ai-enabled")?.addEventListener("change", (event) => {
    if (state.aiDraft) state.aiDraft.enabled = (event.target as HTMLInputElement).checked;
  });
  // 供应商面板：已添加列表 → 添加（厂商网格 + 搜索）→ 单个供应商配置。
  app.querySelector<HTMLButtonElement>("#settings-ai-add")?.addEventListener("click", () => openAiProviderPicker());
  app.querySelectorAll<HTMLButtonElement>("[data-ai-back]").forEach((button) => {
    button.addEventListener("click", () => backToAiProviderList());
  });
  // 配置页的「取消」：新建到一半撤销时顺手丢掉那条空档案。
  app.querySelectorAll<HTMLButtonElement>("[data-ai-cancel]").forEach((button) => {
    button.addEventListener("click", () => cancelAiEditing());
  });
  bindAiProviderCards();
  app.querySelectorAll<HTMLButtonElement>("[data-ai-edit]").forEach((button) => {
    button.addEventListener("click", () => {
      const id = button.dataset.aiEdit;
      if (id) editAiProvider(id);
    });
  });
  app.querySelectorAll<HTMLButtonElement>("[data-ai-activate]").forEach((button) => {
    button.addEventListener("click", () => {
      const id = button.dataset.aiActivate;
      if (id) setActiveAiProvider(id);
    });
  });
  app.querySelectorAll<HTMLButtonElement>("[data-ai-remove]").forEach((button) => {
    button.addEventListener("click", () => {
      const id = button.dataset.aiRemove;
      if (id) removeAiProvider(id);
    });
  });
  // 搜索只重绘卡片网格，不整块刷新——否则输入框会在每次按键后丢焦点。
  app.querySelector<HTMLInputElement>("#settings-ai-search")?.addEventListener("input", (event) => {
    setAiPickerQuery((event.target as HTMLInputElement).value);
    refreshAiPickerGrid();
  });
  // 「获取 Key」打开厂商控制台；失败不打断填写。
  app.querySelectorAll<HTMLButtonElement>("[data-ai-open-url]").forEach((button) => {
    button.addEventListener("click", () => {
      const url = button.dataset.aiOpenUrl;
      if (!url) return;
      void openUrl(url).catch(() => {
        state.settingsError = "无法打开浏览器，请手动访问厂商控制台";
        updateSettingsPanel();
      });
    });
  });
  // 模型：按当前地址与密钥向上游拉清单；清单里的每一项点一下即选中。
  app
    .querySelector<HTMLButtonElement>("#settings-ai-fetch-models")
    ?.addEventListener("click", () => void fetchAiModels());
  bindAiModelChoices();
  // 过滤清单时只换列表与计数：整块替换会把正在输入的这个框也换掉，焦点与光标一起丢。
  app.querySelector<HTMLInputElement>("#settings-ai-model-filter")?.addEventListener("input", (event) => {
    setAiModelQuery((event.target as HTMLInputElement).value);
    const draft = state.aiDraft;
    const profile = draft ? findProfile(draft.profiles, state.aiEditingId) : null;
    if (!profile) return;
    const list = app.querySelector<HTMLElement>("#ai-model-list");
    if (list) list.innerHTML = renderAiModelList(profile);
    const count = app.querySelector<HTMLElement>("#ai-model-count");
    if (count) count.textContent = aiModelCountHint();
    bindAiModelChoices();
  });
  // 区域页签：切换厂商在不同区域的端点地址。
  app.querySelectorAll<HTMLButtonElement>("[data-ai-region]").forEach((button) => {
    button.addEventListener("click", () => {
      const regionId = button.dataset.aiRegion;
      if (regionId) selectAiRegion(regionId);
    });
  });
  app
    .querySelector<HTMLButtonElement>("#settings-ai-key-toggle")
    ?.addEventListener("click", () => toggleAiKeyVisibility());
  // 未失焦的输入先同步进草稿，避免切换服务商/重新渲染时丢字。
  app
    .querySelectorAll<HTMLInputElement>(
      "#settings-ai-chat-key, #settings-ai-model, #settings-ai-chat-url, #settings-ai-profile-name",
    )
    .forEach((input) => input.addEventListener("input", () => syncAiDraftFromDom()));
  app
    .querySelector<HTMLSelectElement>("#settings-ai-concurrency")
    ?.addEventListener("change", () => syncAiDraftFromDom());
  app
    .querySelector<HTMLButtonElement>("#settings-ai-test")
    ?.addEventListener("click", () => void testAiConnectionNow());
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

/** 已取回清单里的模型项：点一下写入草稿（清单重绘后需要重新绑定）。 */
function bindAiModelChoices(): void {
  app.querySelectorAll<HTMLButtonElement>("[data-ai-model]").forEach((button) => {
    button.addEventListener("click", () => {
      const modelId = button.dataset.aiModel;
      if (modelId) selectAiModel(modelId);
    });
  });
}

/** 添加面板的厂商卡片：点一下 = 新建一条该厂商的配置并进入配置页。 */
function bindAiProviderCards(): void {
  app.querySelectorAll<HTMLButtonElement>("[data-ai-add]").forEach((button) => {
    button.addEventListener("click", () => {
      const providerId = button.dataset.aiAdd;
      if (providerId) addAiProvider(providerId);
    });
  });
}

/**
 * 只重绘卡片网格。搜索时若整块 updateSettingsPanel，输入框会被替换掉，
 * 每按一个键就丢一次焦点，所以这里单独 patch 容器并重新绑定卡片。
 */
function refreshAiPickerGrid(): void {
  const grid = app.querySelector<HTMLElement>("#ai-picker-grid");
  if (!grid) return;
  const presets = filterProviderPresets(pickerPresets(), state.aiPickerQuery);
  grid.innerHTML = renderAiProviderCards(presets);
  bindAiProviderCards();
}
