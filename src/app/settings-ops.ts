// 由 main.ts 拆分而来：仅做搬移，未改动逻辑。
import {
  AiConfigDto,
  AiProfileDto,
  cancelAiProcess,
  getAiConfig,
  getAiStats,
  listAiModels,
  previewAiProcess,
  setAiConfig,
  startAiProcess,
  testAiConnection,
} from "../api/ai";
import { toDetailedMessage, toUserMessage } from "../api/errors";
import {
  CloseBehavior,
  UiPreviewMode,
  UiTheme,
  getAppAbout,
  getInfrastructureState,
  getLibraryIndexSummary,
  getThumbnailCacheStats,
  listScanRuns,
  openAppDirectory,
  setBackupConflictPolicy,
  setBackupIgnoreExtensions,
  setBackupMergeSegments,
  setCloseBehavior,
  setNotificationsEnabled,
  setThumbnailCacheDir,
  setUiPrefs,
} from "../api/infrastructure";
import {
  ConflictPolicy,
  ScanProgressDto,
  cancelPreviewJob,
  listBackupHistory,
  purgeMissingItems,
  startLibraryScan,
  startThumbnailRebuild,
} from "../api/media";
import {
  findProfile,
  findProvider,
  newProfileId,
  pickActiveProfile,
  profileLabel,
  profileTitle,
  providerApiKey,
  providerRegions,
} from "../lib/ai-providers";
import { extensionsToInput, parseExtensionsInput } from "../lib/filters";
import { formatCount } from "../lib/format";
import { syncLiquidGlass } from "../liquid-glass";
import { app } from "../render/context";
import { persistUiPrefs, refreshMedia, render, renderSettingsAware } from "../render/paint";
import { Density, SettingsSection, SortMode, state } from "../state";
import { sanitizeDialogSizes } from "../views/dialogs";
import { updateSettingsPanel } from "../views/settings";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";

/** 设置弹窗：壳建一次，内容由 updateSettingsPanel 单独 patch。 */
export async function openSettings(section?: SettingsSection): Promise<void> {
  if (section) state.settingsSection = section;
  if (state.settingsOpen) return;
  state.settingsOpen = true;
  state.settingsLoading = true;
  state.settingsError = null;
  state.settingsNotice = null;
  state.fullRebuildConfirm = false;
  state.purgeMissingConfirm = false;
  render();
  try {
    await loadSettingsSectionData();
  } finally {
    state.settingsLoading = false;
    updateSettingsPanel();
  }
}

export function closeSettings(rerender = true): void {
  state.settingsOpen = false;
  state.fullRebuildConfirm = false;
  state.purgeMissingConfirm = false;
  state.settingsError = null;
  state.settingsNotice = null;
  if (rerender) render();
}

export async function loadSettingsSectionData(): Promise<void> {
  try {
    if (state.settingsSection === "library" || state.settingsSection === "index") {
      if (state.library) {
        const [summary, runs] = await Promise.all([
          getLibraryIndexSummary(state.library.id),
          listScanRuns(state.library.id, 8),
        ]);
        state.indexSummary = summary;
        state.scanRuns = runs;
      } else {
        state.indexSummary = null;
        state.scanRuns = [];
      }
    }
    if (state.settingsSection === "thumbnails") {
      state.thumbnailCacheDir = state.thumbnailCacheDir || "";
      const stats = await getThumbnailCacheStats();
      state.thumbnailStats = stats;
      state.thumbnailCacheDir = stats.path;
    }
    if (state.settingsSection === "about") {
      state.aboutInfo = await getAppAbout();
    }
    if (state.settingsSection === "backup") {
      // Values already live in state from bootstrap; refresh if settings panel is the source of truth.
      const infra = await getInfrastructureState();
      state.backupConflictPolicy = infra.settings.backup_conflict_policy;
      state.backupIgnoreExtensions = extensionsToInput(infra.settings.backup_ignore_extensions);
      state.backupMergeSegments = infra.settings.backup_merge_segments;
      state.autoScanOnStartup = infra.settings.auto_scan_on_startup;
      state.thumbnailCacheDir = infra.settings.thumbnail_cache_dir;
      state.notificationsEnabled = infra.settings.notifications_enabled;
      state.closeBehavior = infra.settings.close_behavior;
    }
    if (state.settingsSection === "ai") {
      const config = await getAiConfig();
      state.aiConfig = config;
      state.aiDraft = initialAiDraft(config);
      state.aiKeyVisible = false;
      state.aiConfirming = false;
      state.aiTestResult = null;
      // 每次进入都从供应商列表开始：编辑态只属于上一次会话。
      state.aiView = "list";
      state.aiEditingId = "";
      state.aiCreating = false;
      state.aiPickerQuery = "";
      if (state.library) {
        state.aiStats = await getAiStats(state.library.id);
      } else {
        state.aiStats = null;
      }
    }
    if (state.settingsSection === "system") {
      const [infra, backups] = await Promise.all([getInfrastructureState(), listBackupHistory(8)]);
      state.notificationsEnabled = infra.settings.notifications_enabled;
      state.closeBehavior = infra.settings.close_behavior;
      state.previewMode = clampPreviewMode(infra.settings.ui_preview_mode);
      state.theme = clampTheme(infra.settings.ui_theme);
      state.dialogSizes = sanitizeDialogSizes(infra.settings.ui_dialog_sizes);
      applyTheme(state.theme);
      state.backupHistory = backups;
      if (state.library) {
        state.scanRuns = await listScanRuns(state.library.id, 8);
      }
    }
  } catch (error) {
    state.settingsError = toUserMessage(error, "加载设置失败");
  }
}

export async function openDirectory(which: "app_data" | "app_cache" | "thumbnail_cache" | "library"): Promise<void> {
  try {
    await openAppDirectory(which);
    state.settingsError = null;
  } catch (error) {
    state.settingsError = toUserMessage(error, "打开目录失败");
    updateSettingsPanel();
  }
}

export async function runSettingsScan(full: boolean): Promise<void> {
  if (!state.library || state.scanning) return;
  if (state.availability !== "available") {
    state.settingsError = state.libraryStatusReason || "媒体库不可用，请先连接磁盘";
    updateSettingsPanel();
    return;
  }
  state.fullRebuildConfirm = false;
  state.settingsError = null;
  state.settingsNotice = full ? "正在全量重建索引…" : "正在增量扫描…";
  updateSettingsPanel();
  try {
    const start = await startLibraryScan(state.library.id, full);
    if (!state.scanning) return;
    const reported = state.scanProgress as ScanProgressDto | null;
    if (reported && reported.jobId === start.jobId) return;
    state.scanProgress = {
      jobId: start.jobId,
      kind: "scan",
      seq: 0,
      phase: "discovering",
      state: "running",
      current: null,
      processed: 0,
      total: 0,
      errors: [],
      error: null,
    };
    updateSettingsPanel();
  } catch (error) {
    state.settingsError = toUserMessage(error, "无法开始扫描");
    state.settingsNotice = null;
    updateSettingsPanel();
  }
}

export async function purgeMissingEntries(): Promise<void> {
  if (!state.library) return;
  state.purgeMissingConfirm = false;
  state.settingsError = null;
  updateSettingsPanel();
  try {
    const removed = await purgeMissingItems(state.library.id);
    state.settingsNotice = removed > 0 ? `已清理 ${formatCount(removed)} 个离线条目` : "没有可清理的离线条目";
    await loadSettingsSectionData();
    updateSettingsPanel();
    void refreshMedia();
  } catch (error) {
    state.settingsError = toUserMessage(error, "清理离线条目失败");
    updateSettingsPanel();
  }
}

export async function chooseThumbnailCacheFolder(): Promise<void> {
  try {
    const selected = await openFileDialog({
      directory: true,
      multiple: false,
      title: "选择缩略图缓存文件夹",
    });
    if (typeof selected === "string" && selected.trim()) {
      state.thumbnailCacheDir = selected.trim();
      updateSettingsPanel();
    }
  } catch (error) {
    state.settingsError = toUserMessage(error, "打开文件夹选择器失败");
    updateSettingsPanel();
  }
}

export async function saveThumbnailCacheDir(path: string): Promise<void> {
  state.settingsBusy = true;
  state.settingsError = null;
  try {
    const settings = await setThumbnailCacheDir(path);
    state.thumbnailCacheDir = settings.thumbnail_cache_dir;
    const stats = await getThumbnailCacheStats();
    state.thumbnailStats = stats;
    state.settingsNotice = "缩略图目录已更新";
  } catch (error) {
    state.settingsError = toUserMessage(error, "保存缩略图目录失败");
  } finally {
    state.settingsBusy = false;
    renderSettingsAware();
  }
}

export async function runThumbnailRebuild(): Promise<void> {
  if (!state.library || state.thumbnailRebuilding) return;
  state.settingsError = null;
  state.settingsNotice = "正在重建缩略图…";
  state.thumbnailRebuilding = true;
  state.thumbnailProgress = null;
  renderSettingsAware();
  try {
    const start = await startThumbnailRebuild(state.library.id);
    state.thumbnailJobId = start.jobId;
  } catch (error) {
    state.thumbnailRebuilding = false;
    state.settingsError = toUserMessage(error, "无法开始重建缩略图");
    state.settingsNotice = null;
    renderSettingsAware();
  }
}

export async function cancelThumbnailRebuild(): Promise<void> {
  if (!state.thumbnailJobId) return;
  try {
    await cancelPreviewJob(state.thumbnailJobId);
  } catch (error) {
    state.settingsError = toUserMessage(error, "无法取消缩略图重建");
    renderSettingsAware();
  }
}

export async function saveBackupDefaults(): Promise<void> {
  const ignoreInput = app.querySelector<HTMLInputElement>("#settings-ignore-extensions");
  const policySelect = app.querySelector<HTMLSelectElement>("#settings-conflict-policy");
  const mergeSelect = app.querySelector<HTMLSelectElement>("#settings-merge-segments");
  const extensions = parseExtensionsInput(ignoreInput?.value ?? state.backupIgnoreExtensions);
  const policy = (policySelect?.value as ConflictPolicy | undefined) ?? state.backupConflictPolicy;
  const mergeEnabled = mergeSelect ? mergeSelect.value === "on" : state.backupMergeSegments;
  state.settingsBusy = true;
  state.settingsError = null;
  try {
    await setBackupIgnoreExtensions(extensions);
    await setBackupMergeSegments(mergeEnabled);
    const settings = await setBackupConflictPolicy(policy);
    state.backupConflictPolicy = settings.backup_conflict_policy;
    state.backupIgnoreExtensions = extensionsToInput(settings.backup_ignore_extensions);
    state.backupMergeSegments = settings.backup_merge_segments;
    state.settingsNotice = "备份默认项已保存";
  } catch (error) {
    state.settingsError = toUserMessage(error, "保存备份默认项失败");
  } finally {
    state.settingsBusy = false;
    renderSettingsAware();
  }
}

// ── AI 增强（设置页） ───────────────────────────────────────────────────────

/** 深拷贝草稿：档案是可变对象，浅拷贝会让草稿与已保存配置互相污染。 */
function cloneAiConfig(config: AiConfigDto): AiConfigDto {
  return {
    enabled: config.enabled,
    concurrency: config.concurrency,
    activeProfileId: config.activeProfileId,
    profiles: config.profiles.map((profile) => ({
      ...profile,
      models: [...(profile.models ?? [])],
      visionModel: profile.visionModel ?? "",
      chatModel: profile.chatModel ?? "",
    })),
  };
}

/** 按服务商预设新建一条空白档案：只带出地址，模型等用户点「获取模型」再挑。 */
function blankProfile(providerId: string): AiProfileDto {
  const preset = findProvider(providerId);
  return {
    id: newProfileId(),
    name: "",
    provider: preset.id,
    baseUrl: preset.baseUrl,
    models: [],
    visionModel: "",
    chatModel: "",
    apiKey: "",
  };
}

/** 草稿的展示用名字（保存提示、删除提示里用）。 */
function draftProfileLabel(config: AiConfigDto): string {
  const profile = pickActiveProfile(config);
  return profile ? profileLabel(profile) : "未命名配置";
}

/**
 * 首次配置时只做拷贝与 active 校正，**不再凭空造一条空白档案**：供应商由用户
 * 自己从「添加供应商」里选，空列表就显示空态，避免出现一条谁也没填过的配置。
 */
function initialAiDraft(config: AiConfigDto): AiConfigDto {
  const draft = cloneAiConfig(config);
  if (draft.profiles.length === 0) {
    draft.activeProfileId = "";
    draft.enabled = false;
    return draft;
  }
  if (!draft.profiles.some((profile) => profile.id === draft.activeProfileId)) {
    draft.activeProfileId = draft.profiles[0]?.id ?? "";
  }
  return draft;
}

/** 切换档案或重新加载后清掉上一次的测试结果，避免状态错位。 */
function resetAiTestState(): void {
  state.aiTestResult = null;
}

/**
 * 清掉已取回的模型清单。清单属于「这个地址 + 这把 Key」，换档案、换区域、
 * 保存之后就都不再对应得上，留着只会让人误点一个上游不存在的名字。
 */
function resetAiModelState(): void {
  state.aiModels = null;
  state.aiModelsBusy = false;
  state.aiModelsError = null;
  state.aiModelQuery = "";
}

/** 编辑页指向的档案：aiEditingId 优先，失效时退回「使用中」的那条。 */
function editingProfile(draft: AiConfigDto): AiProfileDto | null {
  return findProfile(draft.profiles, state.aiEditingId) ?? pickActiveProfile(draft);
}

/**
 * 把 DOM 上可能尚未提交的输入同步回草稿。返回列表、切页、保存、测试连接前都
 * 要先调一次，否则刚敲完还没失焦的 Key / 手填模型名会丢。
 *
 * 写入目标是「编辑中的那条档案」，因此每条档案的 Key 天然隔离。
 */
export function syncAiDraftFromDom(): void {
  const draft = state.aiDraft;
  if (!draft) return;
  const value = (selector: string): string | null =>
    app.querySelector<HTMLInputElement | HTMLSelectElement>(selector)?.value ?? null;
  const profile = editingProfile(draft);
  if (profile) {
    const key = value("#settings-ai-chat-key");
    if (key !== null) profile.apiKey = key.trim();
    const url = value("#settings-ai-chat-url");
    if (url !== null) profile.baseUrl = url.trim();
    const visionModel = value("#settings-ai-vision-model");
    if (visionModel !== null) profile.visionModel = visionModel.trim();
    const chatModel = value("#settings-ai-chat-model");
    if (chatModel !== null) profile.chatModel = chatModel.trim();
    const name = value("#settings-ai-profile-name");
    if (name !== null) profile.name = name.trim();
  }
  const concurrency = Number.parseInt(value("#settings-ai-concurrency") ?? "", 10);
  if (Number.isFinite(concurrency)) draft.concurrency = concurrency;
  const enabled = app.querySelector<HTMLInputElement>("#settings-ai-enabled");
  if (enabled) draft.enabled = enabled.checked;
}

// ── 供应商面板：列表 / 添加 / 配置 三段式 ────────────────────────────────────

/** 进入添加面板（厂商网格，只列模型厂商的 API）。 */
export function openAiProviderPicker(): void {
  syncAiDraftFromDom();
  state.aiView = "picker";
  state.aiPickerQuery = "";
  state.aiCreating = false;
  state.aiTestResult = null;
  resetAiModelState();
  updateSettingsPanel();
}

/** 搜索词只影响卡片网格，由 refreshAiPickerGrid 局部重绘，输入框不丢焦点。 */
export function setAiPickerQuery(query: string): void {
  state.aiPickerQuery = query;
}

/** 返回供应商列表（放弃未保存的编辑）。 */
export function backToAiProviderList(): void {
  syncAiDraftFromDom();
  state.aiView = "list";
  state.aiEditingId = "";
  state.aiCreating = false;
  state.aiPickerQuery = "";
  state.aiTestResult = null;
  resetAiModelState();
  updateSettingsPanel();
}

/**
 * 配置页的「取消」/「← 返回」：放弃这次编辑。
 *
 * 刚新建的档案要顺手删掉——取消之后列表里多出一条空配置，用户还得再删一次。
 * 编辑已有档案时只回列表，草稿里的改动留给「保存配置」决定。
 */
export function cancelAiEditing(): void {
  syncAiDraftFromDom();
  const draft = state.aiDraft;
  const editingId = state.aiEditingId;
  if (draft && state.aiCreating && editingId) {
    draft.profiles = draft.profiles.filter((profile) => profile.id !== editingId);
    if (draft.activeProfileId === editingId) draft.activeProfileId = draft.profiles[0]?.id ?? "";
    if (draft.profiles.length === 0) draft.enabled = false;
  }
  backToAiProviderList();
}

/**
 * 从添加面板选中一张厂商卡片：新建一条档案并直接进入配置页。
 * 同一厂商已有存档时带出它的 Key，少粘一次；每条仍各存各的。
 */
export function addAiProvider(providerId: string): void {
  syncAiDraftFromDom();
  const draft = state.aiDraft;
  if (!draft) return;
  const preset = findProvider(providerId);
  const profile = blankProfile(preset.id);
  profile.apiKey = providerApiKey(draft.profiles, preset.id);
  draft.profiles.push(profile);
  // 第一条配置自动成为使用中的那条，「加完就能用」符合预期。
  if (draft.profiles.length === 1) draft.activeProfileId = profile.id;
  state.aiEditingId = profile.id;
  state.aiView = "edit";
  state.aiCreating = true;
  state.aiTestResult = null;
  resetAiModelState();
  state.settingsNotice = null;
  updateSettingsPanel();
}

/** 从列表进入某条供应商的配置页。 */
export function editAiProvider(profileId: string): void {
  syncAiDraftFromDom();
  const draft = state.aiDraft;
  if (!draft || !findProfile(draft.profiles, profileId)) return;
  state.aiEditingId = profileId;
  state.aiView = "edit";
  state.aiCreating = false;
  state.aiTestResult = null;
  resetAiModelState();
  updateSettingsPanel();
}

/** 把某条档案设为使用中（打标与对话都用它）。 */
export function setActiveAiProvider(profileId: string): void {
  syncAiDraftFromDom();
  const draft = state.aiDraft;
  if (!draft) return;
  const profile = findProfile(draft.profiles, profileId);
  if (!profile) return;
  draft.activeProfileId = profile.id;
  resetAiTestState();
  state.settingsNotice = `已把「${profileLabel(profile)}」设为使用中，保存后生效`;
  updateSettingsPanel();
}

/** 删除某条供应商（草稿内生效，保存后落库）。 */
export function removeAiProvider(profileId: string): void {
  syncAiDraftFromDom();
  const draft = state.aiDraft;
  if (!draft) return;
  const target = findProfile(draft.profiles, profileId);
  if (!target) return;
  const label = profileTitle(target);
  draft.profiles = draft.profiles.filter((profile) => profile.id !== profileId);
  if (draft.activeProfileId === profileId) draft.activeProfileId = draft.profiles[0]?.id ?? "";
  if (draft.profiles.length === 0) draft.enabled = false;
  if (state.aiEditingId === profileId) {
    state.aiEditingId = "";
    state.aiView = "list";
    state.aiCreating = false;
  }
  state.settingsNotice =
    draft.profiles.length === 0 ? `已删除「${label}」，AI 增强已关闭，保存后生效` : `已删除「${label}」，保存后生效`;
  resetAiTestState();
  updateSettingsPanel();
}

/** 把角色模型补进已勾选清单：手填的 ID 也要在清单里打上勾。 */
function ensureRoleModelsSelected(profile: AiProfileDto): void {
  for (const model of [profile.visionModel.trim(), profile.chatModel.trim()]) {
    if (model && !profile.models.includes(model)) profile.models.push(model);
  }
}

/**
 * 勾选 / 取消勾选上游清单里的一个模型。
 *
 * 取消勾选一个正在承担角色的模型时，把对应角色一起清掉——否则会保存出
 * 「角色指向未选模型」的悬空状态。
 */
export function toggleAiModelSelection(modelId: string): void {
  syncAiDraftFromDom();
  const draft = state.aiDraft;
  if (!draft) return;
  const profile = editingProfile(draft);
  if (!profile) return;
  const id = modelId.trim();
  if (!id) return;
  if (profile.models.includes(id)) {
    profile.models = profile.models.filter((model) => model !== id);
    if (profile.visionModel === id) profile.visionModel = "";
    if (profile.chatModel === id) profile.chatModel = "";
  } else {
    profile.models = [...profile.models, id];
  }
  resetAiTestState();
  updateSettingsPanel({ preserveScroll: true });
}

/** 把一个模型指定为识图或对话角色；顺手确保它在已勾选清单里。 */
export function assignAiModelRole(modelId: string, role: "vision" | "chat"): void {
  syncAiDraftFromDom();
  const draft = state.aiDraft;
  if (!draft) return;
  const profile = editingProfile(draft);
  if (!profile) return;
  const id = modelId.trim();
  if (!id) return;
  if (!profile.models.includes(id)) profile.models = [...profile.models, id];
  if (role === "vision") profile.visionModel = id;
  else profile.chatModel = id;
  resetAiTestState();
  updateSettingsPanel({ preserveScroll: true });
}

/**
 * 「获取模型」：拿表单里此刻的地址与 Key 问上游要清单。
 *
 * 先同步 DOM——用户常常刚粘完 Key 还没失焦就点这个按钮。失败不弹窗：模型本来
 * 就能手填，把厂商原话留在这一栏里比打断流程更合适。
 */
export async function fetchAiModels(): Promise<void> {
  syncAiDraftFromDom();
  const draft = state.aiDraft;
  const profile = draft ? editingProfile(draft) : null;
  if (!profile) return;
  const baseUrl = profile.baseUrl.trim();
  if (!baseUrl) {
    state.aiModelsError = "先填接口地址，再获取模型";
    updateSettingsPanel({ preserveScroll: true });
    return;
  }
  state.aiModelsBusy = true;
  state.aiModelsError = null;
  state.aiModelQuery = "";
  updateSettingsPanel({ preserveScroll: true });
  try {
    const models = await listAiModels(baseUrl, profile.apiKey);
    state.aiModels = models;
    // 只有一条时直接补到两个角色上；已选角色若不在清单里，保留手填值不动。
    if (models.length === 1 && models[0]) {
      if (!profile.visionModel.trim()) profile.visionModel = models[0];
      if (!profile.chatModel.trim()) profile.chatModel = models[0];
    }
    ensureRoleModelsSelected(profile);
    resetAiTestState();
  } catch (error) {
    state.aiModels = null;
    state.aiModelsError = toDetailedMessage(error, "获取模型清单失败");
  } finally {
    state.aiModelsBusy = false;
    updateSettingsPanel();
  }
}

/** 清单过滤词：可能上百条，只重绘列表本身，输入框不丢焦点。 */
export function setAiModelQuery(query: string): void {
  state.aiModelQuery = query;
}

/**
 * 切换接入区域：厂商在不同区域的端点不同，切换即改写这条档案的接口地址。
 * 手改过的地址会被覆盖——区域是显式动作，按用户点的来。
 */
export function selectAiRegion(regionId: string): void {
  syncAiDraftFromDom();
  const draft = state.aiDraft;
  if (!draft) return;
  const profile = editingProfile(draft);
  if (!profile) return;
  const preset = findProvider(profile.provider);
  const region = providerRegions(preset).find((item) => item.id === regionId);
  if (!region) return;
  profile.baseUrl = region.baseUrl;
  resetAiTestState();
  resetAiModelState();
  updateSettingsPanel();
}

/** API Key 明文/密文切换（只影响显示，不改草稿值）。 */
export function toggleAiKeyVisibility(): void {
  syncAiDraftFromDom();
  state.aiKeyVisible = !state.aiKeyVisible;
  updateSettingsPanel();
}

export async function saveAiSettings(): Promise<void> {
  syncAiDraftFromDom();
  const draft = state.aiDraft;
  if (!draft) return;
  if (draft.profiles.length === 0) {
    state.settingsError = "请先添加一个供应商再保存";
    updateSettingsPanel();
    return;
  }
  // 两个角色都必填：空着保存等于存了一条跑不起来的配置，当场拦住并说清楚怎么补。
  draft.profiles.forEach(ensureRoleModelsSelected);
  const missingRoles = draft.profiles.find((profile) => !profile.visionModel.trim() || !profile.chatModel.trim());
  if (missingRoles) {
    const missing: string[] = [];
    if (!missingRoles.visionModel.trim()) missing.push("识图模型");
    if (!missingRoles.chatModel.trim()) missing.push("对话模型");
    state.settingsError = `「${profileTitle(missingRoles)}」还没指定${missing.join("和")}：在模型清单里点「识图 / 对话」，或直接填模型 ID`;
    updateSettingsPanel();
    return;
  }
  state.settingsBusy = true;
  state.settingsError = null;
  try {
    state.aiConfig = await setAiConfig(draft);
    state.aiDraft = initialAiDraft(state.aiConfig);
    if (!findProfile(state.aiDraft.profiles, state.aiEditingId)) state.aiView = "list";
    state.settingsNotice = state.aiConfig.enabled
      ? `已保存并启用「${draftProfileLabel(state.aiConfig)}」`
      : "AI 配置已保存（功能保持关闭）";
    if (state.library) state.aiStats = await getAiStats(state.library.id);
  } catch (error) {
    state.settingsError = toDetailedMessage(error, "保存 AI 配置失败");
  } finally {
    state.settingsBusy = false;
    renderSettingsAware();
  }
}

/**
 * 面板上的「保存配置」：保存成功后，若还在编辑页就退回列表——配完一条就该看到
 * 它在列表里的样子，而不是留在表单里猜有没有存上。失败时留在原页显示错误。
 */
export async function saveAiFromPanel(): Promise<void> {
  await saveAiSettings();
  if (state.settingsError || state.aiView !== "edit") return;
  state.aiView = "list";
  state.aiEditingId = "";
  state.aiCreating = false;
  resetAiModelState();
  renderSettingsAware();
}

export async function testAiConnectionNow(): Promise<void> {
  syncAiDraftFromDom();
  const draft = state.aiDraft;
  if (!draft) return;
  if (draft.profiles.length === 0) {
    state.settingsError = "请先添加一个供应商再测试";
    updateSettingsPanel();
    return;
  }
  state.aiTestBusy = true;
  state.aiTestResult = null;
  state.settingsError = null;
  renderSettingsAware();
  try {
    // 测试命令只读已保存的配置，所以先把草稿落库，避免「测的是 A、存的是 B」。
    state.aiConfig = await setAiConfig(draft);
    state.aiDraft = initialAiDraft(state.aiConfig);
    // 已经落库了，这条档案不再算「新建中」：此时点取消不该把它从草稿里抹掉。
    state.aiCreating = false;
    state.aiTestResult = await testAiConnection();
  } catch (error) {
    state.aiTestResult = {
      ok: false,
      message: toDetailedMessage(error, "连接失败"),
      latencyMs: 0,
    };
  } finally {
    state.aiTestBusy = false;
    renderSettingsAware();
  }
}

export async function previewAiRun(): Promise<void> {
  if (!state.library) return;
  state.aiPreviewLoading = true;
  state.settingsError = null;
  state.aiConfirming = false;
  renderSettingsAware();
  try {
    state.aiPreview = await previewAiProcess(state.library.id, state.aiProcessMode);
  } catch (error) {
    state.aiPreview = null;
    state.settingsError = toDetailedMessage(error, "生成处理预览失败");
  } finally {
    state.aiPreviewLoading = false;
    renderSettingsAware();
  }
}

export async function startAiRun(): Promise<void> {
  if (!state.library) return;
  state.aiConfirming = false;
  state.settingsError = null;
  try {
    const start = await startAiProcess(state.library.id, state.aiProcessMode);
    state.aiJobId = start.jobId;
    state.aiProgress = null;
  } catch (error) {
    state.settingsError = toDetailedMessage(error, "无法开始 AI 处理");
  }
  renderSettingsAware();
}

export async function cancelAiRun(): Promise<void> {
  if (!state.aiJobId) return;
  try {
    await cancelAiProcess(state.aiJobId);
  } catch (error) {
    state.settingsError = toDetailedMessage(error, "无法取消 AI 处理");
    renderSettingsAware();
  }
}

/** Sidebar counters; failures keep the previous values visible. */
export async function loadAiStats(): Promise<void> {
  if (!state.library) {
    state.aiStats = null;
    return;
  }
  try {
    state.aiStats = await getAiStats(state.library.id);
  } catch {
    // Sidebar keeps showing the previous counters; settings reloads on entry.
  }
}

/** Patch the sidebar progress (and toolbar label) without a full rebuild. */
export function updateAiSingleProgress(): void {
  const progress = app.querySelector<HTMLElement>("#ai-single-progress");
  if (progress) {
    progress.querySelector<HTMLElement>("[data-ai-single-count]")!.textContent =
      `${state.aiSingleDone} / ${state.aiSingleTotal}`;
    progress.querySelector<HTMLElement>("[data-ai-single-current]")!.textContent = state.aiSingleCurrent ?? "";
    const track = progress.querySelector<HTMLElement>("[data-ai-single-track]");
    if (track) {
      track.style.width = `${Math.min(100, Math.round((state.aiSingleDone / Math.max(1, state.aiSingleTotal)) * 100))}%`;
    }
  }
  const toolbar = app.querySelector<HTMLButtonElement>("#batch-ai-tag");
  if (toolbar) {
    toolbar.textContent = `AI ${formatCount(state.aiSingleDone)} / ${formatCount(state.aiSingleTotal)}…`;
  }
}

export async function saveSystemSettings(): Promise<void> {
  const behaviorSelect = app.querySelector<HTMLSelectElement>("#settings-close-behavior");
  const notifications = app.querySelector<HTMLInputElement>("#settings-notifications");
  const behavior = (behaviorSelect?.value as CloseBehavior | undefined) ?? state.closeBehavior;
  const enabled = notifications?.checked ?? state.notificationsEnabled;
  state.settingsBusy = true;
  state.settingsError = null;
  try {
    await setCloseBehavior(behavior);
    const settings = await setNotificationsEnabled(enabled);
    state.closeBehavior = settings.close_behavior;
    state.notificationsEnabled = settings.notifications_enabled;
    state.settingsNotice = "系统设置已保存";
  } catch (error) {
    state.settingsError = toUserMessage(error, "保存系统设置失败");
  } finally {
    state.settingsBusy = false;
    renderSettingsAware();
  }
}

export function clampPreviewMode(value: string | undefined | null): UiPreviewMode {
  return value === "immersive" ? "immersive" : "standard";
}

export function clampSort(value: string | undefined | null): SortMode {
  return value === "oldest" ||
    value === "name" ||
    value === "rating-desc" ||
    value === "rating-asc" ||
    value === "size-desc" ||
    value === "size-asc"
    ? value
    : "newest";
}

export function clampTheme(value: string | undefined | null): UiTheme {
  return value === "dark" ? "dark" : "light";
}

/** Apply data-theme without a full shell rebuild; chrome re-syncs liquid glass. */
export function applyTheme(theme: UiTheme): void {
  document.documentElement.dataset.theme = theme;
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (meta) meta.content = theme === "dark" ? "#121212" : "#f0f0f0";
  syncLiquidGlass();
}

export async function savePreviewModeSetting(): Promise<void> {
  const select = app.querySelector<HTMLSelectElement>("#settings-preview-mode");
  const next = clampPreviewMode(select?.value);
  state.settingsError = null;
  try {
    await persistUiPrefs({ uiPreviewMode: next });
    state.previewMode = next;
    state.settingsNotice = "默认查看方式已保存";
  } catch (error) {
    state.settingsError = toUserMessage(error, "保存默认查看方式失败");
  } finally {
    updateSettingsPanel();
  }
}

/** Instant-save theme from settings select; mirrors the sidebar toggle. */
export async function saveThemeSetting(): Promise<void> {
  const select = app.querySelector<HTMLSelectElement>("#settings-theme");
  const next = clampTheme(select?.value);
  const previous = state.theme;
  state.settingsError = null;
  state.theme = next;
  applyTheme(next);
  syncThemeToggle();
  try {
    const settings = await setUiPrefs({ uiTheme: next });
    state.theme = clampTheme(settings.ui_theme);
    applyTheme(state.theme);
    syncThemeToggle();
  } catch (error) {
    state.theme = previous;
    applyTheme(previous);
    syncThemeToggle();
    state.settingsError = toUserMessage(error, "保存主题失败");
    updateSettingsPanel();
  }
}

/** Flip theme from the main shell; no full render — only CSS + liquid glass. */
export async function toggleTheme(): Promise<void> {
  const next: UiTheme = state.theme === "dark" ? "light" : "dark";
  state.theme = next;
  applyTheme(next);
  syncThemeToggle();
  try {
    const settings = await setUiPrefs({ uiTheme: next });
    state.theme = clampTheme(settings.ui_theme);
    applyTheme(state.theme);
    syncThemeToggle();
    const settingsSelect = app.querySelector<HTMLSelectElement>("#settings-theme");
    if (settingsSelect) settingsSelect.value = state.theme;
  } catch (error) {
    // Roll back optimistic UI so the control never lies about persistence.
    state.theme = next === "dark" ? "light" : "dark";
    applyTheme(state.theme);
    syncThemeToggle();
    state.error = toUserMessage(error, "保存主题失败");
  }
}

/** Keep sidebar theme button labels/icons aligned with state.theme. */
export function syncThemeToggle(): void {
  const toggle = app.querySelector<HTMLButtonElement>("#theme-toggle");
  if (!toggle) return;
  const isDark = state.theme === "dark";
  const nextLabel = isDark ? "切换到浅色模式" : "切换到深色模式";
  toggle.textContent = isDark ? "☀" : "☾";
  toggle.title = nextLabel;
  toggle.setAttribute("aria-label", nextLabel);
  toggle.setAttribute("aria-pressed", String(isDark));
}

export function clampDensity(value: number): Density {
  const clamped = Math.min(5, Math.max(1, Math.round(value || 3)));
  return clamped as Density;
}
