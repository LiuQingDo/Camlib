// 由 main.ts 拆分而来：仅做搬移，未改动逻辑。
import { toUserMessage } from "../api/errors";
import { MediaItemDto, cancelVideoMerge, getMediaItem, startVideoMerge } from "../api/media";
import { formatCount } from "../lib/format";
import { loadModalThumbnail } from "../media/cache";
import { app } from "../render/context";
import { render, showTransientNotice } from "../render/paint";
import { state } from "../state";
import { mergeUpdateFooter, updateMergeModal } from "../views/dialogs";
import { refreshTags } from "./media-query";

// ---------------------------------------------------------------------------
// Video merge dialog (batch action from the selection toolbar)
// ---------------------------------------------------------------------------

/** Live drag of a merge row: the DOM moves during the drag, commit on drop. */
export let mergeDrag: { pointerId: number } | null = null;

/**
 * Snapshot the selected videos (grid order) and open the merge dialog. Items
 * selected beyond the loaded pages — e.g. after 全选当前结果 — are fetched so
 * they can be ordered too.
 */
/** 合并视频弹窗尚未增量化：改动即整块重建（footer 已单独 patch）。 */
export async function openMergeModal(): Promise<void> {
  if (!state.library || state.mergeModalOpen) return;
  const selected = new Set(state.selectedIds);
  if (selected.size < 2) return;
  const ordered: MediaItemDto[] = [];
  const excluded: string[] = [];
  const exclude = (name: string) => {
    excluded.push(name);
  };
  for (const item of state.page.items) {
    if (!selected.has(item.id)) continue;
    selected.delete(item.id);
    if (item.kind !== "video") {
      exclude(item.displayName);
      continue;
    }
    ordered.push(item);
  }
  if (selected.size) {
    try {
      const details = await Promise.all([...selected].map((id) => getMediaItem(id)));
      for (const detail of details) {
        if (detail.item.kind !== "video") {
          exclude(detail.item.displayName);
          continue;
        }
        ordered.push(detail.item);
      }
    } catch (error) {
      showTransientNotice(toUserMessage(error, "读取所选视频失败"), "error");
      return;
    }
  }
  if (ordered.length < 2) {
    showTransientNotice(excluded.length ? `「${excluded[0]}」不是视频，无法合并` : "请先选择至少两个视频", "error");
    return;
  }
  state.mergeModalOpen = true;
  state.mergeItems = ordered;
  state.mergeMode = "copy";
  state.mergeRecycleSources = false;
  state.mergeBusy = false;
  state.mergeJobId = null;
  state.mergeProgress = null;
  state.mergeError = null;
  state.mergeNotice = null;
  render();
  // Shown after render() — a full rebuild would wipe an earlier notice.
  if (excluded.length) {
    showTransientNotice(`已排除 ${formatCount(excluded.length)} 个非视频项（如「${excluded[0]}」）`, "error");
  }
}

/**
 * Close the merge dialog. A running merge is cancelled first, mirroring the
 * editor dialog where closing stops the in-flight job.
 */
export function closeMergeModal(): void {
  if (state.mergeJobId) {
    void cancelVideoMerge(state.mergeJobId).catch(() => undefined);
  }
  state.mergeModalOpen = false;
  state.mergeItems = [];
  state.mergeBusy = false;
  state.mergeJobId = null;
  state.mergeProgress = null;
  state.mergeError = null;
  state.mergeNotice = null;
  render();
}

export function mergeMoveItem(index: number, delta: number): void {
  const target = index + delta;
  if (target < 0 || target >= state.mergeItems.length) return;
  const items = state.mergeItems;
  [items[index], items[target]] = [items[target], items[index]];
  updateMergeModal();
}

export function beginMergeDrag(event: PointerEvent): void {
  if (state.mergeJobId || state.mergeBusy || mergeDrag) return;
  const handle = event.currentTarget;
  if (!(handle instanceof HTMLElement)) return;
  const row = handle.closest<HTMLElement>(".merge-row");
  const list = row?.parentElement;
  if (!row || !list) return;
  event.preventDefault();
  mergeDrag = { pointerId: event.pointerId };
  handle.setPointerCapture(event.pointerId);
  row.classList.add("is-dragging");
  document.body.classList.add("is-merge-dragging");

  const onMove = (moveEvent: PointerEvent) => {
    if (!mergeDrag || moveEvent.pointerId !== mergeDrag.pointerId) return;
    const dragged = list.querySelector<HTMLElement>(".merge-row.is-dragging");
    if (!dragged) return;
    const others = [...list.querySelectorAll<HTMLElement>(".merge-row:not(.is-dragging)")];
    const next = others.find((other) => {
      const rect = other.getBoundingClientRect();
      return moveEvent.clientY < rect.top + rect.height / 2;
    });
    if (next) list.insertBefore(dragged, next);
    else list.append(dragged);
  };
  const finish = (commit: boolean) => {
    handle.removeEventListener("pointermove", onMove);
    handle.removeEventListener("pointerup", onUp);
    handle.removeEventListener("pointercancel", onCancel);
    document.body.classList.remove("is-merge-dragging");
    if (!mergeDrag) return;
    mergeDrag = null;
    list.querySelector<HTMLElement>(".merge-row.is-dragging")?.classList.remove("is-dragging");
    if (commit) {
      const orderedIds = [...list.querySelectorAll<HTMLElement>(".merge-row")]
        .map((row) => row.dataset.itemId)
        .filter((id): id is string => Boolean(id));
      const byId = new Map(state.mergeItems.map((item) => [item.id, item] as const));
      const ordered = orderedIds.map((id) => byId.get(id)).filter((item): item is MediaItemDto => Boolean(item));
      if (ordered.length === state.mergeItems.length) state.mergeItems = ordered;
    }
    updateMergeModal();
  };
  const onUp = (upEvent: PointerEvent) => {
    if (!mergeDrag || upEvent.pointerId !== mergeDrag.pointerId) return;
    finish(true);
  };
  const onCancel = () => finish(false);
  handle.addEventListener("pointermove", onMove);
  handle.addEventListener("pointerup", onUp);
  handle.addEventListener("pointercancel", onCancel);
}

/** Fill row thumbnails from the modal cache; a failed one degrades to ∅. */
export function fillMergeThumbnails(): void {
  app.querySelectorAll<HTMLElement>("[data-merge-thumb]").forEach((slot) => {
    if (slot.dataset.thumbLoaded) return;
    const id = slot.dataset.mergeThumb;
    if (!id) return;
    slot.dataset.thumbLoaded = "1";
    void loadModalThumbnail(id)
      .then((thumbnail) => {
        const image = document.createElement("img");
        image.src = thumbnail.url;
        image.alt = "";
        image.loading = "lazy";
        image.draggable = false;
        slot.replaceChildren(image);
      })
      .catch(() => {
        slot.classList.add("is-missing");
        slot.textContent = "∅";
      });
  });
}

export async function confirmMerge(): Promise<void> {
  if (state.mergeBusy || state.mergeJobId) return;
  if (!state.library || state.mergeItems.length < 2) return;
  state.mergeError = null;
  state.mergeNotice = null;
  state.mergeBusy = true;
  // Disables the mode toggles and list while the start command round-trips.
  updateMergeModal();
  try {
    const started = await startVideoMerge(
      state.library.id,
      state.mergeItems.map((item) => item.id),
      { mode: state.mergeMode, recycleSources: state.mergeRecycleSources },
    );
    state.mergeJobId = started.jobId;
    // Flip to the progress footer right away instead of waiting for the
    // first running event.
    mergeUpdateFooter();
  } catch (error) {
    state.mergeError = toUserMessage(error, "启动合并失败");
  } finally {
    state.mergeBusy = false;
    mergeUpdateFooter();
  }
}

/** 标签管理弹窗尚未增量化：改动即整块重建。 */
export function openTagManager(): void {
  state.tagsManagerOpen = true;
  state.tagsManagerError = null;
  state.tagDeleteConfirmId = null;
  void refreshTags().then(() => render());
}

export function closeTagManager(): void {
  if (state.tagsManagerBusy) return;
  state.tagsManagerOpen = false;
  state.tagDeleteConfirmId = null;
  state.tagsManagerError = null;
  render();
}
