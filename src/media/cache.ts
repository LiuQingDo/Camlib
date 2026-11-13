// 由 main.ts 拆分而来：仅做搬移，未改动逻辑。
import { MediaPreviewDto, getMediaThumbnail } from "../api/media";

// Image decoding is intentionally serialized in the backend to cap memory, but
// cache hits are cheap. A wider queue makes warm-cache grids populate in one
// short burst while the visible-first ordering protects cold-cache latency.
export const thumbnailConcurrency = 8;

export let activeThumbnailRequests = 0;

export const thumbnailQueue: Array<{
  id: string;
  resolve: (asset: Awaited<ReturnType<typeof getMediaThumbnail>>) => void;
  reject: (error: unknown) => void;
}> = [];

// Keep successful URL promises for the lifetime of the page. Camlib redraws the
// grid for selection/favorite changes; dropping these used to repeat one IPC +
// Base64 transfer per card after every redraw.
export const thumbnailRequests = new Map<string, Promise<Awaited<ReturnType<typeof getMediaThumbnail>>>>();

// Resolved thumbnail URLs so a full re-render (load-more, selection) can paint
// `<img>` immediately instead of flashing the skeleton for one frame.
export const thumbnailUrlCache = new Map<string, string>();

// The modal must not hand a camera original directly to WebView2. A bounded
// cached preview is large enough for the modal while avoiding failures caused
// by decoding very large textures at their native dimensions.
export const modalThumbnailWidth = 1600;

export const modalThumbnailRequests = new Map<string, Promise<Awaited<ReturnType<typeof getMediaThumbnail>>>>();

// Neighbor preview prefetch: cache the IPC response and warm only a couple of
// futures so rapid arrow navigation never piles up unbounded work.
export const previewAssetCache = new Map<string, Promise<MediaPreviewDto>>();

export const previewPrefetchQueue: string[] = [];

export const previewPrefetchLimit = 2;

export function pumpThumbnailQueue(): void {
  while (activeThumbnailRequests < thumbnailConcurrency && thumbnailQueue.length) {
    const request = thumbnailQueue.shift()!;
    activeThumbnailRequests += 1;
    void getMediaThumbnail(request.id)
      .then(request.resolve, request.reject)
      .finally(() => {
        activeThumbnailRequests -= 1;
        pumpThumbnailQueue();
      })
      .catch(() => undefined);
  }
}

export function loadThumbnail(
  id: string,
  highPriority = false,
): Promise<Awaited<ReturnType<typeof getMediaThumbnail>>> {
  const pending = thumbnailRequests.get(id);
  if (pending) {
    if (highPriority) {
      const queuedIndex = thumbnailQueue.findIndex((entry) => entry.id === id);
      if (queuedIndex > 0) thumbnailQueue.unshift(thumbnailQueue.splice(queuedIndex, 1)[0]);
    }
    return pending;
  }
  const request = new Promise<Awaited<ReturnType<typeof getMediaThumbnail>>>((resolve, reject) => {
    const queued = { id, resolve, reject };
    if (highPriority) thumbnailQueue.unshift(queued);
    else thumbnailQueue.push(queued);
    pumpThumbnailQueue();
  });
  thumbnailRequests.set(id, request);
  void request.catch(() => thumbnailRequests.delete(id));
  return request;
}

/**
 * Drop a thumbnail request that has not started yet.
 *
 * Virtual scrolling recycles cards, so a card can leave the viewport between
 * "queue it" and "pick it up". The IPC decode+transfer is the expensive part and
 * the backend serialises it, so a request that is still waiting in line must be
 * withdrawn — otherwise a fast scroll across thousands of items keeps decoding
 * thumbnails nobody will ever see. In-flight requests cannot be recalled; their
 * result lands in `thumbnailUrlCache` and is reused when the card comes back.
 */
export function cancelQueuedThumbnail(id: string): void {
  const index = thumbnailQueue.findIndex((entry) => entry.id === id);
  if (index < 0) return;
  const [entry] = thumbnailQueue.splice(index, 1);
  thumbnailRequests.delete(id);
  entry.reject(new ThumbnailCancelled());
}

/** Marker rejection: never surfaced to the user as "预览失败". */
export class ThumbnailCancelled extends Error {
  constructor() {
    super("thumbnail request cancelled");
    this.name = "ThumbnailCancelled";
  }
}

export function loadModalThumbnail(id: string): Promise<Awaited<ReturnType<typeof getMediaThumbnail>>> {
  const pending = modalThumbnailRequests.get(id);
  if (pending) return pending;
  const request = getMediaThumbnail(id, modalThumbnailWidth);
  modalThumbnailRequests.set(id, request);
  void request.catch(() => modalThumbnailRequests.delete(id));
  return request;
}
