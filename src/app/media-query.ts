// 由 main.ts 拆分而来：仅做搬移，未改动逻辑。
import { aiSearch } from "../api/ai";
import { toUserMessage } from "../api/errors";
import { MediaPageDto, listTags, queryMedia } from "../api/media";
import { formatCount } from "../lib/format";
import { app, region } from "../render/context";
import { renderSettingsAware } from "../render/paint";
import { escapeHtml } from "../render/text";
import { applySelectionChrome, currentQueryFields, patchToolbar, scrollToContentTop } from "../render/toolbar";
import { bumpGridEpoch, patchGrid } from "../render/virtual";
import { state } from "../state";

// Bumps on every full refresh so in-flight load-more/select-all pages from a
// previous filter cannot append into the new result set.
export let mediaQueryToken = 0;

// Infinite scroll: one in-flight page load + a sentinel observer recreated per render.
export let loadMoreInFlight = false;

export let loadMoreObserver: IntersectionObserver | null = null;

/** 底部加载哨兵：idle / loading / error+retry / all-loaded 四态。 */
export function renderLoadMoreFooter(): string {
  const shown = state.page.items.length;
  const total = state.page.total;
  if (shown <= 0 || total <= 0) return "";
  if (shown >= total) {
    return `<div class="load-more-sentinel is-done" id="load-more-sentinel"><span>已显示全部 ${formatCount(total)} 项</span></div>`;
  }
  if (state.loadMoreError) {
    return `<div class="load-more-sentinel is-error" id="load-more-sentinel" role="alert"><span>${escapeHtml(state.loadMoreError)}</span><button class="load-more" id="load-more-retry" data-action="retry-load-more" type="button">重试</button></div>`;
  }
  if (loadMoreInFlight) {
    return `<div class="load-more-sentinel is-loading" id="load-more-sentinel" role="status"><span class="spinner"></span><span>正在加载更多…</span></div>`;
  }
  return `<div class="load-more-sentinel" id="load-more-sentinel"><button class="load-more" id="load-more" data-action="load-more" type="button">加载更多 · 已显示 ${formatCount(shown)} / ${formatCount(total)}</button></div>`;
}

/**
 * One media page through the active retrieval path: semantic AI search when a
 * natural-language query is committed, the plain SQL pipeline otherwise.
 */
export async function fetchMediaPage(offset: number, limit: number): Promise<MediaPageDto> {
  if (!state.library) throw new Error("媒体库未就绪");
  if (state.semanticSearch) {
    const result = await aiSearch(state.library.id, state.semanticSearch, offset, limit);
    if (offset === 0) {
      state.semanticMeta = result.parsed;
      state.semanticMode = result.mode;
    }
    return { items: result.items, total: result.total, offset: result.offset, limit: result.limit };
  }
  state.semanticMeta = null;
  state.semanticMode = null;
  return queryMedia({ ...currentQueryFields(), offset, limit });
}

export async function refreshMedia(): Promise<void> {
  if (!state.library) {
    renderSettingsAware();
    return;
  }
  const token = ++mediaQueryToken;
  // 新结果集入场：行盒与展示顺序（gridItems）全部作废，等第一次 paint 重算。
  bumpGridEpoch();
  // Abandon any in-flight load-more from the previous filter/page.
  loadMoreInFlight = false;
  state.loadMoreError = null;
  disconnectLoadMoreObserver();
  state.loading = true;
  state.error = null;
  renderSettingsAware();
  try {
    const page = await fetchMediaPage(0, 120);
    if (token !== mediaQueryToken) return;
    state.page = page;
    state.selectedIds.clear();
    state.lastSelectIndex = null;
    state.favorites = new Set(state.page.items.filter((item) => item.favorite).map((item) => item.id));
    state.ratings = new Map(state.page.items.filter((item) => item.rating > 0).map((item) => [item.id, item.rating]));
  } catch (error) {
    if (token !== mediaQueryToken) return;
    state.error = toUserMessage(error, "读取媒体索引失败");
  } finally {
    if (token === mediaQueryToken) {
      state.loading = false;
      renderSettingsAware();
      // A filter change starts a new result list; keep the viewport at the top
      // so the user does not land mid-page on unrelated items.
      if (!state.settingsOpen) scrollToContentTop();
    }
  }
}

export function disconnectLoadMoreObserver(): void {
  loadMoreObserver?.disconnect();
  loadMoreObserver = null;
}

/** Scroll root: prefer `.content` when it is the scroller; else viewport (mobile). */
export function loadMoreScrollRoot(): Element | null {
  const content = app.querySelector<HTMLElement>(".content");
  if (content && content.scrollHeight > content.clientHeight + 1) return content;
  return null;
}

export function observeLoadMore(): void {
  disconnectLoadMoreObserver();
  const sentinel = app.querySelector<HTMLElement>("#load-more-sentinel");
  if (!sentinel || state.loadMoreError || loadMoreInFlight) return;
  if (state.page.items.length >= state.page.total) return;
  if (!("IntersectionObserver" in window)) return;
  const token = mediaQueryToken;
  loadMoreObserver = new IntersectionObserver(
    (entries) => {
      if (token !== mediaQueryToken) {
        disconnectLoadMoreObserver();
        return;
      }
      if (entries.some((entry) => entry.isIntersecting)) void loadMore();
    },
    { root: loadMoreScrollRoot(), rootMargin: "200px" },
  );
  loadMoreObserver.observe(sentinel);
}

/** Patch only the media area so appended pages keep scroll + existing thumbs. */
/** 上一次写入的哨兵 HTML：内容没变就不替换节点，以免白白重建观察目标。 */
export let loadMoreFooterHtml = "";

export function updateLoadMoreFooter(): void {
  const html = renderLoadMoreFooter();
  const existing = app.querySelector<HTMLElement>("#load-more-sentinel");
  if (!html) {
    existing?.remove();
    loadMoreFooterHtml = "";
    disconnectLoadMoreObserver();
    return;
  }
  if (!existing) {
    region("media")?.insertAdjacentHTML("beforeend", html);
    loadMoreFooterHtml = html;
  } else if (html !== loadMoreFooterHtml) {
    existing.outerHTML = html;
    loadMoreFooterHtml = html;
  }
  // 哨兵内容没变也要重挂观察器：refreshMedia 上一次已经把它断开了，
  // 这里早退会让“滚动加载”静默失效。
  observeLoadMore();
}

export async function loadMore(): Promise<void> {
  if (loadMoreInFlight || state.loadMoreError) return;
  if (!state.library || state.page.items.length >= state.page.total) return;
  const token = mediaQueryToken;
  loadMoreInFlight = true;
  updateLoadMoreFooter();
  try {
    const next = await fetchMediaPage(state.page.items.length, 120);
    // Discard pages that finished after a filter switch.
    if (token !== mediaQueryToken) return;
    state.page.items.push(...next.items);
    next.items.forEach((item) => {
      if (item.favorite) state.favorites.add(item.id);
      if (item.rating > 0) state.ratings.set(item.id, item.rating);
    });
    state.loadMoreError = null;
  } catch (error) {
    if (token !== mediaQueryToken) return;
    // Keep the failure in the sentinel (persistent + retry), not the top banner.
    state.loadMoreError = toUserMessage(error, "加载更多媒体失败");
  } finally {
    if (token === mediaQueryToken) {
      loadMoreInFlight = false;
      // 只把新追加的卡片插进去；已渲染的卡片连 <img> 都不动。
      patchGrid();
    }
  }
}

export async function refreshTags(): Promise<void> {
  try {
    state.tags = await listTags();
  } catch {
    // Filter chips stay usable with the previous list; preview can still edit.
  }
}

export async function selectCurrentResults(): Promise<void> {
  if (!state.library) return;
  if (state.selectedIds.size >= state.page.total) {
    state.selectedIds.clear();
    state.lastSelectIndex = null;
    applySelectionChrome();
    return;
  }
  const token = mediaQueryToken;
  try {
    const ids = new Set<string>();
    for (let offset = 0; offset < state.page.total; offset += 500) {
      const page = await queryMedia({ ...currentQueryFields(), offset, limit: 500 });
      if (token !== mediaQueryToken) return;
      page.items.forEach((item) => ids.add(item.id));
      if (!page.items.length) break;
    }
    if (token !== mediaQueryToken) return;
    state.selectedIds = ids;
    state.lastSelectIndex = null;
    applySelectionChrome();
  } catch (error) {
    if (token !== mediaQueryToken) return;
    state.error = toUserMessage(error, "选择当前结果失败");
    patchToolbar();
  }
}
