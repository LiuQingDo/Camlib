/**
 * 侧栏「已删除」只读列表。
 *
 * 数据只有一个来源：Rust 侧从 `deletion_logs` 推导。媒体表没有 deleted 标记，
 * 所以这里是审计日志的投影，不是可翻页的媒体集合；同一媒体多次删除只会出现
 * 一行（取最近一次成功的回收站记录）。
 */
import { invoke } from "@tauri-apps/api/core";

import type { MediaKind } from "./media";

export interface DeletedItemDto {
  /** 媒体项 id（不是删除日志 id）：同一媒体的多行已在后端去重。 */
  id: string;
  displayName: string;
  kind: MediaKind;
  captureDate: string | null;
  /** 相对媒体库根目录的原路径，永远是 `/` 分隔。 */
  relativePath: string;
  /** `unix-ms:<毫秒>`：最近一次成功回收的时间。 */
  deletedAt: string;
}

export interface DeletedItemsPageDto {
  items: DeletedItemDto[];
  /** 去重后的媒体条数（同过滤条件），可能大于 `items.length`。 */
  total: number;
  offset: number;
  limit: number;
}

/** 与视图底部「只显示最近 100 条删除记录」保持同一常量。 */
export const DELETED_ITEMS_LIMIT = 100;

export function listDeletedItems(
  libraryId: string,
  limit = DELETED_ITEMS_LIMIT,
  offset = 0,
): Promise<DeletedItemsPageDto> {
  return invoke<DeletedItemsPageDto>("list_deleted_items", { libraryId, limit, offset });
}

/**
 * 在资源管理器中定位已删除的媒体：文件通常已在 Windows 回收站里，后端会退到
 * 原目录；两者都不存在时抛出 MEDIA_MISSING，由调用方给出明确提示。
 */
export function openDeletedItemFolder(libraryId: string, relativePath: string): Promise<void> {
  return invoke<void>("deleted_open_folder", { libraryId, relativePath });
}
