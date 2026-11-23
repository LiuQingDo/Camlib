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
import { patchErrorBar, patchTaskPill } from "../orchestrate";
import { cancelTask } from "../tasks";
import { openAiChatDrawer } from "../../views/ai-chat";
import {
  bootstrap,
  cancelCurrentBackup,
  cancelCurrentScan,
  chooseLibraryFolder,
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
  // 骨架重建后 .content 是新节点，滚动监听要跟着新节点重挂。
  bind(app.querySelector(".content"), "scroll", onGridScroll);
}

/** 侧栏：媒体库块 / 日期树 / AI 块 / 页脚。 */
export function bindSidebarEvents(): void {
  bind(app.querySelector("#theme-toggle"), "click", () => void toggleTheme());
  bindAll("#settings-button, #settings-button-top", "click", () => void openSettings());
  bindAll("[data-prefix]", "click", (event) => {
    const prefix = (event.currentTarget as HTMLElement).dataset.prefix || undefined;
    state.datePrefix = prefix;
    // Prefix and range are exclusive in the UI so the title stays unambiguous.
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
 * 反馈区：错误条 / 任务胶囊 / 查询状态横幅 / 备份面板。
 * 区域整块重建后这里会被重跑，bind / bindAll 自带幂等，不会叠加监听器。
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
  bind(app.querySelector("#backup-open-button"), "click", () => void openBackupPanel());
  bind(app.querySelector("#close-backup"), "click", () => {
    state.backupOpen = false;
    patchToolbar();
  });
  bind(app.querySelector("#backup-preview-button"), "click", () => void createBackupPreview());
  bind(app.querySelector("#backup-source"), "change", (event) => {
    state.backupSourceId = (event.target as HTMLSelectElement).value || null;
  });
  bind(app.querySelector("#backup-target"), "change", (event) => {
    state.backupTargetId = (event.target as HTMLSelectElement).value || null;
  });
  bind(app.querySelector("#backup-ignore"), "change", (event) => {
    state.backupIgnoreExtensions = (event.target as HTMLInputElement).value;
  });
  bind(
    app.querySelector("#backup-conflict"),
    "change",
    (event) => void saveBackupConflict((event.target as HTMLSelectElement).value as ConflictPolicy),
  );
  bind(
    app.querySelector("#backup-merge"),
    "change",
    (event) => void saveBackupMerge((event.target as HTMLSelectElement).value === "on"),
  );
  bind(app.querySelector("#backup-deep-verify"), "change", (event) => {
    state.backupDeepVerify = (event.target as HTMLInputElement).checked;
    // The switch is persisted with the preview plan, so an existing summary
    // would otherwise keep advertising the previous setting.
    if (state.backupPreview) void createBackupPreview();
    else patchToolbar();
  });
  bind(app.querySelector("#backup-start-button"), "click", () => void startConfirmedBackup());
  bind(app.querySelector("#backup-cancel-button"), "click", () => void cancelCurrentBackup());
  bind(app.querySelector("#backup-retry-button"), "click", () => void retryCurrentBackup());
  bind(app.querySelector("#backup-view-new"), "click", () => void viewNewImports());
  bind(app.querySelector("#backup-view-new-later"), "click", () => {
    state.backupProgress = state.backupProgress ? { ...state.backupProgress, state: "completed" } : null;
    patchToolbar();
  });
  bindAll("[data-backup-run]", "click", (event) => {
    const runId = (event.currentTarget as HTMLElement).dataset.backupRun;
    if (!runId) return;
    state.backupExpandedRunId = state.backupExpandedRunId === runId ? null : runId;
    if (state.backupExpandedRunId) {
      void listBackupRunItems(runId, true)
        .then((items) => {
          state.backupHistoryItems = items;
          patchToolbar();
        })
        .catch((error) => {
          state.error = toUserMessage(error, "读取备份明细失败");
          patchToolbar();
        });
    } else {
      state.backupHistoryItems = [];
    }
    patchToolbar();
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
