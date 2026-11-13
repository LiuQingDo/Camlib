// 由 main.ts 拆分而来：仅做搬移，未改动逻辑。
import { PreviewMetaDto } from "../../api/media";

/** 预览弹窗的瞬态 UI 状态（多处 patch，故收在一个对象里）。 */
export const previewUi = {
  activePrefetches: 0,
  metaCache: null as PreviewMetaDto | null,
  tagPickerOpen: false,
  tagPickerQuery: "",
};
