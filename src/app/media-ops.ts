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
import { refreshMedia, render } from "../render/paint";
import { patchSidebar } from "../render/shell";
import { applySelectionChrome, closeSelectionMore, patchToolbar, updateFavoriteButton } from "../render/toolbar";
import { bumpGridEpoch, patchGrid } from "../render/virtual";
import { state } from "../state";
import { invalidatePreviewMeta, loadModalAsset } from "../views/preview";
import { refreshTags } from "./media-query";
import { dismissNotice, pushNotice } from "./notices";
import { loadAiStats, updateAiSingleProgress } from "./settings-ops";
import { showToast } from "./toast";

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
  // 收藏是唯一给「撤销」的批量动作：它只写一个布尔值，撤销成本可控。标签与评分
  // 要记住每一项的原值，做不到就别承诺（弹层里已写明不可撤销）。
  showToast(favorite ? `已收藏 ${formatCount(ids.length)} 项` : `已取消收藏 ${formatCount(ids.length)} 项`, {
    kind: "success",
    key: "batch-favorite",
    action: { label: "撤销", run: () => void undoBatchFavorite(ids, favorite) },
  });
}

/** 撤销一批收藏写入：把布尔值写回原样，再回滚本地缓存。 */
async function undoBatchFavorite(ids: string[], applied: boolean): Promise<void> {
  try {
    await setFavoritesBatch(ids, !applied);
  } catch (error) {
    showToast(toUserMessage(error, "撤销失败"), { kind: "error", key: "batch-favorite" });
    return;
  }
  invalidatePreviewMeta(ids);
  for (const id of ids) {
    if (applied) state.favorites.delete(id);
    else state.favorites.add(id);
    updateFavoriteButton(id);
  }
  showToast("已撤销上一次收藏操作", { kind: "info", key: "batch-favorite" });
  // 「只看收藏」下撤销「取消收藏」= 这些项重新属于结果集，但原位置找不回来；
  // 交给一次真正的重新查询，比在这里猜插入点可靠。
  if (state.favoriteOnly) void refreshMedia();
  else {
    patchGrid();
    applySelectionChrome();
  }
}

/** 收藏切换：只要批里还有一张没收藏，这次动作就是「收藏」。 */
export function toggleFavoriteSelected(): void {
  if (!state.selectedIds.size || state.favoritesBusy) return;
  const allFavorite = [...state.selectedIds].every((id) => state.favorites.has(id));
  void applyBatchFavorite(!allFavorite);
}

/** 「更多」弹层一次提交的草稿：标签（多选）+ 评分，标签在前。 */
export interface BatchMetaDraft {
  tagIds: string[];
  rating: number | null;
  detachTags: boolean;
}

/**
 * 批量标签 + 评分一次确认。
 *
 * 串行调用既有的 attach/detach 与 rating 命令（后端没有「标签+评分」合并命令，
 * 这里也不新增）：先标签后评分，标签失败不拦评分；任一失败最后汇总成**一条**
 * toast——逐条弹会把屏幕铺满，也看不出总共错了几项。
 */
export async function applyBatchMeta(draft: BatchMetaDraft): Promise<void> {
  if (!state.selectedIds.size || state.tagsBusy) return;
  const tagIds = [...new Set(draft.tagIds)];
  const rating = draft.rating;
  if (!tagIds.length && rating === null) {
    showToast("请先选择标签或评分", { kind: "info", key: "batch-meta" });
    return;
  }
  const ids = [...state.selectedIds];
  const failures: string[] = [];
  const appliedTags: string[] = [];
  state.tagsBusy = true;
  state.error = null;
  applySelectionChrome();
  try {
    for (const tagId of tagIds) {
      const name = state.tags.find((tag) => tag.id === tagId)?.name ?? "标签";
      try {
        if (draft.detachTags) await detachTagsBatch(ids, tagId);
        else await attachTagsBatch(ids, tagId);
        appliedTags.push(name);
      } catch (error) {
        failures.push(`标签「${name}」：${toUserMessage(error, "更新失败")}`);
      }
    }
    if (rating !== null) {
      try {
        await setRatingsBatch(ids, rating);
        for (const id of ids) {
          if (rating > 0) state.ratings.set(id, rating);
          else state.ratings.delete(id);
          const item = state.page.items.find((entry) => entry.id === id);
          if (item) item.rating = rating;
        }
      } catch (error) {
        failures.push(`评分：${toUserMessage(error, "设置失败")}`);
      }
    }
    if (appliedTags.length) {
      invalidatePreviewMeta(ids);
      await refreshTags();
    }
  } finally {
    state.tagsBusy = false;
  }
  // 提交即收弹层：草稿已经落地，留在屏幕上只会让人以为还没执行。
  closeSelectionMore();
  if (failures.length) {
    showToast(`批量操作部分失败：${failures.join("；")}`, { kind: "error", key: "batch-meta" });
    patchGrid();
    patchToolbar();
    return;
  }
  const parts: string[] = [];
  if (appliedTags.length) parts.push(`${draft.detachTags ? "移除" : "附加"} ${formatCount(appliedTags.length)} 个标签`);
  if (rating !== null) parts.push(rating === 0 ? "清除评分" : `评分设为 ${rating} 星`);
  showToast(`已对 ${formatCount(ids.length)} 项${parts.join("、")} · 不可撤销`, { kind: "success", key: "batch-meta" });
  patchGrid();
  applySelectionChrome();
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
  // 卡片被摘掉之后，旧的 roving 下标指向的是已经不存在的行。
  state.focusIndex = null;
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

/**
 * 删除结果反馈。
 *
 * 成功：一条 4s 自动收的 toast；部分失败：常驻 toast + 「查看 N 条失败」——
 * 十几行错误明细不塞进 toast，推进错误条那条可折叠、可重试的通知里。
 *
 * 关于「撤销」：这里刻意不给。应用只把文件送进 Windows 回收站、不在索引里保留
 * 恢复所需的信息，也没有能力把回收站里的条目还原回原路径；opener 只有 open-url /
 * open-path（前者要 ACL scope、后者要求路径真实存在），都打不开 `shell:RecycleBinFolder`。
 * 所以文案只说清"去哪儿找"，不给一个点了没用的按钮，更不写假的撤销。
 *
 * 落点放在 app 层而不是 renderDeleteFeedback()：重试要调 requestDeleteSelected()，
 * 而 render/toolbar 不能反向 import app/media-ops（会成环）。
 */
function emitDeleteResultFeedback(result: DeleteResultDto): void {
  const summary = `媒体 ${formatCount(result.mediaCount)} 项 · 成功回收 ${formatCount(result.filesRecycled)} 个文件 · 本就缺失 ${formatCount(result.filesAlreadyMissing)} · 失败 ${formatCount(result.failedFiles)}`;
  if (result.failedFiles <= 0) {
    showToast(`已移入回收站 · 可在系统回收站恢复 · ${summary}`, { kind: "success", key: "delete-result" });
    return;
  }
  showToast(`删除部分完成 · ${summary}`, {
    kind: "error",
    key: "delete-result",
    action: { label: `查看 ${formatCount(result.failedFiles)} 条失败`, run: () => revealDeleteFailures(result) },
  });
}

/** 「查看 N 条失败」：明细 + 重试入口推到错误条，并滚到可见处。 */
function revealDeleteFailures(result: DeleteResultDto): void {
  const failedIds = result.failedItemIds;
  pushNotice({
    id: "delete-failed",
    kind: "error",
    title: "删除部分完成",
    detail: result.errors.length ? result.errors.join("\n") : "后端没有返回逐条错误，失败文件仍在原位置。",
    sticky: true,
    actions: failedIds.length
      ? [
          {
            label: "重试失败项",
            run: () => {
              dismissNotice("delete-failed");
              // 只把失败项放回选择集，再走一遍既有的「预览 → 确认」流程。
              state.selectedIds.clear();
              for (const id of failedIds) state.selectedIds.add(id);
              void requestDeleteSelected();
            },
          },
        ]
      : undefined,
  });
  patchToolbar();
  app.querySelector(".error-bar")?.scrollIntoView({ block: "start" });
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
  // 确认即退场：deleteConfirm 已经被清空，这里必须真的重绘一次。只 patchToolbar
  // 的话弹窗 DOM 会留在屏幕上——用户点完「移入回收站」看到的仍是一个弹窗，
  // 焦点陷阱也无处释放（提示改走底部 toast 与任务胶囊）。
  render();
  try {
    const result = await deleteMediaItems(state.library.id, confirm.ids);
    state.deleteResult = result;
    state.deleteProgress = null;
    applyDeleteToGrid(result, confirm.ids);
    // 结果走 toast（成功自动收、失败常驻）；明细与重试留在错误条，不叠加第二条错误。
    state.error = null;
    emitDeleteResultFeedback(result);
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
