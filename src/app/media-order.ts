import type { MediaItemDto } from "../api/media";
import { gridItems } from "../render/virtual";
import { state } from "../state";

/**
 * 展示顺序：网格按天分组后的拍平顺序，卡片上的 `data-index` 就是它。
 *
 * 分组会按「天」重排（例如按文件名排序时同一天的项目聚在一起），所以它和查询
 * 返回的 `state.page.items` 并不总是同一顺序。范围选择、roving 焦点都必须用
 * 同一份顺序，否则 Shift 连选会选到肉眼之外的卡片。
 *
 * 单独成模块是为了让 `app/bindings/toolbar`（鼠标路径）与 `app/selection-nav`
 * （键盘路径）共用，而不必互相 import 绕成环。
 */
export function displayItems(): readonly MediaItemDto[] {
  return gridItems.length ? gridItems : state.page.items;
}
