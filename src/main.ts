/**
 * 启动装配。
 *
 * main.ts 只做三件事：注入「重绘门面」的实现、启动首屏、接后端的全局事件。
 * 具体渲染在 render/，弹窗与编辑器在 views/，动作与状态流转在 app/。
 */
import { LibraryStatus } from "./api/infrastructure";
import { bindEditorFooterEvents } from "./app/bindings/editor";
import { bootstrap, probeFfmpeg } from "./app/library";
import { renderSettingsAware } from "./app/orchestrate";
import { initLiquidGlass } from "./liquid-glass";
import {
  bindEmptyStateEvents,
  bindMergeFooterEvents,
  bindMergeModalEvents,
  bindPreviewMetaEvents,
  bindSettingsEvents,
  bindShellEvents,
  bindSidebarEvents,
  bindStatusEvents,
  bindToolbarEvents,
  installPaint,
  loadMoreScrollRoot,
  openSettings,
  persistUiPrefs,
  refreshMedia,
  render,
  showTransientNotice,
  updateLoadMoreFooter,
} from "./render/paint";
import { onGridScroll } from "./render/virtual";
import { state } from "./state";
import { initTitlebar } from "./titlebar";
import { updateSettingsPanel } from "./views/settings";
import { listen } from "@tauri-apps/api/event";

// 门面必须在任何渲染/交互之前装配：视图层的 patch 会回调这里的绑定器。
installPaint({
  render,
  refreshMedia,
  renderSettingsAware,
  updateSettingsPanel,
  persistUiPrefs,
  showTransientNotice,
  openSettings,
  loadMoreScrollRoot,
  updateLoadMoreFooter,
  bindShellEvents,
  bindSidebarEvents,
  bindStatusEvents,
  bindToolbarEvents,
  bindEmptyStateEvents,
  bindMergeModalEvents,
  bindMergeFooterEvents,
  bindSettingsEvents,
  bindPreviewMetaEvents,
  bindEditorFooterEvents,
});

initLiquidGlass();
initTitlebar();
probeFfmpeg();
void bootstrap();

// Backend volume watcher: apply disconnect/reconnect without a manual refresh.
void listen<LibraryStatus>("library-status", (event) => {
  const status = event.payload;
  const previous = state.availability;
  state.availability = status.availability;
  state.rootPath = status.root_path;
  state.libraryStatusReason = status.reason;
  if (previous === status.availability) return;
  if (status.availability === "available") {
    void bootstrap();
    return;
  }
  state.scanning = false;
  render();
});

// 虚拟滚动的驱动信号。桌面端 .content 是滚动容器，窄屏下退化成 body 滚动，
// 所以既挂捕获阶段的 window 监听（能收到任意后代元素的 scroll），也在骨架里
// 直挂 .content（见 bindShellEvents），两条路径都只是排一帧重绘。
window.addEventListener("scroll", onGridScroll, { passive: true, capture: true });
