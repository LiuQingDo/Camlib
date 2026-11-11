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
  /** Anything with a `size`, i.e. the selected tag id set. */
  tagIds: { size: number };
  /** Exact rating filter; null = any. 0 = unrated only. */
  ratingEq: number | null;
  /** Minimum rating filter; null = any. */
  ratingMin: number | null;
  semanticSearch: string | null;
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

/** True when any primary or secondary filter narrows the current result set. */
export function hasAnyFilter(state: FilterState): boolean {
  return Boolean(state.search || state.kind || state.datePrefix || state.dateFrom || state.dateTo || state.favoriteOnly || state.burstOnly || state.firstSeenFrom || state.tagIds.size || state.ratingEq !== null || state.ratingMin !== null || state.semanticSearch);
}

/** Secondary toolbar conditions live under the collapsible「筛选」panel. */
export function secondaryFilterParts(state: FilterState): string[] {
  const parts: string[] = [];
  if (state.semanticSearch) parts.push("语义搜索");
  if (state.tagIds.size) parts.push(`标签×${state.tagIds.size}`);
  if (state.datePrefix || state.dateFrom || state.dateTo) parts.push("日期");
  if (state.firstSeenFrom) parts.push("新导入");
  if (state.ratingEq !== null || state.ratingMin !== null) parts.push("评分");
  return parts;
}
