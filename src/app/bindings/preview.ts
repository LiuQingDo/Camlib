// 由 main.ts 拆分而来：仅做搬移，未改动逻辑。
import { detachAiTag } from "../../api/ai";
import { toUserMessage } from "../../api/errors";
import { MediaItemDto, attachTag, detachTag, setRating } from "../../api/media";
import { app } from "../../render/context";
import { refreshMedia } from "../../render/paint";
import { patchToolbar } from "../../render/toolbar";
import { state } from "../../state";
import { aiChatUi, openAiChatDrawer } from "../../views/ai-chat";
import { closePreview, invalidatePreviewMeta } from "../../views/preview";
import { renderMetaPanel } from "../../views/preview/meta";
import { previewUi } from "../../views/preview/state";
import { openTagManager } from "../dialogs-ops";
import { runAiTagging } from "../media-ops";
import { refreshTags } from "../media-query";

export function bindPreviewMetaEvents(panel: HTMLElement, item: MediaItemDto): void {
  panel.querySelectorAll<HTMLButtonElement>("[data-set-rating]").forEach((button) => {
    button.addEventListener("click", () => {
      const rating = Number(button.dataset.setRating);
      const mediaId = button.dataset.mediaId || item.id;
      void applyPreviewRating(panel, item, mediaId, rating);
    });
  });
  panel.querySelectorAll<HTMLButtonElement>("[data-remove-tag]").forEach((button) => {
    button.addEventListener("click", () => {
      const tagId = button.dataset.removeTag;
      if (!tagId) return;
      void applyPreviewTag(panel, item, tagId, "remove");
    });
  });
  panel.querySelectorAll<HTMLButtonElement>("[data-remove-ai-tag]").forEach((button) => {
    button.addEventListener("click", () => {
      const tagId = button.dataset.removeAiTag;
      if (!tagId) return;
      void applyPreviewAiTagDetach(panel, item, tagId);
    });
  });
  panel.querySelectorAll<HTMLButtonElement>("[data-add-tag]").forEach((button) => {
    button.addEventListener("click", () => {
      const tagId = button.dataset.addTag;
      if (!tagId) return;
      void applyPreviewTag(panel, item, tagId, "add");
    });
  });
  panel.querySelector<HTMLButtonElement>("#open-tag-manager-from-preview")?.addEventListener("click", () => {
    openTagManager();
  });
  panel.querySelector<HTMLButtonElement>("#toggle-preview-tag-picker")?.addEventListener("click", () => {
    previewUi.tagPickerOpen = true;
    previewUi.tagPickerQuery = "";
    if (!previewUi.metaCache) return;
    panel.innerHTML = renderMetaPanel(previewUi.metaCache, item);
    bindPreviewMetaEvents(panel, item);
  });
  const pickerInput = panel.querySelector<HTMLInputElement>("#preview-tag-picker-input");
  if (pickerInput) {
    // Filter rows in place: re-rendering on each keystroke would drop focus.
    const filterRows = () => {
      const query = pickerInput.value.trim().toLowerCase();
      previewUi.tagPickerQuery = pickerInput.value;
      let visible = 0;
      panel.querySelectorAll<HTMLElement>("#preview-tag-picker-list [data-add-tag]").forEach((row) => {
        const match = !query || (row.dataset.tagName ?? "").includes(query);
        row.hidden = !match;
        if (match) visible += 1;
      });
      const empty = panel.querySelector<HTMLElement>("#preview-tag-picker-list [data-picker-empty]");
      if (empty) empty.hidden = visible > 0;
    };
    pickerInput.addEventListener("input", filterRows);
    if (previewUi.tagPickerQuery) filterRows();
    pickerInput.focus();
  }
  panel.querySelector<HTMLButtonElement>("#preview-ai-tag")?.addEventListener("click", () => {
    const mediaId = panel.querySelector<HTMLButtonElement>("#preview-ai-tag")?.dataset.mediaId || item.id;
    void runAiTagging([mediaId]);
  });
  // 抽屉层级低于预览：先钉住这张照片的上下文，再走完整预览关闭清理
  // （沉浸/全屏/实况状态），最后打开抽屉。
  panel.querySelector<HTMLButtonElement>("#preview-ask-ai")?.addEventListener("click", () => {
    aiChatUi.pinned = {
      mediaId: item.id,
      displayName: item.displayName,
      kind: item.kind,
      captureDate: item.captureDate ?? undefined,
      rating: item.rating || undefined,
      favorite: item.favorite || undefined,
      aiCaption: previewUi.metaCache?.aiCaption ?? undefined,
      aiTags: previewUi.metaCache?.aiTags?.map((tag) => tag.name),
    };
    closePreview();
    void openAiChatDrawer();
  });
}

export async function applyPreviewRating(
  panel: HTMLElement,
  item: MediaItemDto,
  mediaId: string,
  rating: number,
): Promise<void> {
  try {
    await setRating(mediaId, rating);
    invalidatePreviewMeta([mediaId]);
    item.rating = rating;
    if (rating > 0) state.ratings.set(mediaId, rating);
    else state.ratings.delete(mediaId);
    if (previewUi.metaCache) {
      previewUi.metaCache = { ...previewUi.metaCache, rating };
      panel.innerHTML = renderMetaPanel(previewUi.metaCache, item);
      bindPreviewMetaEvents(panel, item);
    }
  } catch (error) {
    state.error = toUserMessage(error, "更新评分失败");
    patchToolbar();
  }
}

export async function applyPreviewTag(
  panel: HTMLElement,
  item: MediaItemDto,
  tagId: string | null,
  mode: "add" | "remove",
): Promise<void> {
  const mediaId = item.id;
  try {
    if (mode === "add" && tagId) {
      await attachTag(mediaId, tagId);
      invalidatePreviewMeta([mediaId]);
      const tag = state.tags.find((entry) => entry.id === tagId);
      if (tag && previewUi.metaCache && !previewUi.metaCache.tags.some((entry) => entry.id === tagId)) {
        // hasAi on preview tags is item-level (this item also carries the tag
        // via media_ai_tags), not the global "AI has ever used this tag"
        // flag that state.tags carries.
        const itemHasAi = (previewUi.metaCache.aiTags ?? []).some((entry) => entry.id === tagId);
        previewUi.metaCache = {
          ...previewUi.metaCache,
          tags: [...previewUi.metaCache.tags, { ...tag, hasAi: itemHasAi }],
        };
      }
    } else if (mode === "remove" && tagId) {
      await detachTag(mediaId, tagId);
      invalidatePreviewMeta([mediaId]);
      if (previewUi.metaCache) {
        previewUi.metaCache = {
          ...previewUi.metaCache,
          tags: previewUi.metaCache.tags.filter((entry) => entry.id !== tagId),
        };
      }
    } else {
      return;
    }
    await refreshTags();
    // The last remaining tag was just attached; collapse the picker so the
    // empty-state message shows instead of an empty dropdown.
    if (previewUi.metaCache && previewUi.metaCache.tags.length >= state.tags.length) {
      previewUi.tagPickerOpen = false;
      previewUi.tagPickerQuery = "";
    }
    if (previewUi.metaCache) {
      // Keep counts roughly fresh without another preview fetch.
      previewUi.metaCache = {
        ...previewUi.metaCache,
        tags: previewUi.metaCache.tags.map((tag) => ({
          ...tag,
          mediaCount: state.tags.find((entry) => entry.id === tag.id)?.mediaCount ?? tag.mediaCount,
        })),
      };
      panel.innerHTML = renderMetaPanel(previewUi.metaCache, item);
      bindPreviewMetaEvents(panel, item);
    }
    // If the active filter requires this tag and we just removed it, refresh.
    if (mode === "remove" && tagId && state.tagIds.has(tagId)) {
      void refreshMedia();
    }
  } catch (error) {
    state.error = toUserMessage(error, "更新标签失败");
    patchToolbar();
  }
}

/** Re-render the open preview's meta panel in place from previewUi.metaCache. */
export function rerenderPreviewMetaPanel(): void {
  if (state.previewIndex === null || !previewUi.metaCache) return;
  const panel = app.querySelector<HTMLElement>("#modal-meta");
  const item = state.page.items[state.previewIndex];
  if (!panel || !item) return;
  panel.innerHTML = renderMetaPanel(previewUi.metaCache, item);
  bindPreviewMetaEvents(panel, item);
}

/** Detach one AI tag from the open preview item (manual tags untouched). */
export async function applyPreviewAiTagDetach(panel: HTMLElement, item: MediaItemDto, tagId: string): Promise<void> {
  try {
    await detachAiTag(item.id, tagId);
    invalidatePreviewMeta([item.id]);
    if (previewUi.metaCache) {
      const remaining = (previewUi.metaCache.aiTags ?? []).filter((tag) => tag.id !== tagId);
      previewUi.metaCache = {
        ...previewUi.metaCache,
        aiTags: remaining,
        // Manual chips keep their AI badge only while the AI attachment for
        // this item still exists.
        tags: previewUi.metaCache.tags.map((tag) => ({
          ...tag,
          hasAi: remaining.some((ai) => ai.id === tag.id),
        })),
      };
    }
    await refreshTags();
    if (previewUi.metaCache) {
      panel.innerHTML = renderMetaPanel(previewUi.metaCache, item);
      bindPreviewMetaEvents(panel, item);
    }
  } catch (error) {
    state.error = toUserMessage(error, "移除 AI 标签失败");
    patchToolbar();
  }
}
