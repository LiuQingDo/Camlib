/**
 * 启动装配。
 *
 * main.ts 只做三件事：注入「重绘门面」的实现、启动首屏、接后端的全局事件。
 * 具体渲染在 render/，弹窗与编辑器在 views/，动作与状态流转在 app/。
 *
 * 注意：下面这些能力有「门面（render/paint.ts）」和「实现」两份同名导出。
 * 注入时必须 import 实现所在模块，**不能**从 render/paint 拿——那张门面表
 * 全是转调 paint().xxx() 的壳，把壳当实现注入会让第一次重绘自我递归到爆栈，
 * 界面上只会剩一具空骨架（installPaint 里有防呆拦这一步）。
 */
import { LibraryStatus } from "./api/infrastructure";
import "./app/bindings/global"; // 副作用导入：全局快捷键、拖放与后端进度事件流
import { bindMergeFooterEvents, bindMergeModalEvents } from "./app/bindings/dialogs";
import { bindEditorFooterEvents } from "./app/bindings/editor";
import { bindPreviewMetaEvents } from "./app/bindings/preview";
import { bindSettingsEvents } from "./app/bindings/settings";
import { bindEmptyStateEvents, bindShellEvents, bindSidebarEvents, bindStatusEvents } from "./app/bindings/shell";
import { bindToolbarEvents } from "./app/bindings/toolbar";
import { bootstrap, persistUiPrefs, probeFfmpeg } from "./app/library";
import { loadMoreScrollRoot, refreshMedia, updateLoadMoreFooter } from "./app/media-query";
import { render, renderSettingsAware } from "./app/orchestrate";
import { openSettings } from "./app/settings-ops";
import { showTransientNotice } from "./app/ui";
import { initLiquidGlass, setGlassObserverPaused, syncLiquidGlass } from "./liquid-glass";
import "./render/events"; // 副作用导入：卡片/工具栏的 data-action 事件委托
import { installPaint } from "./render/paint";
import { initScrolling, onScrollingChange } from "./render/scrolling";
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

// 滚动态降级：滚动这几百毫秒里关掉卡片的背景模糊、把粘性工具条摘成纯模糊，
// 停手后原样恢复。同时暂停玻璃观察器，滚动结束补一次同步。
initScrolling();
onScrollingChange((scrolling) => {
  setGlassObserverPaused(scrolling);
  if (scrolling) return;
  requestAnimationFrame(() => syncLiquidGlass());
});
