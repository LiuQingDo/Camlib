// 由 main.ts 拆分而来：仅做搬移，未改动逻辑。
import {
  AiConfigDto,
  AiProfileDto,
  cancelAiProcess,
  getAiConfig,
  getAiStats,
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
  CUSTOM_MODEL_ID,
  findProvider,
  newProfileId,
  pickActiveProfile,
  profileLabel,
  providerApiKey,
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
    profiles: config.profiles.map((profile) => ({ ...profile })),
  };
}

/** 按服务商预设新建一条空白档案（地址与首个推荐模型已填好）。 */
function blankProfile(providerId: string): AiProfileDto {
  const preset = findProvider(providerId);
  return {
    id: newProfileId(),
    name: "",
    provider: preset.id,
    baseUrl: preset.baseUrl,
    model: preset.models[0]?.id ?? "",
    apiKey: "",
  };
}

/** 草稿的展示用名字（保存提示、删除提示里用）。 */
function draftProfileLabel(config: AiConfigDto): string {
  const profile = pickActiveProfile(config);
  return profile ? profileLabel(profile) : "未命名配置";
}

/**
 * 首次配置时垫一条默认档案：卡片有选中项、地址与推荐模型都填好，用户只用粘
 * 一个 Key。已有多条档案时只做拷贝与 active 校正，不覆盖旧选择。
 */
function initialAiDraft(config: AiConfigDto): AiConfigDto {
  const draft = cloneAiConfig(config);
  if (draft.profiles.length > 0) {
    if (!draft.profiles.some((profile) => profile.id === draft.activeProfileId)) {
      draft.activeProfileId = draft.profiles[0]?.id ?? "";
    }
    return draft;
  }
  const profile = blankProfile("openai");
  draft.profiles = [profile];
  draft.activeProfileId = profile.id;
  return draft;
}

/** 切换服务商或档案后清掉上一次的测试结果，避免状态错位。 */
function resetAiTestState(): void {
  state.aiTestResult = null;
}

/**
 * 把 DOM 上可能尚未提交的输入同步回草稿。切服务商、切档案、新建、保存、测试
 * 连接前都要先调一次，否则刚敲完还没失焦的 Key / 手填模型名会丢。
 *
 * 写入目标是「当前档案」自己的字段，因此每条档案的 Key 天然隔离。
 */
export function syncAiDraftFromDom(): void {
  const draft = state.aiDraft;
  if (!draft) return;
  const value = (selector: string): string | null =>
    app.querySelector<HTMLInputElement | HTMLSelectElement>(selector)?.value ?? null;
  const profile = pickActiveProfile(draft);
  if (profile) {
    const key = value("#settings-ai-chat-key");
    if (key !== null) profile.apiKey = key.trim();
    const url = value("#settings-ai-chat-url");
    if (url !== null) profile.baseUrl = url.trim();
    const customModel = value("#settings-ai-model-custom");
    if (customModel !== null) profile.model = customModel.trim();
    const name = value("#settings-ai-profile-name");
    if (name !== null) profile.name = name.trim();
  }
  const concurrency = Number.parseInt(value("#settings-ai-concurrency") ?? "", 10);
  if (Number.isFinite(concurrency)) draft.concurrency = concurrency;
  const enabled = app.querySelector<HTMLInputElement>("#settings-ai-enabled");
  if (enabled) draft.enabled = enabled.checked;
}

/** 切换服务商卡片：预设服务商自带接口地址与首个推荐模型。 */
export function selectAiProvider(providerId: string): void {
  syncAiDraftFromDom();
  const draft = state.aiDraft;
  if (!draft) return;
  const profile = pickActiveProfile(draft);
  if (!profile) return;
  const preset = findProvider(providerId);
  const changed = profile.provider !== preset.id;
  profile.provider = preset.id;
  // 只有真的换了服务商才重置地址与模型：重复点当前卡片不该冲掉手调的配置。
  if (changed && !preset.custom) {
    profile.baseUrl = preset.baseUrl;
    profile.model = preset.models[0]?.id ?? "";
  }
  if (changed) {
    // 每个服务商的 Key 各自保存：换服务商时带出该服务商已存的 Key（多条档案
    // 取最近一条），没有就清空——绝不把上一个服务商的 Key 留在输入框里。
    const stored = providerApiKey(draft.profiles, preset.id, profile.id);
    profile.apiKey = stored || (preset.custom ? profile.apiKey : "");
  }
  resetAiTestState();
  updateSettingsPanel();
}

/** 模型下拉：选「自定义模型…」时清空名称，露出可手填的输入框。 */
export function selectAiModel(modelId: string): void {
  syncAiDraftFromDom();
  const draft = state.aiDraft;
  if (!draft) return;
  const profile = pickActiveProfile(draft);
  if (!profile) return;
  profile.model = modelId === CUSTOM_MODEL_ID ? "" : modelId;
  resetAiTestState();
  updateSettingsPanel();
}

/** 切换当前档案：先把手上的输入落回旧档案，再切到目标档案。 */
export function selectAiProfile(profileId: string): void {
  syncAiDraftFromDom();
  const draft = state.aiDraft;
  if (!draft) return;
  if (!draft.profiles.some((profile) => profile.id === profileId)) return;
  draft.activeProfileId = profileId;
  resetAiTestState();
  updateSettingsPanel();
}

/**
 * 新建一条档案：沿用当前服务商与它的 Key，用户只需换个模型。
 * 若旧档案没起名，顺手把「服务商 · 模型」固化下来，避免两条同名分不清。
 */
export function createAiProfile(): void {
  syncAiDraftFromDom();
  const draft = state.aiDraft;
  if (!draft) return;
  const current = pickActiveProfile(draft);
  const providerId = current?.provider || "openai";
  const profile = blankProfile(providerId);
  profile.apiKey = providerApiKey(draft.profiles, providerId);
  if (current && !current.name.trim()) current.name = profileLabel(current);
  draft.profiles.push(profile);
  draft.activeProfileId = profile.id;
  resetAiTestState();
  state.settingsNotice = "已新增一条配置：选好模型后点「保存配置」";
  updateSettingsPanel();
}

/** 删除当前档案（草稿内生效，保存后落库）。 */
export function deleteAiProfile(): void {
  syncAiDraftFromDom();
  const draft = state.aiDraft;
  if (!draft) return;
  const current = pickActiveProfile(draft);
  if (!current) return;
  const removedLabel = profileLabel(current);
  const remaining = draft.profiles.filter((profile) => profile.id !== current.id);
  if (remaining.length > 0) {
    draft.profiles = remaining;
    draft.activeProfileId = remaining[remaining.length - 1]?.id ?? "";
    state.settingsNotice = `已删除「${removedLabel}」，保存后生效`;
  } else {
    // 至少留一条，否则页面没有可编辑的输入。
    const fresh = blankProfile("openai");
    draft.profiles = [fresh];
    draft.activeProfileId = fresh.id;
    state.settingsNotice = "已删除最后一条配置，已重置为空白配置";
  }
  resetAiTestState();
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
  state.settingsBusy = true;
  state.settingsError = null;
  try {
    state.aiConfig = await setAiConfig(draft);
    state.aiDraft = initialAiDraft(state.aiConfig);
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

export async function testAiConnectionNow(): Promise<void> {
  syncAiDraftFromDom();
  const draft = state.aiDraft;
  if (!draft) return;
  state.aiTestBusy = true;
  state.aiTestResult = null;
  state.settingsError = null;
  renderSettingsAware();
  try {
    // 测试命令只读已保存的配置，所以先把草稿落库，避免「测的是 A、存的是 B」。
    state.aiConfig = await setAiConfig(draft);
    state.aiDraft = initialAiDraft(state.aiConfig);
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
