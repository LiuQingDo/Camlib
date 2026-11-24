// 由 main.ts 拆分而来：仅做搬移，未改动逻辑。
import { toUserMessage } from "../../api/errors";
import { setAutoScanOnStartup } from "../../api/infrastructure";
import { ConflictPolicy, listBackupRunItems } from "../../api/media";
import { app, bind, bindAll, region } from "../../render/context";
import { openSettings, refreshMedia } from "../../render/paint";
import { patchSidebar } from "../../render/shell";
import {
  patchToolbar,
  resetSidebarExpansionForSelection,
  searchUi,
  syncSearchChrome,
  toggleTaskPill,
  type SearchMode,
} from "../../render/toolbar";
import { onGridScroll } from "../../render/virtual";
import { state } from "../../state";
import { dismissNotice, runNoticeAction } from "../notices";
import { openTagManager } from "../dialogs-ops";
import { patchBackupOverlay, patchErrorBar, patchTaskPill } from "../orchestrate";
import { cancelTask } from "../tasks";
import { showToast } from "../toast";
import { openAiChatDrawer } from "../../views/ai-chat";
import {
  backupRunning,
  bootstrap,
  cancelCurrentBackup,
  cancelCurrentScan,
  chooseLibraryFolder,
  closeBackupPanel,
  connectLibrary,
  createBackupPreview,
  openBackupPanel,
  retryCurrentBackup,
  saveBackupConflict,
  saveBackupMerge,
  scanLibrary,
  startConfirmedBackup,
  viewNewImports,
} from "../library";
import { toggleTheme } from "../settings-ops";
import { clearAllFilters, clearFiltersKeepSearch, commitSemanticSearch, exitSemanticSearch } from "./toolbar";

/** 边打边筛的停顿阈值：明显短于人的下一次思考，长于连续按键的间隔。 */
const SEARCH_DEBOUNCE_MS = 250;

/** 防抖句柄。搜索框是骨架里的静态节点，模块级变量与它同生命周期。 */
let searchCommitTimer: number | null = null;

function cancelSearchCommit(): void {
  if (searchCommitTimer === null) return;
  window.clearTimeout(searchCommitTimer);
  searchCommitTimer = null;
}

/**
 * 普通模式提交：把搜索框内容提交为 `state.search` 并刷新。
 *
 * `resetScroll` 只对显式动作（Enter / 搜索按钮 / 清空）为 true：输入路径由
 * 防抖走 false，否则每敲一个字视图都被拽回顶部。空提交不发请求，避免
 * 同一关键词被 Enter 与按钮重复查一遍。
 */
function commitTextSearch(resetScroll: boolean): void {
  cancelSearchCommit();
  const input = app.querySelector<HTMLInputElement>("#search-input");
  // 以 DOM 的实际值为准：程序化写入（清空、模式切换）不必再手抄一份草稿。
  if (input) searchUi.draft = input.value;
  const next = searchUi.draft.trim();
  let changed = next !== state.search;
  // 兜底：普通搜索与 AI 搜索互斥（commitSemanticSearch 也是这么收尾的）。
  // 两条路径同时生效时后端语义优先，输入了词却仍有结果走 AI，看起来像没反应。
  if (next && state.semanticSearch) {
    state.semanticSearch = null;
    searchUi.semantic = "";
    state.semanticMeta = null;
    state.semanticMode = null;
    changed = true;
  }
  if (!changed) return;
  state.search = next;
  void refreshMedia({ resetScroll });
}

/** AI 模式提交：草稿写回 `searchUi.semantic` 后交给既有的语义检索管线。 */
function commitAiSearch(): void {
  cancelSearchCommit();
  const input = app.querySelector<HTMLInputElement>("#search-input");
  if (input) searchUi.semantic = input.value;
  syncSearchChrome();
  commitSemanticSearch();
}

function commitSearch(resetScroll: boolean): void {
  if (searchUi.mode === "ai") commitAiSearch();
  else commitTextSearch(resetScroll);
}

/** 输入防抖：清空立即生效，有词才等 250ms（手写定时器，不引依赖）。 */
function scheduleSearchCommit(): void {
  cancelSearchCommit();
  // AI 检索是一次真实的上游调用，不能每敲一个字发一次：只认 Enter / 按钮。
  if (searchUi.mode === "ai") return;
  if (!searchUi.draft.trim()) {
    commitTextSearch(true);
    return;
  }
  searchCommitTimer = window.setTimeout(() => {
    searchCommitTimer = null;
    commitTextSearch(false);
  }, SEARCH_DEBOUNCE_MS);
}

/** 清空搜索：只清搜索词，不动筛选条件，焦点留在输入框。 */
function clearSearch(): void {
  cancelSearchCommit();
  const input = app.querySelector<HTMLInputElement>("#search-input");
  const hadSemantic = Boolean(state.semanticSearch);
  if (input) {
    input.value = "";
    input.focus();
  }
  searchUi.draft = "";
  searchUi.semantic = "";
  if (hadSemantic) {
    state.semanticSearch = null;
    state.semanticMeta = null;
    state.semanticMode = null;
  }
  syncSearchChrome();
  if (searchUi.mode === "ai") {
    // AI 模式没有防抖兜底，条件真的变了才值得再查一次。
    if (hadSemantic) void refreshMedia({ resetScroll: true });
    return;
  }
  if (state.search) {
    state.search = "";
    void refreshMedia({ resetScroll: true });
  }
}

/**
 * 搜索模式切换（普通 ⇄ AI）。
 *
 * 两个草稿各留一份，但同一时刻只让一种条件生效：切走时清掉对方条件，
 * 否则 `fetchMediaPage` 仍会优先走语义路径，普通搜索词看起来完全没起作用。
 */
export function setSearchMode(mode: SearchMode): void {
  const input = app.querySelector<HTMLInputElement>("#search-input");
  if (searchUi.mode === mode) {
    input?.focus();
    return;
  }
  cancelSearchCommit();
  searchUi.mode = mode;
  let changed = false;
  if (mode === "ai") {
    if (state.search) {
      state.search = "";
      changed = true;
    }
    searchUi.draft = "";
    if (input) input.value = searchUi.semantic;
  } else {
    if (state.semanticSearch) {
      state.semanticSearch = null;
      state.semanticMeta = null;
      state.semanticMode = null;
      changed = true;
    }
    searchUi.semantic = "";
    if (input) input.value = searchUi.draft;
  }
  syncSearchChrome();
  input?.focus();
  if (changed) void refreshMedia({ resetScroll: true });
  // 条件没变也要过一遍 patchToolbar：它顺手把「模式刚变」记下来，
  // 下一次重绘才不会把输入框当成另一套草稿强行改写。
  else patchToolbar();
}

/** 骨架里的静态节点（搜索框、顶栏扫描按钮）：终身只绑一次。 */
export function bindShellEvents(): void {
  const searchInput = app.querySelector<HTMLInputElement>("#search-input");
  if (searchInput) {
    bind(searchInput, "input", () => {
      if (searchUi.mode === "ai") searchUi.semantic = searchInput.value;
      else searchUi.draft = searchInput.value;
      syncSearchChrome();
      scheduleSearchCommit();
    });
    bind(searchInput, "keydown", (event) => {
      const key = (event as KeyboardEvent).key;
      if (key === "Enter") {
        event.preventDefault();
        commitSearch(true);
        return;
      }
      if (key === "Escape") {
        // 空框的 Esc 不归这里：让全局快捷键继续处理（退出预览等）。
        if (!searchInput.value && !state.search && !state.semanticSearch) return;
        event.preventDefault();
        event.stopPropagation();
        clearSearch();
      }
      // 失焦刻意不提交：用户点走是要离开搜索框，不是要执行查询。
    });
  }
  bind(app.querySelector("#search-clear"), "click", () => clearSearch());
  bind(app.querySelector("#search-mode"), "click", () => setSearchMode(searchUi.mode === "ai" ? "text" : "ai"));
  bind(app.querySelector("#search-button"), "click", () => commitSearch(true));
  bind(app.querySelector("#scan-top-button"), "click", () => void scanLibrary());
  // 骨架重建后 .content 是新节点，滚动监听要跟着新节点重挂。
  bind(app.querySelector(".content"), "scroll", onGridScroll);
  bindBackupDrawerEvents();
}

/**
 * 备份抽屉是 overlay 槽位里的动态内容，每次 patch 都会换掉内部节点。
 * 在静态宿主上做一次委托，比每次重建后重绑十几个 id 稳，也不会和
 * patchBackupOverlay 的调用顺序耦合。
 */
function bindBackupDrawerEvents(): void {
  const host = app.querySelector<HTMLElement>('[data-overlay="backup"]');
  if (!host) return;
  bind(host, "click", (event) => {
    const target = event.target instanceof HTMLElement ? event.target : null;
    if (!target) return;
    // 只有点在遮罩本身才关闭；抽屉内的点击不会命中这个判断。
    if (target.classList.contains("backup-backdrop")) {
      if (backupRunning()) {
        showToast("备份在后台继续 · 重新打开可查看进度", { kind: "info", key: "backup-running" });
        return;
      }
      closeBackupPanel();
      return;
    }
    if (target.closest("#close-backup")) {
      closeBackupPanel();
      return;
    }
    if (target.closest("#backup-preview-button")) {
      void createBackupPreview();
      return;
    }
    if (target.closest("#backup-start-button")) {
      void startConfirmedBackup();
      return;
    }
    if (target.closest("#backup-cancel-button")) {
      void cancelCurrentBackup();
      return;
    }
    if (target.closest("#backup-retry-button")) {
      void retryCurrentBackup();
      return;
    }
    if (target.closest("#backup-view-new")) {
      void viewNewImports();
      return;
    }
    if (target.closest("#backup-view-new-later")) {
      // 结果已经落库，收藏/历史都在；这里只收起抽屉，侧栏「最近导入」可再进。
      closeBackupPanel();
      return;
    }
    const runRow = target.closest<HTMLElement>("[data-backup-run]");
    if (runRow) toggleBackupRun(runRow.dataset.backupRun);
  });
  bind(host, "change", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    if (target.id === "backup-source") {
      state.backupSourceId = (target as HTMLSelectElement).value || null;
      return;
    }
    if (target.id === "backup-target") {
      state.backupTargetId = (target as HTMLSelectElement).value || null;
      return;
    }
    if (target.id === "backup-ignore") {
      state.backupIgnoreExtensions = (target as HTMLInputElement).value;
      return;
    }
    if (target.id === "backup-conflict") {
      void saveBackupConflict((target as HTMLSelectElement).value as ConflictPolicy);
      return;
    }
    if (target.id === "backup-merge") {
      void saveBackupMerge((target as HTMLSelectElement).value === "on");
      return;
    }
    if (target.id === "backup-deep-verify") {
      state.backupDeepVerify = (target as HTMLInputElement).checked;
      // The switch is persisted with the preview plan, so an existing summary
      // would otherwise keep advertising the previous setting.
      if (state.backupPreview) void createBackupPreview();
      else patchBackupOverlay();
    }
  });
}

function toggleBackupRun(runId: string | undefined): void {
  if (!runId) return;
  state.backupExpandedRunId = state.backupExpandedRunId === runId ? null : runId;
  patchBackupOverlay();
  if (state.backupExpandedRunId) {
    void listBackupRunItems(runId, true)
      .then((items) => {
        state.backupHistoryItems = items;
        patchBackupOverlay();
      })
      .catch((error) => {
        state.error = toUserMessage(error, "读取备份明细失败");
        patchBackupOverlay();
        patchToolbar();
      });
  } else {
    state.backupHistoryItems = [];
  }
}

/** 「最近导入」的时间窗：最近 7 天首次被索引的媒体。 */
const RECENT_IMPORT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * 导航项本质是预设筛选：切换时先把其它条件清干净。
 * 与筛选 chip 的叠加语义不冲突——chip 只在自己那条条件上叠加，导航负责整体复位，
 * 否则「收藏」会带着上一条日期条件一起生效，看着像是收藏里少了东西。
 */
function resetNavFilters(): void {
  state.kind = undefined;
  state.favoriteOnly = false;
  state.burstOnly = false;
  state.datePrefix = undefined;
  state.dateFrom = undefined;
  state.dateTo = undefined;
  state.firstSeenFrom = null;
  state.tagIds.clear();
  state.ratingEq = null;
  state.ratingMin = null;
  state.semanticSearch = null;
  searchUi.semantic = "";
  state.semanticMeta = null;
  state.semanticMode = null;
  state.search = "";
  searchUi.draft = "";
}

function applyRecentImportsPreset(): void {
  resetNavFilters();
  // 与备份完成后的「新导入」同一种表达，只是窗口固定为 7 天。
  state.firstSeenFrom = `unix-ms:${Date.now() - RECENT_IMPORT_WINDOW_MS}`;
  resetSidebarExpansionForSelection();
  void refreshMedia({ resetScroll: true });
}

function applyFavoritesPreset(): void {
  resetNavFilters();
  state.favoriteOnly = true;
  resetSidebarExpansionForSelection();
  void refreshMedia({ resetScroll: true });
}

/** 侧栏一级导航统一分派（[data-nav]）。 */
function handleSidebarNav(nav: string | undefined): void {
  // 没有媒体库时预设筛选无处可落（库卡本身就是首启 CTA），只放行「导入照片」。
  if (!state.library && nav !== "import") return;
  switch (nav) {
    case "all":
      clearAllFilters();
      return;
    case "recent":
      applyRecentImportsPreset();
      return;
    case "favorites":
      applyFavoritesPreset();
      return;
    case "tags":
      openTagManager();
      return;
    case "import":
      void openBackupPanel();
      return;
    default:
      // "deleted" 留给后续半场：按钮已 disabled，这里只兜住意外触发。
      return;
  }
}

/**
 * 日期行整行可点：未选中 → 选中并展开；已选中 → 只切换展开。
 * 月份是叶子节点（第三级已去掉），再点一次同一行即取消日期条件。
 */
function handleDateRow(row: HTMLElement): void {
  const prefix = row.dataset.dateRow;
  if (!prefix) return;
  const isYear = row.dataset.dateLevel === "year";
  if (state.datePrefix === prefix) {
    if (isYear) {
      if (state.expandedYears.has(prefix)) state.expandedYears.delete(prefix);
      else state.expandedYears.add(prefix);
      patchSidebar();
      return;
    }
    state.datePrefix = undefined;
    state.dateFrom = undefined;
    state.dateTo = undefined;
    resetSidebarExpansionForSelection();
    patchSidebar();
    void refreshMedia({ resetScroll: true });
    return;
  }
  state.datePrefix = prefix;
  // 日期前缀与区间是唯一合法互斥的一对：标题只能呈现一种日期条件。
  // 其他筛选（类型 / 收藏 / 连拍 / 标签…）按 AND 叠加，不在这里顺手清。
  state.dateFrom = undefined;
  state.dateTo = undefined;
  state.expandedYears.add(prefix.slice(0, 4));
  patchSidebar();
  void refreshMedia({ resetScroll: true });
}

/** 侧栏：导航 / 媒体库块 / 日期树 / AI 块 / 页脚。 */
export function bindSidebarEvents(): void {
  bind(app.querySelector("#theme-toggle"), "click", () => void toggleTheme());
  bind(app.querySelector("#settings-button-top"), "click", () => void openSettings());
  bindAll("[data-nav]", "click", (event) => handleSidebarNav((event.currentTarget as HTMLElement).dataset.nav));
  bindAll("[data-date-row]", "click", (event) => handleDateRow(event.currentTarget as HTMLElement));
  bind(app.querySelector("#scan-button"), "click", () => void scanLibrary());
  bind(app.querySelector("#refresh-button"), "click", () => void bootstrap());
  bind(app.querySelector("#change-library-button"), "click", () => {
    state.libraryFormOpen = !state.libraryFormOpen;
    patchSidebar();
  });
  bind(app.querySelector("#library-cancel-button"), "click", () => {
    state.libraryFormOpen = false;
    patchSidebar();
  });
  const libraryPanel = region("sidebar-library");
  bind(libraryPanel?.querySelector("#choose-folder-button"), "click", () => void chooseLibraryFolder());
  bind(libraryPanel?.querySelector("#library-form"), "submit", (event) => {
    event.preventDefault();
    const input = libraryPanel?.querySelector<HTMLInputElement>("#library-path");
    if (input?.value.trim()) void connectLibrary(input.value.trim());
  });
  bind(app.querySelector("#auto-scan-toggle"), "change", (event) => {
    const enabled = (event.target as HTMLInputElement).checked;
    void (async () => {
      try {
        const settings = await setAutoScanOnStartup(enabled);
        state.autoScanOnStartup = settings.auto_scan_on_startup;
      } catch (error) {
        state.error = toUserMessage(error, "保存启动扫描设置失败");
        patchToolbar();
      }
    })();
  });
  bind(app.querySelector("#ai-chat-open"), "click", () => void openAiChatDrawer());
  bind(app.querySelector("#ai-single-cancel"), "click", () => {
    // The sequential loop checks this flag before each photo.
    state.aiSingleBusy = false;
  });
}

/**
 * 反馈区：错误条 / 任务胶囊 / 查询状态横幅。
 * 区域整块重建后这里会被重跑，bind / bindAll 自带幂等，不会叠加监听器。
 * 备份抽屉的控件不在这里：它挂在 overlay 槽位，由 bindBackupDrawerEvents 委托。
 */
export function bindStatusEvents(): void {
  bind(app.querySelector("#rescan-button"), "click", () => void bootstrap());
  bind(app.querySelector("#open-settings-from-banner"), "click", () => void openSettings("library"));
  bind(app.querySelector("#exit-semantic-search"), "click", () => exitSemanticSearch());
  // 关闭一条通知：注册表会顺手清回源 state，否则下一次同步又把它推回来。
  bindAll("[data-notice-dismiss]", "click", (event) => {
    const id = (event.currentTarget as HTMLElement).dataset.noticeDismiss;
    if (!id) return;
    dismissNotice(id);
    patchErrorBar();
  });
  bindAll("[data-notice-action]", "click", (event) => {
    const element = event.currentTarget as HTMLElement;
    const id = element.dataset.noticeId;
    const index = Number(element.dataset.noticeAction);
    if (!id || !Number.isInteger(index)) return;
    runNoticeAction(id, index);
    patchErrorBar();
  });
  bindAll("[data-task-toggle]", "click", () => {
    toggleTaskPill();
    patchTaskPill();
  });
  bindAll("[data-task-cancel]", "click", (event) => {
    const id = (event.currentTarget as HTMLElement).dataset.taskCancel;
    if (!id) return;
    // 扫描的取消命令在 app/library（要走后端），其余任务用注册表里的回调。
    if (id === "scan") void cancelCurrentScan();
    else cancelTask(id);
    patchTaskPill();
  });
}

/** 网格空态里的「选择文件夹 / 手动输入路径」表单与两条出路按钮。 */
export function bindEmptyStateEvents(): void {
  const area = region("media");
  if (!area) return;
  bind(area.querySelector("#choose-folder-button"), "click", () => void chooseLibraryFolder());
  bind(area.querySelector("#library-form"), "submit", (event) => {
    event.preventDefault();
    const input = area.querySelector<HTMLInputElement>("#library-path");
    if (input?.value.trim()) void connectLibrary(input.value.trim());
  });
  bind(area.querySelector("#empty-clear-filters"), "click", () => clearFiltersKeepSearch());
  bind(area.querySelector("#empty-clear-all"), "click", () => clearAllFilters());
}
