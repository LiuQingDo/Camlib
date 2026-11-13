// 由 main.ts 拆分而来：仅做搬移，未改动逻辑。
import { processAiItem } from "../api/ai";
import { toDetailedMessage, toUserMessage } from "../api/errors";
import {
  DeleteResultDto,
  attachTagsBatch,
  deleteMediaItems,
  detachTagsBatch,
  openMediaFolder,
  previewDelete,
  setFavorite,
  setFavoritesBatch,
  setRatingsBatch,
} from "../api/media";
import { formatCount } from "../lib/format";
import { modalThumbnailRequests, previewAssetCache, thumbnailRequests, thumbnailUrlCache } from "../media/cache";
import { app } from "../render/context";
import { render, showTransientNotice } from "../render/paint";
import { patchSidebar } from "../render/shell";
import { applySelectionChrome, patchToolbar, updateFavoriteButton } from "../render/toolbar";
import { bumpGridEpoch, patchGrid } from "../render/virtual";
import { state } from "../state";
import { invalidatePreviewMeta, loadModalAsset } from "../views/preview";
import { refreshTags } from "./media-query";
import { loadAiStats, updateAiSingleProgress } from "./settings-ops";

export async function toggleFavorite(id: string): Promise<void> {
  if (state.favoritePendingIds.has(id)) return;
  const wasFavorite = state.favorites.has(id);
  state.favoritePendingIds.add(id);
  updateFavoriteButton(id);
  try {
    await setFavorite(id, !wasFavorite);
    invalidatePreviewMeta([id]);
    if (wasFavorite) {
      state.favorites.delete(id);
      // An item removed from the current "favorites" result should disappear
      // immediately instead of leaving a stale card until the next refresh.
      if (state.favoriteOnly) {
        state.page.items = state.page.items.filter((item) => item.id !== id);
        state.page.total = Math.max(0, state.page.total - 1);
        state.selectedIds.delete(id);
        patchGrid();
        patchToolbar();
        return;
      }
    } else {
      state.favorites.add(id);
    }
    updateFavoriteButton(id);
  } catch (error) {
    state.error = toUserMessage(error, "更新收藏失败");
    patchToolbar();
  } finally {
    state.favoritePendingIds.delete(id);
    updateFavoriteButton(id);
  }
}

export async function applyBatchFavorite(favorite: boolean): Promise<void> {
  if (!state.selectedIds.size || state.favoritesBusy) return;
  const ids = [...state.selectedIds];
  state.favoritesBusy = true;
  state.error = null;
  applySelectionChrome();
  try {
    await setFavoritesBatch(ids, favorite);
    invalidatePreviewMeta(ids);
    for (const id of ids) {
      if (favorite) state.favorites.add(id);
      else {
        state.favorites.delete(id);
        if (state.favoriteOnly) state.selectedIds.delete(id);
      }
      updateFavoriteButton(id);
    }
    if (!favorite && state.favoriteOnly) {
      const removed = new Set(ids);
      state.page.items = state.page.items.filter((item) => !removed.has(item.id));
      state.page.total = Math.max(0, state.page.total - removed.size);
    }
    state.deleteNotice = favorite ? `已收藏 ${formatCount(ids.length)} 项` : `已取消收藏 ${formatCount(ids.length)} 项`;
  } catch (error) {
    state.error = toUserMessage(error, "批量更新收藏失败");
  } finally {
    // Only state reset belongs here: a `return` inside `finally` would swallow
    // any exception thrown by the reset itself, so the branch runs below.
    state.favoritesBusy = false;
  }
  if ((!favorite && state.favoriteOnly) || state.error) {
    patchGrid();
    patchToolbar();
    return;
  }
  applySelectionChrome();
  showTransientNotice(state.deleteNotice ?? "");
  state.deleteNotice = null;
}

export async function applyBatchTag(attach: boolean): Promise<void> {
  if (!state.selectedIds.size || state.tagsBusy) return;
  const select = app.querySelector<HTMLSelectElement>("#batch-tag-select");
  const tagId = select?.value.trim();
  if (!tagId) {
    state.error = "请先选择标签";
    patchToolbar();
    return;
  }
  const ids = [...state.selectedIds];
  state.tagsBusy = true;
  state.error = null;
  applySelectionChrome();
  try {
    if (attach) await attachTagsBatch(ids, tagId);
    else await detachTagsBatch(ids, tagId);
    invalidatePreviewMeta(ids);
    await refreshTags();
    const tagName = state.tags.find((tag) => tag.id === tagId)?.name ?? "标签";
    state.deleteNotice = attach
      ? `已为 ${formatCount(ids.length)} 项添加「${tagName}」`
      : `已从 ${formatCount(ids.length)} 项移除「${tagName}」`;
  } catch (error) {
    state.error = toUserMessage(error, "批量更新标签失败");
  } finally {
    state.tagsBusy = false;
  }
  if (state.error || (state.tagIds.has(tagId) && !attach)) {
    patchGrid();
    patchToolbar();
    return;
  }
  applySelectionChrome();
  showTransientNotice(state.deleteNotice ?? "");
  state.deleteNotice = null;
}

export async function applyBatchRating(): Promise<void> {
  if (!state.selectedIds.size || state.tagsBusy) return;
  const select = app.querySelector<HTMLSelectElement>("#batch-rating-select");
  const raw = select?.value.trim();
  if (raw === "" || raw === undefined) {
    state.error = "请先选择评分";
    patchToolbar();
    return;
  }
  const rating = Number(raw);
  if (!Number.isInteger(rating) || rating < 0 || rating > 5) {
    state.error = "评分必须是 0–5";
    patchToolbar();
    return;
  }
  const ids = [...state.selectedIds];
  state.tagsBusy = true;
  state.error = null;
  applySelectionChrome();
  try {
    await setRatingsBatch(ids, rating);
    invalidatePreviewMeta(ids);
    for (const id of ids) {
      if (rating > 0) state.ratings.set(id, rating);
      else state.ratings.delete(id);
      const item = state.page.items.find((entry) => entry.id === id);
      if (item) item.rating = rating;
    }
    state.deleteNotice =
      rating === 0 ? `已清除 ${formatCount(ids.length)} 项评分` : `已为 ${formatCount(ids.length)} 项设为 ${rating} 星`;
  } catch (error) {
    state.error = toUserMessage(error, "批量设置评分失败");
  } finally {
    state.tagsBusy = false;
  }
  if (state.error || state.ratingEq !== null || state.ratingMin !== null) {
    patchGrid();
    patchToolbar();
    return;
  }
  applySelectionChrome();
  showTransientNotice(state.deleteNotice ?? "");
  state.deleteNotice = null;
}

/**
 * Tag one or a few photos with the single-item command, sequentially. This is
 * the "optional per-photo" path next to the background batch run: no job, no
 * preview gate — just immediate feedback per photo in the sidebar progress.
 */
export async function runAiTagging(ids: string[]): Promise<void> {
  if (state.aiSingleBusy || ids.length === 0) return;
  state.aiSingleBusy = true;
  state.aiSingleTotal = ids.length;
  state.aiSingleDone = 0;
  state.aiSingleFailed = 0;
  state.aiSingleCurrent = null;
  state.aiSingleNotice = null;
  patchSidebar();
  const names = new Map(state.page.items.map((entry) => [entry.id, entry.displayName]));
  for (const id of ids) {
    if (!state.aiSingleBusy) break;
    state.aiSingleCurrent = names.get(id) ?? id;
    updateAiSingleProgress();
    try {
      const result = await processAiItem(id);
      // The cached preview predates the new AI caption/tags; drop it so the
      // trailing loadModalAsset() below refetches instead of replaying it.
      invalidatePreviewMeta([id]);
      if (result.status === "skipped") state.aiSingleFailed++;
    } catch (error) {
      state.aiSingleFailed++;
      state.aiSingleNotice = toDetailedMessage(error, "AI 打标失败");
    }
    state.aiSingleDone++;
    updateAiSingleProgress();
  }
  const succeeded = state.aiSingleDone - state.aiSingleFailed;
  state.aiSingleBusy = false;
  state.aiSingleCurrent = null;
  state.aiSingleNotice =
    state.aiSingleDone === state.aiSingleTotal
      ? `AI 打标完成：成功 ${formatCount(succeeded)}${state.aiSingleFailed ? `，失败/跳过 ${formatCount(state.aiSingleFailed)}` : ""}`
      : "AI 打标已取消";
  await Promise.all([refreshTags(), loadAiStats()]);
  render();
  // The open preview may show one of the just-tagged items — reload its meta
  // so the new AI description and tags appear without closing the dialog.
  if (state.previewIndex !== null) {
    const item = state.page.items[state.previewIndex];
    if (item && ids.includes(item.id)) void loadModalAsset();
  }
}

export async function openFolderForItem(mediaItemId: string): Promise<void> {
  try {
    await openMediaFolder(mediaItemId);
    state.error = null;
  } catch (error) {
    state.error = toUserMessage(error, "打开所在文件夹失败");
    patchToolbar();
  }
}

export function cancelDeleteConfirm(): void {
  if (state.deleting) return;
  state.deleteConfirm = null;
  render();
}

export function applyDeleteToGrid(result: DeleteResultDto, requestedIds: string[]): void {
  const deleted = new Set(result.deletedItemIds);
  const failed = new Set(result.failedItemIds);
  // Drop fully recycled items from the grid immediately; keep partial failures
  // visible so the user can inspect what is still on disk.
  state.page.items = state.page.items.filter((item) => !deleted.has(item.id));
  state.page.total = Math.max(0, state.page.total - deleted.size);
  // 结果集内容变了（不只是长度），展示顺序与行盒都要重算。
  bumpGridEpoch();
  for (const id of requestedIds) {
    state.selectedIds.delete(id);
    state.favorites.delete(id);
    state.ratings.delete(id);
    if (deleted.has(id)) {
      thumbnailRequests.delete(id);
      thumbnailUrlCache.delete(id);
      modalThumbnailRequests.delete(id);
      previewAssetCache.delete(id);
    }
  }
  // Failed items remain selected so the user can retry after fixing the file.
  for (const id of failed) {
    if (requestedIds.includes(id)) state.selectedIds.add(id);
  }
  if (state.previewIndex !== null) {
    const current = state.page.items[state.previewIndex];
    if (!current) state.previewIndex = null;
  }
}

export async function requestDeleteSelected(): Promise<void> {
  if (!state.library || !state.selectedIds.size || state.deleting || state.deleteConfirm) return;
  if (state.availability !== "available") {
    state.error = state.libraryStatusReason || "媒体库不可用，无法删除媒体";
    patchToolbar();
    return;
  }
  const ids = [...state.selectedIds];
  state.deleting = true;
  state.deleteResult = null;
  state.deleteNotice = null;
  state.error = null;
  patchToolbar();
  try {
    const preview = await previewDelete(state.library.id, ids);
    state.deleteConfirm = { preview, ids };
  } catch (error) {
    state.error = toUserMessage(error, "无法生成删除预览");
    state.selectedIds.clear();
  } finally {
    state.deleting = false;
    render();
  }
}

export async function runConfirmedDelete(): Promise<void> {
  const confirm = state.deleteConfirm;
  if (!state.library || !confirm || state.deleting) return;
  state.deleting = true;
  state.deleteConfirm = null;
  state.deleteProgress = {
    processedFiles: 0,
    totalFiles: confirm.preview.fileCount,
    current: "",
    state: "running",
  };
  state.error = null;
  patchToolbar();
  try {
    const result = await deleteMediaItems(state.library.id, confirm.ids);
    state.deleteResult = result;
    state.deleteProgress = null;
    applyDeleteToGrid(result, confirm.ids);
    // Partial failures are explained by the result panel; do not stack a second error banner.
    state.error = null;
  } catch (error) {
    state.deleteProgress = null;
    state.error = toUserMessage(error, "删除媒体失败");
  } finally {
    state.deleting = false;
    state.lastSelectIndex = null;
    // 网格按 id 摘掉已删除的卡片（其余卡片连同缩略图原样留着），再补横幅
    // 与选择工具栏。
    patchGrid();
    patchToolbar();
  }
}
