/**
 * 「已删除」只读列表的动作层。
 *
 * 只做三件事：开关浮层、拉一次列表、把某一行交给资源管理器。整套流程里没有
 * 还原（后端没有这个能力，也不该用假按钮占位），也没有任何删除相关的新行为。
 */
import {
  DELETED_ITEMS_LIMIT,
  listDeletedItems,
  openDeletedItemFolder as requestOpenDeletedItemFolder,
} from "../api/deleted";
import { toDetailedMessage, toUserMessage } from "../api/errors";
import { patchDeletedOverlay } from "../render/paint";
import { state } from "../state";
import { showToast } from "./toast";

export async function openDeletedPanel(): Promise<void> {
  if (state.deletedOpen) return;
  if (!state.library) {
    showToast("先选择媒体库，才能查看删除记录", { kind: "info" });
    return;
  }
  state.deletedOpen = true;
  state.deletedItems = [];
  state.deletedTotal = 0;
  state.deletedError = null;
  // 先建空壳再拉数据：入场动画和焦点陷阱都跟着这一次 patch 走。
  state.deletedLoading = true;
  patchDeletedOverlay();
  await loadDeletedItems();
}

/** 关闭只收起浮层；数据留在 state 里，下次打开先显示旧列表再刷新。 */
export function closeDeletedPanel(): void {
  if (!state.deletedOpen) return;
  state.deletedOpen = false;
  state.deletedLoading = false;
  patchDeletedOverlay();
}

export async function loadDeletedItems(): Promise<void> {
  const libraryId = state.library?.id;
  if (!libraryId) {
    state.deletedLoading = false;
    state.deletedError = "尚未配置媒体库";
    patchDeletedOverlay();
    return;
  }
  state.deletedLoading = true;
  state.deletedError = null;
  patchDeletedOverlay();
  try {
    const page = await listDeletedItems(libraryId, DELETED_ITEMS_LIMIT, 0);
    // 请求回来时用户可能已经关掉浮层：照样写入 state，但不重建 DOM。
    state.deletedItems = page.items;
    state.deletedTotal = page.total;
  } catch (error) {
    state.deletedItems = [];
    state.deletedTotal = 0;
    state.deletedError = toUserMessage(error, "读取删除记录失败");
  }
  state.deletedLoading = false;
  if (state.deletedOpen) patchDeletedOverlay();
}

/**
 * 打开某一行的原始位置。文件已在回收站（或原目录也随盘符消失）时，后端会给出
 * 具体原因，这里必须转成可见提示——静默失败会让用户以为按钮坏了。
 */
export async function openDeletedItemFolder(relativePath: string): Promise<void> {
  const libraryId = state.library?.id;
  if (!libraryId) {
    showToast("尚未配置媒体库，无法打开所在位置", { kind: "error" });
    return;
  }
  try {
    await requestOpenDeletedItemFolder(libraryId, relativePath);
  } catch (error) {
    // 后端 message 已经写明是哪条路径、哪一步失败，比固定的 code 文案更有用。
    showToast(toDetailedMessage(error, "无法在资源管理器中打开该位置"), {
      kind: "error",
      key: "deleted-open-folder",
    });
  }
}
