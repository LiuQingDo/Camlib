// 由 main.ts 拆分而来：仅做搬移，未改动逻辑。
import { formatCount } from "../lib/format";
import { state } from "../state";
import { renderAiSidebarSection } from "../views/ai-chat";
import { app, region, setRegionHtml } from "./context";
import { bindShellEvents, bindSidebarEvents } from "./paint";
import { escapeHtml, facetTotal, groupedFacets, selectedPrefix } from "./text";

export function renderDateNavigation(): string {
  if (!state.facets.length) return `<div class="nav-empty">扫描后会在这里显示年月</div>`;
  return `<div class="date-tree">
    <button class="date-link all-link ${!hasDateFilter() ? "is-selected" : ""}" data-prefix="" type="button"><span>全部媒体</span><span>${formatCount(facetTotal())}</span></button>
    ${groupedFacets()
      .map((yearGroup) => {
        const yearExpanded = state.expandedYears.has(yearGroup.year);
        return `<section class="year-group ${yearExpanded ? "is-expanded" : ""}">
      <div class="year-row">
        <button class="icon-button tree-toggle" type="button" data-year-toggle="${yearGroup.year}" aria-label="${yearExpanded ? "折叠" : "展开"} ${yearGroup.year} 年" aria-expanded="${yearExpanded}">${yearExpanded ? "▾" : "▸"}</button>
        <button class="date-link year-link ${selectedPrefix(state.datePrefix, yearGroup.year)}" data-prefix="${yearGroup.year}" type="button"><span>${yearGroup.year} 年</span><span>${formatCount(yearGroup.count)}</span></button>
      </div>
      ${
        yearExpanded
          ? `<div class="month-list">${yearGroup.months
              .map((monthGroup) => {
                const monthPrefix = `${yearGroup.year}-${monthGroup.month}`;
                const monthExpanded = state.expandedMonths.has(monthPrefix);
                return `<div class="month-group ${monthExpanded ? "is-expanded" : ""}">
          <div class="month-row">
            <button class="icon-button tree-toggle" type="button" data-month-toggle="${monthPrefix}" aria-label="${monthExpanded ? "折叠" : "展开"} ${Number(monthGroup.month)} 月" aria-expanded="${monthExpanded}">${monthExpanded ? "▾" : "▸"}</button>
            <button class="date-link month-link ${selectedPrefix(state.datePrefix, monthPrefix)}" data-prefix="${monthPrefix}" type="button"><span>${Number(monthGroup.month)} 月</span><span>${formatCount(monthGroup.count)}</span></button>
          </div>
          ${monthExpanded ? `<div class="day-list">${monthGroup.dates.map((facet) => `<button class="day-link ${selectedPrefix(state.datePrefix, facet.date)}" data-prefix="${facet.date}" type="button"><span>${Number(facet.date.slice(-2))} 日</span><span>${facet.count}</span></button>`).join("")}</div>` : ""}
        </div>`;
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
    <div class="sidebar-section library-section" data-region="sidebar-library"></div>
    <nav class="sidebar-section date-section" aria-label="按日期浏览" data-region="sidebar-dates"></nav>
    <div data-region="sidebar-ai"></div>
    <div class="sidebar-footer" data-region="sidebar-footer"></div>
  </aside><main class="content">
    <header class="topbar"><div class="title-block" data-region="topbar-title"></div><div class="top-actions"><div class="search-box"><span aria-hidden="true">⌕</span><input id="search-input" value="" placeholder="搜索文件名" aria-label="搜索文件名" /><kbd>/</kbd><button class="search-button" id="search-button" type="button">搜索</button></div><button class="outline-button" id="scan-top-button" type="button"></button></div></header>
    <div data-region="status"></div>
    <div class="sticky-controls"><div class="toolbar"><div class="filter-column"><div class="filter-row" data-region="filter-row"></div><div class="advanced-filters" id="advanced-filters" data-region="advanced" hidden></div></div><div class="toolbar-right" data-region="toolbar-right"></div></div><div data-region="selection"></div></div>
    <section class="media-area" aria-live="polite" data-region="media"></section></main></div>
<div id="overlay-host"><div data-overlay="preview"></div><div data-overlay="confirm"></div><div data-overlay="tag-manager"></div><div data-overlay="editor"></div><div data-overlay="merge"></div><div data-overlay="settings"></div><div data-overlay="ai-chat"></div></div>`;

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
    : `<div class="library-entry is-empty"><span class="drive-icon">＋</span><div><strong>添加媒体库</strong><span>选择一个目录开始</span></div></div>`;
  return `<div class="section-label"><span>媒体库</span>${actions}</div>${entry}`;
}

export function sidebarFooterHtml(): string {
  const status =
    state.availability === "available" ? "索引已连接" : state.availability === "unconfigured" ? "等待连接" : "等待设备";
  const scanDisabled = state.availability !== "available" ? "disabled" : "";
  const themeLabel = state.theme === "dark" ? "切换到浅色模式" : "切换到深色模式";
  return `<span class="footer-dot"></span><span>${status}</span><label class="auto-scan-toggle" title="启动时自动增量扫描"><input id="auto-scan-toggle" type="checkbox" ${state.autoScanOnStartup ? "checked" : ""} aria-label="启动时自动扫描" /><span>启动扫描</span></label><button class="icon-button" title="${state.availability === "available" ? "扫描媒体库" : "媒体库不可用"}" id="scan-button" aria-label="扫描媒体库" ${scanDisabled}>⟳</button><button class="icon-button theme-toggle" type="button" title="${themeLabel}" id="theme-toggle" aria-label="${themeLabel}" aria-pressed="${state.theme === "dark"}">${state.theme === "dark" ? "☀" : "☾"}</button><button class="icon-button" title="设置" id="settings-button" aria-label="打开设置">⚙</button>`;
}

export function patchSidebar(): void {
  let changed = setRegionHtml(region("sidebar-library"), sidebarLibraryHtml());
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
