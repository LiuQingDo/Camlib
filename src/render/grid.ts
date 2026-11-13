// 由 main.ts 拆分而来：仅做搬移，未改动逻辑。
import { MediaItemDto, getMediaThumbnail } from "../api/media";
import { formatDuration, formatSize } from "../lib/format";
import { UNKNOWN_DAY } from "../lib/grid";
import { ThumbnailCancelled, cancelQueuedThumbnail, loadThumbnail, thumbnailUrlCache } from "../media/cache";
import { state } from "../state";
import { app, fragmentElement, setText } from "./context";
import { escapeHtml, formatDate, kindLabel } from "./text";

/** Shared star path — keep in sync with `.icon-star-*` in card favorite buttons. */
export const STAR_PATH = "m12 3.8 2.35 4.76 5.25.76-3.8 3.7.9 5.23L12 15.78 7.3 18.25l.9-5.23-3.8-3.7 5.25-.76L12 3.8Z";

export function starSvg(filled: boolean): string {
  return filled
    ? `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="${STAR_PATH}" fill="currentColor"/></svg>`
    : `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="${STAR_PATH}" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>`;
}

export function starsHtml(rating: number, options: { interactive?: boolean; mediaId?: string } = {}): string {
  const interactive = options.interactive ?? false;
  const stars = [1, 2, 3, 4, 5]
    .map((value) => {
      const filled = value <= rating;
      const svg = starSvg(filled);
      if (interactive) {
        return `<button type="button" class="star-button${filled ? " is-filled" : ""}" data-set-rating="${value}" data-media-id="${escapeHtml(options.mediaId ?? "")}" aria-label="${value} 星" aria-pressed="${filled}">${svg}</button>`;
      }
      return `<span class="star-glyph${filled ? " is-filled" : ""}" aria-hidden="true">${svg}</span>`;
    })
    .join("");
  return `<span class="star-row" role="img" aria-label="评分 ${rating} / 5">${stars}${rating === 0 ? `<span class="star-empty-label">未评分</span>` : ""}</span>`;
}

export function cardRatingHtml(rating: number): string {
  if (rating <= 0) return "";
  return `<span class="card-rating" data-rating="${rating}" title="评分 ${rating} 星" aria-label="评分 ${rating} 星">${Array.from({ length: rating }, () => starSvg(true)).join("")}</span>`;
}

export function renderCard(item: MediaItemDto, index: number): string {
  const isVideo = item.kind === "video";
  const selected = state.selectedIds.has(item.id);
  // `state.favorites` is seeded from the list query's `favorite` projection and
  // updated optimistically on toggle — no per-card detail fetch.
  const favorite = state.favorites.has(item.id);
  const favoritePending = state.favoritePendingIds.has(item.id);
  const durationMs = item.durationMs != null && item.durationMs > 0 ? item.durationMs : null;
  const durationBadge = durationMs != null ? `<span class="duration-badge">${formatDuration(durationMs)}</span>` : "";
  const cachedThumb = thumbnailUrlCache.get(item.id);
  const previewContent = cachedThumb
    ? `<img src="${escapeHtml(cachedThumb)}" alt="" decoding="async" />${isVideo ? `<span class="video-overlay">▶</span>` : ""}`
    : isVideo
      ? `<span class="video-placeholder"><span class="play-mark">▶</span><span>视频</span></span>`
      : `<span class="preview-skeleton" aria-hidden="true"></span>`;
  return `<article class="media-card ${selected ? "is-selected" : ""}" data-action="open-media" data-id="${escapeHtml(item.id)}" data-index="${index}" tabindex="0" role="group" aria-label="${escapeHtml(item.displayName)}">
    <div class="card-preview ${isVideo ? "is-video" : ""}${cachedThumb ? " has-preview" : ""}" data-preview="${escapeHtml(item.id)}"${cachedThumb ? ' data-loaded="true"' : ""}>${previewContent}<div class="card-actions"><button class="card-action card-select ${selected ? "is-checked" : ""}" data-action="toggle-select" data-id="${escapeHtml(item.id)}" type="button" aria-label="${selected ? "取消选择" : "选择"}${escapeHtml(item.displayName)}" aria-pressed="${selected}"><svg class="icon-check" viewBox="0 0 24 24" aria-hidden="true"><path d="M5.5 12.5 10 17l8.5-9" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg></button><button class="card-action card-favorite ${favorite ? "is-favorite" : ""} ${favoritePending ? "is-pending" : ""}" data-action="toggle-favorite" data-id="${escapeHtml(item.id)}" type="button" aria-label="${favorite ? "取消收藏" : "收藏"}${escapeHtml(item.displayName)}" aria-pressed="${favorite}" aria-busy="${favoritePending}" ${favoritePending ? "disabled" : ""}><svg class="icon-star-outline" viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3.8 2.35 4.76 5.25.76-3.8 3.7.9 5.23L12 15.78 7.3 18.25l.9-5.23-3.8-3.7 5.25-.76L12 3.8Z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg><svg class="icon-star-fill" viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3.8 2.35 4.76 5.25.76-3.8 3.7.9 5.23L12 15.78 7.3 18.25l.9-5.23-3.8-3.7 5.25-.76L12 3.8Z" fill="currentColor"/></svg></button></div><span class="kind-badge kind-${item.kind}">${kindLabel(item.kind)}</span>${item.scanState !== "present" ? `<span class="state-badge">${item.scanState === "missing" ? "离线" : "需检查"}</span>` : ""}${item.burstGroup ? `<span class="burst-badge">连拍</span>` : ""}${durationBadge}</div>
    <div class="card-info"><div class="card-title" title="${escapeHtml(item.displayName)}">${escapeHtml(item.displayName)}</div><div class="card-meta"><span data-meta="date">${formatDate(item.captureDate)}</span><span data-meta="size">${formatSize(item.totalSizeBytes)}</span>${cardRatingHtml(item.rating)}</div></div>
  </article>`;
}

export function createDayGroup(date: string): HTMLElement {
  const section = document.createElement("section");
  section.className = "media-day-group";
  section.dataset.day = date;
  section.innerHTML = `<header class="day-heading"><h2></h2><span></span></header><div class="media-grid"></div>`;
  return section;
}

export function patchDayGroupHeader(section: HTMLElement, date: string, count: number): void {
  setText(section.querySelector(".day-heading h2"), date === UNKNOWN_DAY ? "日期未知" : formatDate(date));
  setText(section.querySelector(".day-heading span"), `${count} 个项目`);
}

/**
 * 卡片字段级 patch：只改这一个 id 真正变化的字段。
 * 缩略图 <img> 一律不动——节点留着，浏览器就不会重新解码。
 */
export function patchCardNode(card: HTMLElement, item: MediaItemDto, index: number): void {
  if (card.dataset.index !== String(index)) card.dataset.index = String(index);
  const selected = state.selectedIds.has(item.id);
  card.classList.toggle("is-selected", selected);
  const select = card.querySelector<HTMLButtonElement>(".card-select");
  if (select) {
    select.classList.toggle("is-checked", selected);
    select.setAttribute("aria-pressed", String(selected));
    select.setAttribute("aria-label", `${selected ? "取消选择" : "选择"}${item.displayName}`);
  }
  const favorite = state.favorites.has(item.id);
  const pending = state.favoritePendingIds.has(item.id);
  const favoriteButton = card.querySelector<HTMLButtonElement>('[data-action="toggle-favorite"]');
  if (favoriteButton) {
    favoriteButton.classList.toggle("is-favorite", favorite);
    favoriteButton.classList.toggle("is-pending", pending);
    if (favoriteButton.disabled !== pending) favoriteButton.disabled = pending;
    favoriteButton.setAttribute("aria-pressed", String(favorite));
    favoriteButton.setAttribute("aria-busy", String(pending));
    favoriteButton.setAttribute("aria-label", `${favorite ? "取消收藏" : "收藏"}${item.displayName}`);
  }
  const title = card.querySelector<HTMLElement>(".card-title");
  setText(title, item.displayName);
  if (title && title.getAttribute("title") !== item.displayName) title.setAttribute("title", item.displayName);
  setText(card.querySelector('[data-meta="date"]'), formatDate(item.captureDate));
  setText(card.querySelector('[data-meta="size"]'), formatSize(item.totalSizeBytes));
  patchCardRating(card, item.rating);
  patchCardBadges(card, item);
}

export function patchCardRating(card: HTMLElement, rating: number): void {
  const meta = card.querySelector<HTMLElement>(".card-meta");
  if (!meta) return;
  const current = meta.querySelector<HTMLElement>(".card-rating");
  if (rating <= 0) {
    current?.remove();
    return;
  }
  if (!current) {
    meta.insertAdjacentHTML("beforeend", cardRatingHtml(rating));
    return;
  }
  if (current.dataset.rating === String(rating)) return;
  current.dataset.rating = String(rating);
  current.innerHTML = Array.from({ length: rating }, () => starSvg(true)).join("");
  current.title = `评分 ${rating} 星`;
  current.setAttribute("aria-label", `评分 ${rating} 星`);
}

/** 角标：类型 / 离线状态 / 连拍 / 时长。只在字段真的变了时增删。 */
export function patchCardBadges(card: HTMLElement, item: MediaItemDto): void {
  const preview = card.querySelector<HTMLElement>(".card-preview");
  if (!preview) return;
  const kind = preview.querySelector<HTMLElement>(".kind-badge");
  if (kind) {
    setText(kind, kindLabel(item.kind));
    kind.className = `kind-badge kind-${item.kind}`;
  }
  const stateBadge = preview.querySelector<HTMLElement>(".state-badge");
  if (item.scanState !== "present") {
    const label = item.scanState === "missing" ? "离线" : "需检查";
    if (stateBadge) setText(stateBadge, label);
    else preview.insertAdjacentHTML("beforeend", `<span class="state-badge">${label}</span>`);
  } else stateBadge?.remove();

  const burstBadge = preview.querySelector<HTMLElement>(".burst-badge");
  if (item.burstGroup) {
    if (!burstBadge) preview.insertAdjacentHTML("beforeend", `<span class="burst-badge">连拍</span>`);
  } else burstBadge?.remove();

  const durationMs = item.durationMs != null && item.durationMs > 0 ? item.durationMs : null;
  const durationBadge = preview.querySelector<HTMLElement>(".duration-badge");
  if (durationMs != null) {
    if (durationBadge) setText(durationBadge, formatDuration(durationMs));
    else preview.insertAdjacentHTML("beforeend", `<span class="duration-badge">${formatDuration(durationMs)}</span>`);
  } else durationBadge?.remove();
}

/** 卡片节点回收池：离屏卡片不销毁，回到窗口里时直接换内容。 */
export const cardPool: HTMLElement[] = [];

/** 池上限：一次窗口切换最多换掉这么多节点，再多也没有复用机会。 */
export const CARD_POOL_LIMIT = 128;

/**
 * 交还卡片节点：先撤掉它排队中的缩略图请求，再清空内容。
 * 清空子节点是为了让解码后的位图能被回收——只留 <article> 壳。
 */
export function releaseCardNode(card: HTMLElement): void {
  const id = card.dataset.id;
  if (id) cancelQueuedThumbnail(id);
  card.remove();
  card.replaceChildren();
  // 复用前必须忘掉装载/观察标记，否则滚回来的卡片会一直被当成“已加载”。
  for (const attribute of Array.from(card.attributes)) {
    if (attribute.name !== "class") card.removeAttribute(attribute.name);
  }
  if (cardPool.length < CARD_POOL_LIMIT) cardPool.push(card);
}

/** 复用节点换 id：内容整份按新 item 重写，节点（以及委托链）保持不变。 */
export function recycleCardNode(card: HTMLElement, item: MediaItemDto, index: number): void {
  const fresh = fragmentElement(renderCard(item, index));
  if (!fresh) return;
  card.replaceChildren(...Array.from(fresh.childNodes));
  Array.from(fresh.attributes).forEach((attribute) => card.setAttribute(attribute.name, attribute.value));
}

/** 单日卡片列表 keyed reconcile；返回新建（含复用重写）的卡片数量。 */
export function patchCardList(grid: HTMLElement, items: MediaItemDto[], startIndex: number): number {
  const existing = new Map<string, HTMLElement>();
  grid.querySelectorAll<HTMLElement>(":scope > .media-card").forEach((card) => {
    const id = card.dataset.id;
    if (id) existing.set(id, card);
    else releaseCardNode(card);
  });
  let created = 0;
  let index = startIndex;
  // 首行偏移占位格（部分渲染的天分组才有）不是卡片，插入点必须在它之后。
  const rowOffset = grid.querySelector<HTMLElement>(":scope > .grid-row-offset");
  let cursor: Element | null = rowOffset ? rowOffset.nextElementSibling : grid.firstElementChild;
  for (const item of items) {
    let card: HTMLElement | null | undefined = existing.get(item.id);
    if (card) {
      existing.delete(item.id);
      patchCardNode(card, item, index);
    } else {
      const pooled = cardPool.pop() ?? null;
      if (pooled) {
        // 池里的节点带着上一个 item 的内容与标记，必须整份重写。
        recycleCardNode(pooled, item, index);
      }
      card = pooled ?? fragmentElement(renderCard(item, index));
      if (!card) {
        index += 1;
        continue;
      }
      created += 1;
    }
    if (card === cursor) cursor = cursor.nextElementSibling;
    else grid.insertBefore(card, cursor);
    index += 1;
  }
  // 剩下的都是已经滚出窗口的节点——进回收池，不销毁。
  for (const stale of existing.values()) releaseCardNode(stale);
  return created;
}

export function applyThumbnailToCard(id: string, asset: Awaited<ReturnType<typeof getMediaThumbnail>>): void {
  thumbnailUrlCache.set(id, asset.url);
  const target = [...app.querySelectorAll<HTMLElement>("[data-preview]")].find(
    (element) => element.dataset.preview === id,
  );
  const item = state.page.items.find((entry) => entry.id === id);
  if (!target || !item) return;
  target.classList.add("has-preview");
  target
    .querySelector(".preview-skeleton, .preview-loading, .video-placeholder, .preview-fallback-row, .preview-fallback")
    ?.remove();
  const existing = target.querySelector("img");
  if (existing) {
    existing.src = asset.url;
  } else {
    const image = document.createElement("img");
    image.src = asset.url;
    image.alt = "";
    image.decoding = "async";
    target.prepend(image);
  }
  if (item.kind === "video" && !target.querySelector(".video-overlay")) {
    const overlay = document.createElement("span");
    overlay.className = "video-overlay";
    overlay.textContent = "▶";
    target.append(overlay);
  }
}

export function markThumbnailRetryable(id: string): void {
  const target = app.querySelector<HTMLElement>(`[data-preview="${CSS.escape(id)}"]`);
  if (!target) return;
  delete target.dataset.loaded;
  target
    .querySelector(".preview-skeleton, .preview-loading, .video-placeholder, .preview-fallback-row, .preview-fallback")
    ?.remove();
  if (!target.querySelector(".preview-fallback-row")) {
    target.insertAdjacentHTML(
      "afterbegin",
      `<div class="preview-fallback-row"><span class="preview-fallback">预览失败</span><button class="preview-retry" type="button" data-retry-thumbnail="${escapeHtml(id)}">重试</button></div>`,
    );
  }
}

export let previewObserver: IntersectionObserver | null = null;

export function observePreviews(): void {
  const cards = [...app.querySelectorAll<HTMLElement>("[data-preview]")];
  const load = (card: HTMLElement, highPriority = false) => {
    if (card.dataset.loaded === "true") return;
    card.dataset.loaded = "true";
    const id = card.dataset.preview;
    if (!id) return;
    void loadThumbnail(id, highPriority)
      .then((asset) => applyThumbnailToCard(id, asset))
      // 卡片已滚出窗口而被撤单：不是失败，别给它挂"预览失败"。
      .catch((error: unknown) => {
        if (!(error instanceof ThumbnailCancelled)) markThumbnailRetryable(id);
      });
  };
  // Start the actual viewport synchronously and put it ahead of work left over
  // from a previous filter/page. The observer then prefetches the next rows.
  cards
    .filter((card) => {
      const rect = card.getBoundingClientRect();
      return rect.bottom >= 0 && rect.top <= window.innerHeight;
    })
    .reverse()
    .forEach((card) => load(card, true));
  if ("IntersectionObserver" in window) {
    // 观察器只建一次：窗口化之后卡片进出是常态，反复 disconnect/重挂会把
    // 还没进视口的卡片重新排一遍队，白白多出一轮 IPC。
    previewObserver ??= new IntersectionObserver(
      (entries) =>
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          load(entry.target as HTMLElement, entry.intersectionRatio > 0);
          previewObserver?.unobserve(entry.target);
        }),
      { rootMargin: "320px" },
    );
    cards.forEach((card) => {
      if (card.dataset.loaded === "true" || card.dataset.io === "1") return;
      card.dataset.io = "1";
      previewObserver?.observe(card);
    });
  } else cards.slice(0, 24).forEach((card) => load(card));
}
