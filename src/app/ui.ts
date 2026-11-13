// 由 main.ts 拆分而来：仅做搬移，未改动逻辑。
import { app } from "../render/context";
import { escapeHtml } from "../render/text";

/** Module-level timer so successive toasts never stack dismiss handles. */
export let transientNoticeTimer: ReturnType<typeof setTimeout> | null = null;

export function clearTransientNotice(): void {
  if (transientNoticeTimer !== null) {
    clearTimeout(transientNoticeTimer);
    transientNoticeTimer = null;
  }
  app.querySelector("#batch-notice")?.remove();
}

/**
 * Lightweight toast that does not rebuild the media grid.
 * Success auto-dismisses (~3s); error stays until closed.
 */
export function showTransientNotice(message: string, kind: "success" | "error" = "success"): void {
  if (!message) return;
  clearTransientNotice();
  const sticky = app.querySelector(".sticky-controls");
  if (!sticky) return;
  sticky.insertAdjacentHTML(
    "afterend",
    `<div class="notice-banner toast-in${kind === "error" ? " is-error" : " is-success"}" id="batch-notice" role="${kind === "error" ? "alert" : "status"}"><span class="notice-icon">${kind === "error" ? "!" : "✓"}</span><span>${escapeHtml(message)}</span><button class="text-button" id="dismiss-batch-notice" type="button">关闭</button></div>`,
  );
  app.querySelector<HTMLButtonElement>("#dismiss-batch-notice")?.addEventListener("click", () => {
    clearTransientNotice();
  });
  if (kind === "success") {
    transientNoticeTimer = setTimeout(() => {
      transientNoticeTimer = null;
      app.querySelector("#batch-notice")?.remove();
    }, 3000);
  }
}
