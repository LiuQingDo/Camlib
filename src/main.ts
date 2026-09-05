import {
  type DateFacetDto,
  type LibraryDto,
  type MediaItemDto,
  type MediaKind,
  type MediaPageDto,
  getMediaAsset,
  listDateFacets,
  listLibraries,
  onScanProgress,
  queryMedia,
  startLibraryScan,
} from "./api/media";
import { getInfrastructureState, setLibraryRoot, type LibraryAvailability } from "./api/infrastructure";
import type { ScanProgressDto } from "./api/media";

type SortMode = "newest" | "oldest" | "name";
type Density = 1 | 2 | 3 | 4 | 5;

interface AppState {
  availability: LibraryAvailability;
  rootPath: string | null;
  library: LibraryDto | null;
  facets: DateFacetDto[];
  page: MediaPageDto;
  search: string;
  kind: MediaKind | undefined;
  datePrefix: string | undefined;
  sort: SortMode;
  density: Density;
  loading: boolean;
  scanning: boolean;
  scanProgress: ScanProgressDto | null;
  error: string | null;
  previewIndex: number | null;
}

const state: AppState = {
  availability: "unconfigured",
  rootPath: null,
  library: null,
  facets: [],
  page: { items: [], total: 0, offset: 0, limit: 120 },
  search: "",
  kind: undefined,
  datePrefix: undefined,
  sort: "newest",
  density: 3,
  loading: true,
  scanning: false,
  scanProgress: null,
  error: null,
  previewIndex: null,
};

const appRoot = document.querySelector<HTMLElement>("#app");
if (!appRoot) throw new Error("找不到应用容器");
const app: HTMLElement = appRoot;
let searchTimer: number | undefined;

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character] ?? character);
}

function formatDate(date: string | null): string {
  if (!date) return "日期未知";
  const parts = date.split("-");
  return parts.length === 3 ? `${parts[0]}年${Number(parts[1])}月${Number(parts[2])}日` : date;
}

function formatCount(value: number): string { return new Intl.NumberFormat("zh-CN").format(value); }
function formatSize(bytes: number): string { return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`; }
function kindLabel(kind: MediaKind): string { return kind === "photo" ? "照片" : kind === "video" ? "视频" : "实况"; }
function selectedPrefix(prefix: string | undefined, value: string): string { return prefix === value ? "is-selected" : ""; }

function groupedFacets(): Array<{ year: string; count: number; months: Array<{ month: string; count: number; dates: DateFacetDto[] }> }> {
  const years = new Map<string, { count: number; months: Map<string, { count: number; dates: DateFacetDto[] }> }>();
  for (const facet of state.facets) {
    const [year, month] = facet.date.split("-");
    if (!year || !month) continue;
    const yearGroup = years.get(year) ?? { count: 0, months: new Map() };
    const monthGroup = yearGroup.months.get(month) ?? { count: 0, dates: [] };
    yearGroup.count += facet.count;
    monthGroup.count += facet.count;
    monthGroup.dates.push(facet);
    yearGroup.months.set(month, monthGroup);
    years.set(year, yearGroup);
  }
  return [...years.entries()].map(([year, value]) => ({ year, count: value.count, months: [...value.months.entries()].map(([month, monthValue]) => ({ month, count: monthValue.count, dates: monthValue.dates })) }));
}

function renderDateNavigation(): string {
  if (!state.facets.length) return `<div class="nav-empty">扫描后会在这里显示年月</div>`;
  return `<div class="date-tree">
    <button class="date-link all-link ${state.datePrefix ? "" : "is-selected"}" data-prefix="" type="button"><span>全部媒体</span><span>${formatCount(state.page.total)}</span></button>
    ${groupedFacets().map((yearGroup) => `<section class="year-group">
      <button class="date-link year-link ${selectedPrefix(state.datePrefix, yearGroup.year)}" data-prefix="${yearGroup.year}" type="button"><span>${yearGroup.year} 年</span><span>${formatCount(yearGroup.count)}</span></button>
      <div class="month-list">${yearGroup.months.map((monthGroup) => {
        const monthPrefix = `${yearGroup.year}-${monthGroup.month}`;
        return `<div class="month-group"><button class="date-link month-link ${selectedPrefix(state.datePrefix, monthPrefix)}" data-prefix="${monthPrefix}" type="button"><span>${Number(monthGroup.month)} 月</span><span>${formatCount(monthGroup.count)}</span></button><div class="day-list">${monthGroup.dates.map((facet) => `<button class="day-link ${selectedPrefix(state.datePrefix, facet.date)}" data-prefix="${facet.date}" type="button"><span>${Number(facet.date.slice(-2))} 日</span><span>${facet.count}</span></button>`).join("")}</div></div>`;
      }).join("")}</div>
    </section>`).join("")}
  </div>`;
}

function renderCard(item: MediaItemDto, index: number): string {
  const isVideo = item.kind === "video";
  return `<article class="media-card" data-id="${escapeHtml(item.id)}" data-index="${index}" tabindex="0" role="button" aria-label="打开${escapeHtml(item.displayName)}">
    <div class="card-preview ${isVideo ? "is-video" : ""}" data-preview="${escapeHtml(item.id)}">${isVideo ? `<span class="video-placeholder"><span class="play-mark">▶</span><span>视频</span></span>` : `<span class="preview-loading">加载预览</span>`}<span class="kind-badge kind-${item.kind}">${kindLabel(item.kind)}</span>${item.scanState !== "present" ? `<span class="state-badge">${item.scanState === "missing" ? "离线" : "需检查"}</span>` : ""}</div>
    <div class="card-info"><div class="card-title" title="${escapeHtml(item.displayName)}">${escapeHtml(item.displayName)}</div><div class="card-meta"><span>${formatDate(item.captureDate)}</span><span>${formatSize(item.totalSizeBytes)}</span></div></div>
  </article>`;
}

function renderMediaGrid(): string {
  const groups = new Map<string, MediaItemDto[]>();
  for (const item of state.page.items) {
    const key = item.captureDate ?? "unknown";
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  let index = 0;
  return [...groups.entries()].map(([date, items]) => `<section class="media-day-group"><header class="day-heading"><h2>${date === "unknown" ? "日期未知" : formatDate(date)}</h2><span>${items.length} 个项目</span></header><div class="media-grid">${items.map((item) => renderCard(item, index++)).join("")}</div></section>`).join("");
}

function renderKindFilters(): string {
  return ([{ value: undefined, label: "全部" }, { value: "photo" as MediaKind, label: "照片" }, { value: "video" as MediaKind, label: "视频" }, { value: "live" as MediaKind, label: "实况" }]).map((filter) => `<button class="filter-chip ${state.kind === filter.value ? "is-active" : ""}" type="button" data-kind="${filter.value ?? ""}">${filter.label}</button>`).join("");
}

function renderStatusBanner(): string {
  if (state.scanning && state.scanProgress) {
    const progress = state.scanProgress.total > 0 ? Math.round((state.scanProgress.processed / state.scanProgress.total) * 100) : 0;
    const phase = state.scanProgress.phase === "discovering" ? "发现文件" : state.scanProgress.phase === "indexing" ? "建立索引" : "整理结果";
    return `<div class="scan-banner" role="status"><div class="scan-copy"><span class="spinner"></span><span>正在扫描媒体库 · ${phase}</span><strong>${progress}%</strong></div><div class="progress-track"><span style="width:${progress}%"></span></div>${state.scanProgress.current ? `<div class="scan-current">${escapeHtml(state.scanProgress.current)}</div>` : ""}</div>`;
  }
  if (state.availability === "disconnected") return `<div class="notice-banner is-warning"><span class="notice-icon">!</span><div><strong>媒体库已断开</strong><span>${escapeHtml(state.rootPath ?? "原媒体库")} 不可用。连接设备后点击重新扫描。</span></div><button class="text-button" id="rescan-button" type="button">重新扫描</button></div>`;
  if (state.availability === "invalid") return `<div class="notice-banner is-warning"><span class="notice-icon">!</span><div><strong>媒体库路径无效</strong><span>请重新设置一个可访问的媒体库目录。</span></div></div>`;
  if (state.error) return `<div class="notice-banner is-error"><span class="notice-icon">!</span><span>${escapeHtml(state.error)}</span></div>`;
  return "";
}

function renderLibraryEmpty(): string {
  if (state.loading) return `<div class="empty-state"><span class="empty-icon spinner large"></span><h2>正在读取媒体库</h2><p>正在从 Tauri 后端加载索引。</p></div>`;
  if (state.availability === "unconfigured") return `<div class="empty-state setup-state"><span class="empty-icon">⌂</span><h2>还没有媒体库</h2><p>输入一个本地媒体目录，Camlib 会建立可搜索的索引。</p><form id="library-form" class="library-form"><input id="library-path" required placeholder="例如：D:\\照片" aria-label="媒体库路径" /><button class="primary-button" type="submit">连接媒体库</button></form></div>`;
  if (!state.library) return `<div class="empty-state"><span class="empty-icon">◎</span><h2>找不到媒体库记录</h2><p>请重新连接媒体库。</p></div>`;
  if (!state.page.total) return `<div class="empty-state"><span class="empty-icon">✦</span><h2>${state.search || state.kind || state.datePrefix ? "没有匹配的媒体" : "媒体库还是空的"}</h2><p>${state.search || state.kind || state.datePrefix ? "试试调整搜索或筛选条件。" : "点击右上角“扫描媒体库”开始建立索引。"}</p></div>`;
  return "";
}

function render(): void {
  const hasItems = state.page.items.length > 0;
  app.style.setProperty("--tile-min", `${[150, 185, 220, 260, 310][state.density - 1]}px`);
  app.innerHTML = `<div class="shell"><aside class="sidebar">
    <div class="brand"><span class="brand-mark">C</span><div><strong>Camlib</strong><span>媒体库</span></div></div>
    <div class="sidebar-section library-section"><div class="section-label"><span>媒体库</span>${state.library ? `<button class="icon-button" id="refresh-button" title="刷新状态" aria-label="刷新状态">↻</button>` : ""}</div>${state.library ? `<div class="library-entry ${state.availability !== "available" ? "is-offline" : ""}"><span class="drive-icon">▣</span><div><strong>${escapeHtml(state.library.volumeLabel || state.library.driveLetter ? `${state.library.volumeLabel ?? "本地磁盘"} ${state.library.driveLetter ? `(${state.library.driveLetter}:)` : ""}` : "已连接媒体库")}</strong><span>${state.availability === "available" ? `${formatCount(state.page.total)} 个媒体` : "暂时不可用"}</span></div><span class="status-dot"></span></div>` : `<div class="library-entry is-empty"><span class="drive-icon">＋</span><div><strong>添加媒体库</strong><span>选择一个目录开始</span></div></div>`}</div>
    <div class="sidebar-section date-section"><div class="section-label"><span>按日期浏览</span></div>${renderDateNavigation()}</div>
    <div class="sidebar-footer"><span class="footer-dot"></span><span>${state.availability === "available" ? "索引已连接" : state.availability === "unconfigured" ? "等待连接" : "等待设备"}</span><button class="icon-button" title="扫描媒体库" id="scan-button" aria-label="扫描媒体库">⟳</button></div>
  </aside><main class="content">
    <header class="topbar"><div class="title-block"><div class="eyebrow">${state.datePrefix ? `筛选 · ${formatDate(state.datePrefix)}` : "媒体总览"}</div><h1>${state.datePrefix ? formatDate(state.datePrefix) : "所有媒体"}</h1><span class="result-count">${formatCount(state.page.total)} 个项目</span></div><div class="top-actions"><label class="search-box"><span>⌕</span><input id="search-input" value="${escapeHtml(state.search)}" placeholder="搜索文件名" aria-label="搜索文件名" /><kbd>/</kbd></label><button class="outline-button" id="scan-top-button" type="button">${state.scanning ? "扫描中…" : "扫描媒体库"}</button></div></header>
    ${renderStatusBanner()}<div class="toolbar"><div class="filter-row">${renderKindFilters()}</div><div class="toolbar-right"><label class="select-wrap"><span>排序</span><select id="sort-select" aria-label="排序"><option value="newest" ${state.sort === "newest" ? "selected" : ""}>最新</option><option value="oldest" ${state.sort === "oldest" ? "selected" : ""}>最早</option><option value="name" ${state.sort === "name" ? "selected" : ""}>文件名</option></select></label><label class="density-control" title="缩略图密度"><span>▦</span><input id="density-input" type="range" min="1" max="5" value="${state.density}" aria-label="缩略图密度" /><span>▦</span></label></div></div>
    <section class="media-area" aria-live="polite">${hasItems ? `${renderMediaGrid()}${state.page.total > state.page.items.length ? `<button class="load-more" id="load-more" type="button">加载更多 · 已显示 ${state.page.items.length} / ${state.page.total}</button>` : ""}` : renderLibraryEmpty()}</section></main></div>${state.previewIndex !== null ? renderPreview() : ""}`;
  bindEvents();
  if (hasItems) observePreviews();
}

function renderPreview(): string {
  const item = state.page.items[state.previewIndex ?? 0];
  if (!item) return "";
  return `<div class="modal-backdrop" id="preview-modal"><div class="preview-modal" role="dialog" aria-modal="true" aria-label="${escapeHtml(item.displayName)}"><button class="modal-close" id="close-preview" type="button" aria-label="关闭">×</button><button class="modal-nav prev" id="preview-prev" type="button" aria-label="上一个">‹</button><div class="modal-media" id="modal-media"><span class="spinner large"></span></div><button class="modal-nav next" id="preview-next" type="button" aria-label="下一个">›</button><div class="modal-caption"><div><strong>${escapeHtml(item.displayName)}</strong><span>${kindLabel(item.kind)} · ${formatDate(item.captureDate)} · ${formatSize(item.totalSizeBytes)}</span></div></div></div></div>`;
}

function bindEvents(): void {
  app.querySelectorAll<HTMLButtonElement>("[data-prefix]").forEach((button) => button.addEventListener("click", () => { state.datePrefix = button.dataset.prefix || undefined; void refreshMedia(); }));
  app.querySelectorAll<HTMLButtonElement>("[data-kind]").forEach((button) => button.addEventListener("click", () => { state.kind = (button.dataset.kind || undefined) as MediaKind | undefined; void refreshMedia(); }));
  const searchInput = app.querySelector<HTMLInputElement>("#search-input");
  searchInput?.addEventListener("input", () => { state.search = searchInput.value; window.clearTimeout(searchTimer); searchTimer = window.setTimeout(() => void refreshMedia(), 250); });
  app.querySelector<HTMLSelectElement>("#sort-select")?.addEventListener("change", (event) => { state.sort = (event.target as HTMLSelectElement).value as SortMode; void refreshMedia(); });
  app.querySelector<HTMLInputElement>("#density-input")?.addEventListener("input", (event) => { state.density = Number((event.target as HTMLInputElement).value) as Density; render(); });
  app.querySelector<HTMLButtonElement>("#scan-button")?.addEventListener("click", () => void scanLibrary());
  app.querySelector<HTMLButtonElement>("#scan-top-button")?.addEventListener("click", () => void scanLibrary());
  app.querySelector<HTMLButtonElement>("#refresh-button")?.addEventListener("click", () => void bootstrap());
  app.querySelector<HTMLButtonElement>("#rescan-button")?.addEventListener("click", () => void scanLibrary());
  app.querySelector<HTMLButtonElement>("#load-more")?.addEventListener("click", () => void loadMore());
  app.querySelector<HTMLFormElement>("#library-form")?.addEventListener("submit", (event) => { event.preventDefault(); const input = app.querySelector<HTMLInputElement>("#library-path"); if (input?.value.trim()) void connectLibrary(input.value.trim()); });
  app.querySelectorAll<HTMLElement>(".media-card").forEach((card) => {
    const open = () => { state.previewIndex = Number(card.dataset.index); render(); void loadModalAsset(); };
    card.addEventListener("click", open);
    card.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); open(); } });
  });
  app.querySelector<HTMLButtonElement>("#close-preview")?.addEventListener("click", closePreview);
  app.querySelector<HTMLElement>("#preview-modal")?.addEventListener("click", (event) => { if (event.target === event.currentTarget) closePreview(); });
  app.querySelector<HTMLButtonElement>("#preview-prev")?.addEventListener("click", () => movePreview(-1));
  app.querySelector<HTMLButtonElement>("#preview-next")?.addEventListener("click", () => movePreview(1));
}

function observePreviews(): void {
  const cards = [...app.querySelectorAll<HTMLElement>("[data-preview]")];
  const load = (card: HTMLElement) => {
    if (card.classList.contains("is-video")) return;
    if (card.dataset.loaded === "true") return;
    card.dataset.loaded = "true";
    const id = card.dataset.preview;
    if (!id) return;
    void getMediaAsset(id).then((asset) => {
      const target = [...app.querySelectorAll<HTMLElement>("[data-preview]")].find((element) => element.dataset.preview === id);
      const item = state.page.items.find((entry) => entry.id === id);
      if (!target || !item) return;
      target.classList.add("has-preview");
      target.innerHTML = `<img src="data:${asset.mimeType};base64,${asset.dataBase64}" alt="" loading="lazy" />${item.kind === "video" ? `<span class="video-overlay">▶</span>` : ""}<span class="kind-badge kind-${item.kind}">${kindLabel(item.kind)}</span>`;
    }).catch(() => { card.innerHTML = `<span class="preview-fallback">预览不可用</span>`; });
  };
  if ("IntersectionObserver" in window) {
    const observer = new IntersectionObserver((entries) => entries.forEach((entry) => { if (entry.isIntersecting) { load(entry.target as HTMLElement); observer.unobserve(entry.target); } }), { rootMargin: "240px" });
    cards.forEach((card) => observer.observe(card));
  } else cards.slice(0, 24).forEach(load);
}

async function loadModalAsset(): Promise<void> {
  const item = state.previewIndex === null ? undefined : state.page.items[state.previewIndex];
  if (!item) return;
  try {
    const asset = await getMediaAsset(item.id);
    const media = app.querySelector<HTMLElement>("#modal-media");
    if (!media) return;
    media.innerHTML = asset.mimeType.startsWith("video/") ? `<video src="data:${asset.mimeType};base64,${asset.dataBase64}" controls autoplay playsinline></video>` : `<img src="data:${asset.mimeType};base64,${asset.dataBase64}" alt="${escapeHtml(item.displayName)}" />`;
  } catch { const media = app.querySelector<HTMLElement>("#modal-media"); if (media) media.innerHTML = `<span class="preview-fallback">当前文件不可用</span>`; }
}

function closePreview(): void { state.previewIndex = null; render(); }
function movePreview(delta: number): void { if (state.previewIndex === null || !state.page.items.length) return; state.previewIndex = (state.previewIndex + delta + state.page.items.length) % state.page.items.length; render(); void loadModalAsset(); }

async function refreshMedia(): Promise<void> {
  if (!state.library) { render(); return; }
  state.loading = true; state.error = null; render();
  try { state.page = await queryMedia({ libraryId: state.library.id, kind: state.kind, search: state.search, datePrefix: state.datePrefix, limit: 120, sort: state.sort }); }
  catch (error) { state.error = error instanceof Error ? error.message : "读取媒体索引失败"; }
  finally { state.loading = false; render(); }
}

async function loadMore(): Promise<void> {
  if (!state.library || state.page.items.length >= state.page.total) return;
  try { const next = await queryMedia({ libraryId: state.library.id, kind: state.kind, search: state.search, datePrefix: state.datePrefix, offset: state.page.items.length, limit: 120, sort: state.sort }); state.page.items.push(...next.items); render(); }
  catch (error) { state.error = error instanceof Error ? error.message : "加载更多媒体失败"; render(); }
}

async function connectLibrary(path: string): Promise<void> {
  state.loading = true; state.error = null; render();
  try { await setLibraryRoot(path); await bootstrap(); }
  catch (error) { state.error = error instanceof Error ? error.message : "连接媒体库失败"; state.loading = false; render(); }
}

async function scanLibrary(): Promise<void> {
  if (!state.library || state.scanning) return;
  state.error = null; state.scanning = true; state.scanProgress = null; render();
  try { const start = await startLibraryScan(state.library.id); state.scanProgress = { jobId: start.jobId, kind: "scan", seq: 0, phase: "discovering", state: "running", current: null, processed: 0, total: 0, errors: [], error: null }; render(); }
  catch (error) { state.scanning = false; state.error = error instanceof Error ? error.message : "无法开始扫描"; render(); }
}

async function bootstrap(): Promise<void> {
  state.loading = true; state.error = null; render();
  try {
    const [infra, libraries] = await Promise.all([getInfrastructureState(), listLibraries()]);
    state.availability = infra.library_status.availability; state.rootPath = infra.library_status.root_path; state.library = libraries.find((library) => library.rootPath === infra.library_status.root_path) ?? libraries[0] ?? null;
    if (state.library && state.availability === "available") { state.facets = await listDateFacets(state.library.id); await refreshMedia(); }
    else { state.page = { items: [], total: 0, offset: 0, limit: 120 }; state.facets = []; state.loading = false; render(); }
  } catch (error) { state.loading = false; state.error = error instanceof Error ? error.message : "初始化媒体库失败"; render(); }
}

window.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && state.previewIndex !== null) { closePreview(); return; }
  if (state.previewIndex !== null && event.key === "ArrowLeft") { movePreview(-1); return; }
  if (state.previewIndex !== null && event.key === "ArrowRight") { movePreview(1); return; }
  if (event.key === "/" && document.activeElement?.tagName !== "INPUT") { event.preventDefault(); app.querySelector<HTMLInputElement>("#search-input")?.focus(); }
});

void onScanProgress((progress) => {
  if (!state.scanProgress || progress.jobId !== state.scanProgress.jobId) return;
  state.scanProgress = progress;
  if (progress.state === "completed" || progress.state === "cancelled" || progress.state === "failed") { state.scanning = false; if (progress.state === "failed") state.error = progress.error ?? "扫描失败"; void bootstrap(); } else render();
});
void bootstrap();
