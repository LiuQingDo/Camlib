/**
 * Pure selection-range math for Shift+click.
 *
 * Extracted from the range branch of `toggleSelection`, which previously did
 * the min/max loop inline. The loop boundaries and the "skip missing items"
 * rule are unchanged: indices outside the page simply produce no id.
 */

/** Inclusive index range between the anchor and the clicked row, in either direction. */
export function rangeIndices(anchor: number, index: number): number[] {
  const start = Math.min(anchor, index);
  const end = Math.max(anchor, index);
  const indices: number[] = [];
  for (let i = start; i <= end; i += 1) indices.push(i);
  return indices;
}

/**
 * Media ids covered by a Shift+click range. Out-of-page indices are skipped,
 * matching the original `if (item)` guard.
 */
export function collectRangeIds(items: readonly { id: string }[], anchor: number, index: number): string[] {
  const ids: string[] = [];
  for (const i of rangeIndices(anchor, index)) {
    const item = items[i];
    if (item) ids.push(item.id);
  }
  return ids;
}
