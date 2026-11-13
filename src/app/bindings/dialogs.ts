// 由 main.ts 拆分而来：仅做搬移，未改动逻辑。
import { toUserMessage } from "../../api/errors";
import { cancelVideoMerge, createTag, deleteTag, updateTag } from "../../api/media";
import { previewAssetCache } from "../../media/cache";
import { app } from "../../render/context";
import { bindPreviewMetaEvents, refreshMedia, render } from "../../render/paint";
import { state } from "../../state";
import { mergeUpdateFooter, updateMergeModal } from "../../views/dialogs";
import { renderMetaPanel } from "../../views/preview/meta";
import { previewUi } from "../../views/preview/state";
import {
  beginMergeDrag,
  closeMergeModal,
  closeTagManager,
  confirmMerge,
  fillMergeThumbnails,
  mergeMoveItem,
} from "../dialogs-ops";
import { refreshTags } from "../media-query";

export function bindMergeModalEvents(): void {
  if (!state.mergeModalOpen) return;
  const host = app.querySelector<HTMLElement>("#merge-videos-modal");
  if (host?.dataset.boundRegion === "1") return;
  if (host) host.dataset.boundRegion = "1";
  app.querySelector<HTMLButtonElement>("#close-merge-modal")?.addEventListener("click", closeMergeModal);
  app.querySelector<HTMLDivElement>("#merge-videos-modal")?.addEventListener("click", (event) => {
    if (event.target === event.currentTarget) closeMergeModal();
  });
  app.querySelectorAll<HTMLButtonElement>("[data-merge-mode]").forEach((button) => {
    button.addEventListener("click", () => {
      if (state.mergeJobId || state.mergeBusy) return;
      const mode = button.dataset.mergeMode;
      if ((mode !== "copy" && mode !== "reencode") || state.mergeMode === mode) return;
      state.mergeMode = mode;
      updateMergeModal();
    });
  });
  app.querySelector<HTMLInputElement>("#merge-recycle-sources")?.addEventListener("change", (event) => {
    state.mergeRecycleSources = (event.target as HTMLInputElement).checked;
  });
  app.querySelectorAll<HTMLButtonElement>("[data-merge-up]").forEach((button) => {
    button.addEventListener("click", () => mergeMoveItem(Number(button.dataset.mergeUp), -1));
  });
  app.querySelectorAll<HTMLButtonElement>("[data-merge-down]").forEach((button) => {
    button.addEventListener("click", () => mergeMoveItem(Number(button.dataset.mergeDown), 1));
  });
  bindMergeDragEvents();
  bindMergeFooterEvents();
  fillMergeThumbnails();
}

/** Footer is patched separately so progress updates never rebuild the list. */
export function bindMergeFooterEvents(): void {
  app.querySelector<HTMLButtonElement>("#merge-cancel-job")?.addEventListener("click", () => {
    if (!state.mergeJobId) return;
    state.mergeNotice = "正在取消…";
    mergeUpdateFooter();
    void cancelVideoMerge(state.mergeJobId).catch(() => undefined);
  });
  app.querySelector<HTMLButtonElement>("#close-merge-modal-footer")?.addEventListener("click", closeMergeModal);
  app.querySelector<HTMLButtonElement>("#merge-confirm")?.addEventListener("click", () => void confirmMerge());
}

/**
 * Pointer-based row reorder: the handle captures the pointer, every move
 * re-seats the dragged row before/after its neighbor, and the drop commits
 * the DOM order back into `state.mergeItems` (then re-renders to renumber).
 */
export function bindMergeDragEvents(): void {
  app.querySelectorAll<HTMLElement>(".merge-row-handle").forEach((handle) => {
    handle.addEventListener("pointerdown", (event) => beginMergeDrag(event));
  });
}

export function bindTagManagerEvents(): void {
  if (!state.tagsManagerOpen) return;
  // 容器没重建时整块跳过，避免重复挂监听器（弹窗区任一处变化都会重跑 binder）。
  const host = app.querySelector<HTMLElement>("#tag-manager-backdrop");
  if (host?.dataset.boundRegion === "1") return;
  if (host) host.dataset.boundRegion = "1";
  app.querySelector<HTMLButtonElement>("#close-tag-manager")?.addEventListener("click", closeTagManager);
  app.querySelector<HTMLButtonElement>("#close-tag-manager-footer")?.addEventListener("click", closeTagManager);
  app.querySelector<HTMLDivElement>("#tag-manager-backdrop")?.addEventListener("click", (event) => {
    if (event.target === event.currentTarget) closeTagManager();
  });
  app.querySelector<HTMLFormElement>("#tag-create-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const input = app.querySelector<HTMLInputElement>("#tag-create-name");
    const name = input?.value.trim() ?? "";
    if (!name || state.tagsManagerBusy) return;
    if (input) input.value = "";
    void (async () => {
      state.tagsManagerBusy = true;
      state.tagsManagerError = null;
      try {
        await createTag(name);
        await refreshTags();
      } catch (error) {
        state.tagsManagerError = toUserMessage(error, "新建标签失败");
      } finally {
        state.tagsManagerBusy = false;
        render();
      }
    })();
  });
  app.querySelectorAll<HTMLInputElement>("[data-rename-tag]").forEach((input) => {
    const commit = () => {
      const tagId = input.dataset.renameTag;
      if (!tagId || state.tagsManagerBusy) return;
      const tag = state.tags.find((entry) => entry.id === tagId);
      const name = input.value.trim();
      if (!tag || !name || name === tag.name) {
        if (tag) input.value = tag.name;
        return;
      }
      void (async () => {
        state.tagsManagerBusy = true;
        state.tagsManagerError = null;
        try {
          await updateTag(tagId, { name });
          await refreshTags();
          // Renames affect every cached preview; drop them all so reopen
          // refetches instead of showing the old tag name.
          previewAssetCache.clear();
          if (previewUi.metaCache) {
            previewUi.metaCache = {
              ...previewUi.metaCache,
              tags: previewUi.metaCache.tags.map((entry) => (entry.id === tagId ? { ...entry, name } : entry)),
            };
          }
        } catch (error) {
          state.tagsManagerError = toUserMessage(error, "重命名标签失败");
          await refreshTags();
        } finally {
          state.tagsManagerBusy = false;
          render();
        }
      })();
    };
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        commit();
      }
    });
    input.addEventListener("blur", commit);
  });
  app.querySelectorAll<HTMLButtonElement>("[data-start-delete-tag]").forEach((button) => {
    button.addEventListener("click", () => {
      state.tagDeleteConfirmId = button.dataset.startDeleteTag ?? null;
      render();
    });
  });
  app.querySelectorAll<HTMLButtonElement>("[data-cancel-delete-tag]").forEach((button) => {
    button.addEventListener("click", () => {
      state.tagDeleteConfirmId = null;
      render();
    });
  });
  app.querySelectorAll<HTMLButtonElement>("[data-confirm-delete-tag]").forEach((button) => {
    button.addEventListener("click", () => {
      const tagId = button.dataset.confirmDeleteTag;
      if (!tagId || state.tagsManagerBusy) return;
      void (async () => {
        state.tagsManagerBusy = true;
        state.tagsManagerError = null;
        try {
          await deleteTag(tagId);
          state.tagIds.delete(tagId);
          // Deleted tags disappear from every cached preview payload; drop
          // them all so reopen refetches fresh meta.
          previewAssetCache.clear();
          if (previewUi.metaCache) {
            previewUi.metaCache = {
              ...previewUi.metaCache,
              tags: previewUi.metaCache.tags.filter((entry) => entry.id !== tagId),
            };
          }
          await refreshTags();
          state.tagDeleteConfirmId = null;
          if (state.previewIndex !== null) {
            const panel = app.querySelector<HTMLElement>("#modal-meta");
            const item = state.page.items[state.previewIndex];
            if (panel && item && previewUi.metaCache) {
              panel.innerHTML = renderMetaPanel(previewUi.metaCache, item);
              bindPreviewMetaEvents(panel, item);
            }
          }
          void refreshMedia();
        } catch (error) {
          state.tagsManagerError = toUserMessage(error, "删除标签失败");
        } finally {
          state.tagsManagerBusy = false;
          render();
        }
      })();
    });
  });
}
