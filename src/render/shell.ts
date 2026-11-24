// 由 main.ts 拆分而来：仅做搬移，未改动逻辑。
import { formatCount } from "../lib/format";
import { state } from "../state";
import { renderAiSidebarSection } from "../views/ai-chat";
import { app, region, setRegionHtml } from "./context";
import { bindShellEvents, bindSidebarEvents } from "./paint";
import { escapeHtml, facetTotal, groupedFacets, selectedPrefix } from "./text";

/** 侧栏一级导航的键；每一项本质是一组预设筛选，而不是新页面。 */
export type SidebarNavKey = "all" | "recent" | "favorites" | "deleted" | "tags" | "import";

const SIDEBAR_NAV_ITEMS: ReadonlyArray<{ key: SidebarNavKey; label: string; icon: string; dialog: boolean }> = [
  { key: "all", label: "全部媒体", icon: "▤", dialog: false },
  { key: "recent", label: "最近导入", icon: "↺", dialog: false },
  { key: "favorites", label: "收藏", icon: "★", dialog: false },
  { key: "deleted", label: "已删除", icon: "⌫", dialog: false },
  { key: "tags", label: "标签", icon: "▦", dialog: true },
  { key: "import", label: "导入照片…", icon: "＋", dialog: true },
];

/**
 * 当前生效的导航项。
 *
 * 导航只表达「最近导入 / 收藏」这类整轮预设；日期、类型、标签等由 chip 表达
 * 的叠加条件一旦生效，就不再谎称停在「全部媒体」上——此时返回 null。
 */
export function sidebarNavActive(): SidebarNavKey | null {
  if (state.favoriteOnly) return "favorites";
  if (state.firstSeenFrom) return "recent";
  if (
    hasDateFilter() ||
    state.tagIds.size ||
    state.kind ||
    state.burstOnly ||
    state.ratingEq !== null ||
    state.ratingMin !== null
  )
    return null;
  return "all";
}

export function renderSidebarNav(): string {
  const active = sidebarNavActive();
  const total = state.library && state.availability === "available" ? facetTotal() : 0;
  return SIDEBAR_NAV_ITEMS.map((item) => {
    const icon = `<span class="sidebar-nav-icon" aria-hidden="true">${item.icon}</span>`;
    const count = item.key === "all" && total > 0 ? `<span class="sidebar-nav-count">${formatCount(total)}</span>` : "";
    const current = active === item.key ? ` aria-current="page"` : "";
    const dialog = item.dialog ? ` aria-haspopup="dialog"` : "";
    return `<button class="sidebar-nav-item" type="button" data-nav="${item.key}"${current}${dialog}>${icon}<span>${item.label}</span>${count}</button>`;
  }).join("");
}

/**
 * 日期树：年 / 月两级，每行是一个整行按钮。
 * ▸/▾ 只是行内的状态图标（aria-hidden），不再承担点击——展开与选中都在行上。
 */
export function renderDateNavigation(): string {
  if (!state.facets.length) return `<div class="nav-empty">扫描后会在这里显示年月</div>`;
  return `<div class="date-tree">
    ${groupedFacets()
      .map((yearGroup) => {
        const yearExpanded = state.expandedYears.has(yearGroup.year);
        return `<section class="year-group ${yearExpanded ? "is-expanded" : ""}">
      <button class="date-row year-row ${selectedPrefix(state.datePrefix, yearGroup.year)}" type="button" data-date-row="${yearGroup.year}" data-date-level="year" aria-expanded="${yearExpanded}"><span class="date-row-caret" aria-hidden="true">${yearExpanded ? "▾" : "▸"}</span><span class="date-row-label">${yearGroup.year} 年</span><span class="date-row-count">${formatCount(yearGroup.count)}</span></button>
      ${
        yearExpanded
          ? `<div class="month-list">${yearGroup.months
              .map((monthGroup) => {
                const monthPrefix = `${yearGroup.year}-${monthGroup.month}`;
                return `<button class="date-row month-row ${selectedPrefix(state.datePrefix, monthPrefix)}" type="button" data-date-row="${monthPrefix}" data-date-level="month"><span class="date-row-label">${Number(monthGroup.month)} 月</span><span class="date-row-count">${formatCount(monthGroup.count)}</span></button>`;
              })
              .join("")}</div>`
          : ""
      }
    </section>`;
      })
      .join("")}
  </div>`;
}

export function renderLibrarySwitcher(): string {
  if (!state.libraryFormOpen || !state.library) return "";
  return `<div class="library-form library-change-form"><div class="library-form-actions"><button class="primary-button" id="choose-folder-button" type="button">选择文件夹…</button><button class="text-button" id="library-cancel-button" type="button">取消</button></div><details class="manual-path"><summary>手动输入路径</summary><form id="library-form"><input id="library-path" required value="${escapeHtml(state.rootPath ?? state.library.rootPath)}" placeholder="例如：D:\\照片" aria-label="媒体库路径" /><button class="outline-button" type="submit">确认更换</button></form></details></div>`;
}

/**
 * 骨架。只在应用启动、切换媒体库时重建；其余时候它只是 patch 的挂载点。
 * 主题切换不在此列：配色走 CSS 变量，侧栏那个按钮由 syncThemeToggle 原地改，
 * 重建骨架对配色没有任何帮助，只会白白丢掉焦点与滚动位置。
 */
export const SHELL_HTML = `<div class="shell"><aside class="sidebar" aria-label="媒体库导航">
    <div class="brand"><span class="brand-mark" aria-hidden="true"><img src="/camlib-icon.png" alt="" width="37" height="37" /></span><div><strong>Camlib</strong><span>媒体库</span></div><button class="icon-button brand-settings" type="button" id="settings-button-top" title="设置" aria-label="打开设置">⚙</button></div>
    <nav class="sidebar-section sidebar-nav-section" aria-label="媒体库导航">
      <div class="library-section" data-region="sidebar-library"></div>
      <div class="sidebar-nav" data-region="sidebar-nav"></div>
    </nav>
    <nav class="sidebar-section date-section" aria-label="按日期浏览" data-region="sidebar-dates"></nav>
    <div data-region="sidebar-ai"></div>
    <div class="sidebar-footer" data-region="sidebar-footer"></div>
  </aside><main class="content">
    <header class="topbar"><div class="title-block" data-region="topbar-title"></div><div class="top-actions"><div data-region="task-pill"></div><div class="search-box" id="search-box"><span aria-hidden="true">⌕</span><input id="search-input" value="" placeholder="搜索文件名、标签、描述" aria-label="搜索文件名、标签与 AI 描述" /><button class="search-clear" id="search-clear" type="button" title="清空搜索" aria-label="清空搜索" hidden>×</button><button class="search-mode" id="search-mode" type="button" title="切换到 AI 搜索" aria-label="切换到 AI 搜索" aria-pressed="false">✦</button><kbd>/</kbd><button class="search-button" id="search-button" type="button">搜索</button></div><button class="outline-button" id="scan-top-button" type="button"></button></div></header>
    <div data-region="error-bar"></div>
    <div data-region="status"></div>
    <div class="sticky-controls"><div class="toolbar"><div class="filter-row" data-region="filter-row"></div><div class="toolbar-right" data-region="toolbar-right"></div></div><div class="filter-chips" data-region="filter-chips" role="group" aria-label="已选筛选条件"></div><div data-region="selection"></div></div>
    <section class="media-area" aria-live="polite" data-region="media"></section></main></div>
<div id="overlay-host"><div data-overlay="preview"></div><div data-overlay="confirm"></div><div data-overlay="tag-manager"></div><div data-overlay="editor"></div><div data-overlay="merge"></div><div data-overlay="settings"></div><div data-overlay="ai-chat"></div><div data-overlay="backup"></div><div data-overlay="deleted"></div><div data-overlay="filters"></div></div>
<div id="toast-host" aria-live="polite"></div>`;

export function renderShell(force = false): void {
  if (!force && app.querySelector(".shell")) return;
  app.innerHTML = SHELL_HTML;
  bindShellEvents();
}

export function sidebarLibraryHtml(): string {
  const library = state.library;
  const actions = library
    ? `<span class="section-actions"><button class="icon-button" id="change-library-button" title="更换媒体库" aria-label="更换媒体库">⇄</button><button class="icon-button" id="refresh-button" title="刷新状态" aria-label="刷新状态">↻</button></span>`
    : "";
  const entry = library
    ? `<div class="library-entry ${state.availability !== "available" ? "is-offline" : ""}"><span class="drive-icon">▣</span><div><strong>${escapeHtml(library.volumeLabel || library.driveLetter ? `${library.volumeLabel ?? "本地磁盘"} ${library.driveLetter ? `(${library.driveLetter}:)` : ""}` : "已连接媒体库")}</strong><span>${state.availability === "available" ? `${formatCount(facetTotal())} 个媒体` : "暂时不可用"}</span></div><span class="status-dot"></span></div>${renderLibrarySwitcher()}`
    : // 未配置时整卡就是首个 CTA：与空态主按钮同一个 id，走同一个处理函数。
      `<button class="library-entry is-empty" type="button" id="choose-folder-button" aria-label="选择媒体库文件夹"><span class="drive-icon">＋</span><span class="library-entry-text"><strong>添加媒体库</strong><span>选择一个目录开始</span></span></button>`;
  return `<div class="section-label"><span>媒体库</span>${actions}</div>${entry}`;
}

/**
 * 页脚只留状态与三个动作（启动扫描 / 扫描 / 主题）。
 * 设置入口收在 brand 里那一个，这里不再重复。
 */
export function sidebarFooterHtml(): string {
  const status =
    state.availability === "available" ? "索引已连接" : state.availability === "unconfigured" ? "等待连接" : "等待设备";
  const scanDisabled = state.availability !== "available" ? "disabled" : "";
  const themeLabel = state.theme === "dark" ? "切换到浅色模式" : "切换到深色模式";
  return `<div class="footer-status"><span class="footer-dot"></span><span class="footer-status-text">${status}</span></div><div class="footer-controls"><label class="auto-scan-toggle" title="启动时自动增量扫描"><input id="auto-scan-toggle" type="checkbox" ${state.autoScanOnStartup ? "checked" : ""} aria-label="启动时自动扫描" /><span>启动扫描</span></label><span class="footer-actions"><button class="icon-button" title="${state.availability === "available" ? "扫描媒体库" : "媒体库不可用"}" id="scan-button" aria-label="扫描媒体库" ${scanDisabled}>⟳</button><button class="icon-button theme-toggle" type="button" title="${themeLabel}" id="theme-toggle" aria-label="${themeLabel}" aria-pressed="${state.theme === "dark"}">${state.theme === "dark" ? "☀" : "☾"}</button></span></div>`;
}

export function patchSidebar(): void {
  let changed = setRegionHtml(region("sidebar-library"), sidebarLibraryHtml());
  changed = setRegionHtml(region("sidebar-nav"), renderSidebarNav()) || changed;
  changed =
    setRegionHtml(
      region("sidebar-dates"),
      `<div class="section-label"><span>按日期浏览</span></div>${renderDateNavigation()}`,
    ) || changed;
  changed = setRegionHtml(region("sidebar-ai"), renderAiSidebarSection()) || changed;
  changed = setRegionHtml(region("sidebar-footer"), sidebarFooterHtml()) || changed;
  if (changed) bindSidebarEvents();
}

export function hasDateFilter(): boolean {
  return Boolean(state.datePrefix || state.dateFrom || state.dateTo);
}
