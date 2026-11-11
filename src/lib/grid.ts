/**
 * Grid layout helpers (pure, no DOM).
 *
 * The media grid is rendered as day groups: `.media-day-group[data-day]` >
 * `.media-grid` > `.media-card[data-id]`. Both layers are reconciled by key, so
 * the grouping step has to be deterministic and order-preserving — a card that
 * stays in the same day group has to stay on the same DOM node.
 */

/** Anything carrying a capture date; keeps the helper testable without DTO imports. */
export interface DateGroupable {
  captureDate: string | null;
}

export interface DayGroup<T extends DateGroupable = DateGroupable> {
  /** `YYYY-MM-DD`, or `"unknown"` when the capture date is missing. */
  date: string;
  items: T[];
}

export const UNKNOWN_DAY = "unknown";

/**
 * Group media rows into day buckets while preserving input order.
 *
 * Order matters twice over: the upstream query defines the sort mode (newest /
 * name / size), and the reconciler uses it to decide where to insert new cards.
 * Items without a capture date share one bucket, positioned where the first of
 * them appeared in the result set.
 */
export function groupItemsByDay<T extends DateGroupable>(items: readonly T[]): Array<DayGroup<T>> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = item.captureDate ?? UNKNOWN_DAY;
    const bucket = groups.get(key);
    if (bucket) bucket.push(item);
    else groups.set(key, [item]);
  }
  return [...groups.entries()].map(([date, entries]) => ({ date, items: entries }));
}
