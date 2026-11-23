// 由 main.ts 拆分而来：仅做搬移，未改动逻辑。
import { toUserMessage } from "../../api/errors";
import { setAutoScanOnStartup } from "../../api/infrastructure";
import { ConflictPolicy, listBackupRunItems } from "../../api/media";
import { app, bind, bindAll, region } from "../../render/context";
import { openSettings, refreshMedia } from "../../render/paint";
import { patchSidebar } from "../../render/shell";
import { patchToolbar, resetSidebarExpansionForSelection, searchUi, toggleTaskPill } from "../../render/toolbar";
import { onGridScroll } from "../../render/virtual";
import { state } from "../../state";
import { dismissNotice, runNoticeAction } from "../notices";
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
  viewRecentImports,
} from "../library";
import { toggleTheme } from "../settings-ops";
import { exitSemanticSearch } from "./toolbar";

/** 骨架里的静态节点（搜索框、顶栏扫描按钮）：终身只绑一次。 */
export function bindShellEvents(): void {
  const searchInput = app.querySelector<HTMLInputElement>("#search-input");
  if (searchInput) {
    bind(searchInput, "input", () => {
      searchUi.draft = searchInput.value;
    });
    bind(searchInput, "keydown", (event) => {
      if ((event as KeyboardEvent).key !== "Enter") return;
      event.preventDefault();
      state.search = searchUi.draft.trim();
      void refreshMedia();
    });
  }
  bind(app.querySelector("#search-button"), "click", () => {
    state.search = searchUi.draft.trim();
    void refreshMedia();
  });
  bind(app.querySelector("#scan-top-button"), "click", () => void scanLibrary());
  // 侧栏「导入照片…」是骨架里的静态节点：在这里绑一次，不依赖 patchSidebar。
  bindAll('[data-nav="import"]', "click", () => void openBackupPanel());
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

/** 侧栏：媒体库块 / 日期树 / AI 块 / 页脚。 */
export function bindSidebarEvents(): void {
  bind(app.querySelector("#theme-toggle"), "click", () => void toggleTheme());
  bindAll("#settings-button, #settings-button-top", "click", () => void openSettings());
  bindAll('[data-nav="recent-imports"]', "click", () => void viewRecentImports());
  bindAll("[data-prefix]", "click", (event) => {
    const prefix = (event.currentTarget as HTMLElement).dataset.prefix || undefined;
    state.datePrefix = prefix;
    // 日期前缀与区间是唯一合法互斥的一对：标题只能呈现一种日期条件，
    // 两者并存会让 primaryDateLabel() 二选一、标题失去确定性。
    // 其他筛选（类型 / 收藏 / 连拍 / 标签…）都按 AND 叠加，不要在这里顺手清。
    state.dateFrom = undefined;
    state.dateTo = undefined;
    if (prefix) {
      state.expandedYears.add(prefix.slice(0, 4));
      if (prefix.length >= 7) state.expandedMonths.add(prefix.slice(0, 7));
    } else {
      resetSidebarExpansionForSelection();
    }
    patchSidebar();
    void refreshMedia();
  });
  bindAll("[data-year-toggle]", "click", (event) => {
    const year = (event.currentTarget as HTMLElement).dataset.yearToggle!;
    if (state.expandedYears.has(year)) state.expandedYears.delete(year);
    else state.expandedYears.add(year);
    patchSidebar();
  });
  bindAll("[data-month-toggle]", "click", (event) => {
    const month = (event.currentTarget as HTMLElement).dataset.monthToggle!;
    if (state.expandedMonths.has(month)) state.expandedMonths.delete(month);
    else state.expandedMonths.add(month);
    patchSidebar();
  });
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
  bind(app.querySelector("#ai-open-settings"), "click", () => void openSettings("ai"));
  bind(app.querySelector("#ai-open-batch"), "click", () => void openSettings("ai"));
  bind(app.querySelector("#ai-chat-open"), "click", () => void openAiChatDrawer());
  bind(app.querySelector("#ai-single-cancel"), "click", () => {
    // The sequential loop checks this flag before each photo.
    state.aiSingleBusy = false;
  });
  bind(app.querySelector("#ai-semantic-focus"), "click", () => {
    state.filtersExpanded = true;
    patchToolbar();
    app.querySelector<HTMLInputElement>("#semantic-search-input")?.focus();
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

/** 网格空态里的「选择文件夹 / 手动输入路径」表单。 */
export function bindEmptyStateEvents(): void {
  const area = region("media");
  if (!area) return;
  bind(area.querySelector("#choose-folder-button"), "click", () => void chooseLibraryFolder());
  bind(area.querySelector("#library-form"), "submit", (event) => {
    event.preventDefault();
    const input = area.querySelector<HTMLInputElement>("#library-path");
    if (input?.value.trim()) void connectLibrary(input.value.trim());
  });
}
