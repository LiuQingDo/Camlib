/**
 * Pure filter helpers.
 *
 * `hasAnyFilter` / `secondaryFilterParts` used to read the module-level `state`
 * directly; they now take the filter slice as an argument so they can be tested
 * without booting the app. `AppState` still satisfies `FilterState`
 * structurally, so call sites just pass `state`.
 */

/** The subset of app state the filter predicates care about. */
export interface FilterState {
  search: string;
  kind: string | undefined;
  favoriteOnly: boolean;
  burstOnly: boolean;
  datePrefix: string | undefined;
  dateFrom: string | undefined;
  dateTo: string | undefined;
  firstSeenFrom: string | null;
  /** Selected tag ids; a `Set` so the chip order follows the click order. */
  tagIds: ReadonlySet<string>;
  /** Tag id → name lookup for chip labels (`AppState.tags` satisfies it). */
  tags: ReadonlyArray<{ id: string; name: string }>;
  /** Exact rating filter; null = any. 0 = unrated only. */
  ratingEq: number | null;
  /** Minimum rating filter; null = any. */
  ratingMin: number | null;
  semanticSearch: string | null;
}

/**
 * 条件 chip 的分类。key 既是 chips 的固定顺序依据，也是逐项移除时
 * `data-remove-filter="<key>:<value>"` 的分支依据。
 */
export type FilterChipKey = "kind" | "favorite" | "burst" | "tag" | "date" | "rating" | "semantic";

/** 一个已生效的筛选条件，可渲染成可移除的 chip。 */
export interface FilterChip {
  key: FilterChipKey;
  /** 展示文案（已本地化，直接进 DOM 前仍需 escapeHtml）。 */
  label: string;
  /** 原始值：tag 是 id，date 是前缀或区间，rating 是 `min:n` / `eq:n` / `unrated`。 */
  value: string;
}

/** `".DNG, lrv ,"` → `[".dng", ".lrv"]`. */
export function parseExtensionsInput(value: string): string[] {
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => (part.startsWith(".") ? part.toLowerCase() : `.${part.toLowerCase()}`));
}

export function extensionsToInput(list: string[]): string {
  return list.join(", ");
}

function kindText(kind: string): string {
  return kind === "photo" ? "照片" : kind === "video" ? "视频" : "实况";
}

/** `2025` → `2025 年`；`2025-03` → `2025 年 3 月`；`2025-03-05` → `2025 年 3 月 5 日`。 */
export function formatDatePrefix(prefix: string): string {
  const parts = prefix.split("-");
  const [year, month, day] = parts;
  if (!year) return prefix;
  if (parts.length === 1) return `${year} 年`;
  if (parts.length === 2) return `${year} 年 ${Number(month)} 月`;
  return `${year} 年 ${Number(month)} 月 ${Number(day)} 日`;
}

/** True when any primary or secondary filter narrows the current result set. */
export function hasAnyFilter(state: FilterState): boolean {
  return Boolean(state.search || state.kind || state.datePrefix || state.dateFrom || state.dateTo || state.favoriteOnly || state.burstOnly || state.firstSeenFrom || state.tagIds.size || state.ratingEq !== null || state.ratingMin !== null || state.semanticSearch);
}

/**
 * True when something other than the search term narrows the result set.
 * The empty state uses it to decide whether「清除筛选，保留搜索词」is a
 * meaningful exit — with a bare search term there is no filter to drop.
 */
export function hasNonSearchFilter(state: FilterState): boolean {
  return Boolean(
    state.kind ||
    state.datePrefix ||
    state.dateFrom ||
    state.dateTo ||
    state.favoriteOnly ||
    state.burstOnly ||
    state.firstSeenFrom ||
    state.tagIds.size ||
    state.ratingEq !== null ||
    state.ratingMin !== null ||
    state.semanticSearch,
  );
}

/**
 * Every condition the current query actually applies, in toolbar order.
 * The empty state prints these verbatim so a zero-result page explains
 * itself instead of asking the user to guess which filter is too narrow.
 */
export function activeFilterParts(state: FilterState): string[] {
  const parts: string[] = [];
  if (state.semanticSearch) parts.push(`AI 搜索「${state.semanticSearch}」`);
  if (state.search) parts.push(`搜索「${state.search}」`);
  if (state.kind) parts.push(`类型：${kindText(state.kind)}`);
  if (state.favoriteOnly) parts.push("仅收藏");
  if (state.burstOnly) parts.push("仅连拍");
  if (state.tagIds.size) parts.push(`标签 ${state.tagIds.size} 个`);
  if (state.datePrefix) parts.push(`日期：${state.datePrefix}`);
  else if (state.dateFrom || state.dateTo) {
    parts.push(`日期：${state.dateFrom ?? "最早"} ~ ${state.dateTo ?? "最新"}`);
  }
  if (state.firstSeenFrom) parts.push("仅新导入");
  if (state.ratingEq !== null) parts.push(state.ratingEq === 0 ? "未评分" : `评分 ${state.ratingEq} 星`);
  else if (state.ratingMin !== null) parts.push(`评分 ≥ ${state.ratingMin} 星`);
  return parts;
}

/** tag id → 名称；标签刚被删掉时退回 id，chip 至少还能点掉。 */
function tagNameOf(state: FilterState, id: string): string {
  return state.tags.find((tag) => tag.id === id)?.name ?? id;
}

/**
 * 面板内条件的数量：标签 / 日期 / 评分 / AI。
 *
 * 「筛选 (n)」与面板顶部的「已选 n 项」都只数这四个——类型 / 收藏 / 连拍
 * 在主行已经各有一枚 chip，再算进来会让数字对不上用户看到的「面板里选了几项」。
 */
export function panelFilterCount(state: FilterState): number {
  let count = state.tagIds.size;
  if (state.datePrefix || state.dateFrom || state.dateTo) count += 1;
  if (state.ratingEq !== null || state.ratingMin !== null) count += 1;
  if (state.semanticSearch) count += 1;
  return count;
}

/**
 * 已生效条件 → 可移除的 chips，顺序固定为
 * 类型 → 收藏 → 连拍 → 标签 → 日期 → 评分 → AI。
 *
 * 收藏 / 连拍 / 类型在主行也有开关，这里仍然各占一枚 chip：主行是「改」的入口，
 * chips 是「看当前查询到底是什么、并逐项摘掉」的入口，两者语义不同。
 * 「最近导入」不在这个序列里——它有自己的常驻横幅，且是一次性入口而非可叠加条件。
 */
export function secondaryFilterParts(state: FilterState): FilterChip[] {
  const chips: FilterChip[] = [];
  if (state.kind) chips.push({ key: "kind", label: kindText(state.kind), value: state.kind });
  if (state.favoriteOnly) chips.push({ key: "favorite", label: "收藏", value: "1" });
  if (state.burstOnly) chips.push({ key: "burst", label: "连拍", value: "1" });
  for (const id of state.tagIds) chips.push({ key: "tag", label: tagNameOf(state, id), value: id });
  if (state.datePrefix) {
    chips.push({ key: "date", label: `日期：${formatDatePrefix(state.datePrefix)}`, value: state.datePrefix });
  } else if (state.dateFrom || state.dateTo) {
    const from = state.dateFrom ?? "";
    const to = state.dateTo ?? "";
    chips.push({
      key: "date",
      label: `日期：${from || "最早"} ~ ${to || "最新"}`,
      value: `${from}..${to}`,
    });
  }
  if (state.ratingEq === 0) chips.push({ key: "rating", label: "未评分", value: "unrated" });
  else if (state.ratingEq !== null) chips.push({ key: "rating", label: `评分 ${state.ratingEq} 星`, value: `eq:${state.ratingEq}` });
  else if (state.ratingMin !== null) chips.push({ key: "rating", label: `评分 ≥ ${state.ratingMin} 星`, value: `min:${state.ratingMin}` });
  if (state.semanticSearch) chips.push({ key: "semantic", label: `AI：${state.semanticSearch}`, value: state.semanticSearch });
  return chips;
}
