import { getCurrentWindow } from "@tauri-apps/api/window";

const ICON_MINIMIZE = `<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2.25 6.2h7.5" fill="none" stroke="currentColor" stroke-width="1.15" stroke-linecap="round"/></svg>`;
const ICON_MAXIMIZE = `<svg viewBox="0 0 12 12" aria-hidden="true"><rect x="2.35" y="2.35" width="7.3" height="7.3" rx="1" fill="none" stroke="currentColor" stroke-width="1.1"/></svg>`;
const ICON_RESTORE = `<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M3.9 3.5V2.9c0-.55.45-1 1-1h3.7c.55 0 1 .45 1 1v3.7c0 .55-.45 1-1 1h-.6" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/><rect x="2.2" y="3.9" width="5.9" height="5.9" rx="1" fill="none" stroke="currentColor" stroke-width="1.1"/></svg>`;
const ICON_CLOSE = `<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M3.35 3.35l5.3 5.3M8.65 3.35l-5.3 5.3" fill="none" stroke="currentColor" stroke-width="1.15" stroke-linecap="round"/></svg>`;

const appWindow = getCurrentWindow();

export function initTitlebar(): void {
  const root = document.getElementById("app-titlebar");
  if (!root) return;

  const maximize = root.querySelector<HTMLButtonElement>("#titlebar-maximize");
  if (maximize) maximize.innerHTML = ICON_MAXIMIZE;
  const minimize = root.querySelector<HTMLButtonElement>("#titlebar-minimize");
  if (minimize) minimize.innerHTML = ICON_MINIMIZE;
  const close = root.querySelector<HTMLButtonElement>("#titlebar-close");
  if (close) close.innerHTML = ICON_CLOSE;

  minimize?.addEventListener("click", () => {
    void appWindow.minimize();
  });
  maximize?.addEventListener("click", () => {
    void appWindow.toggleMaximize().then(syncMaximizeIcon);
  });
  close?.addEventListener("click", () => {
    // Rust close handler still applies (quit vs minimize-to-tray).
    void appWindow.close();
  });

  root.querySelectorAll<HTMLElement>("[data-tauri-drag-region]").forEach((el) => {
    el.addEventListener("dblclick", () => {
      void appWindow.toggleMaximize().then(syncMaximizeIcon);
    });
  });

  void syncMaximizeIcon();
  void appWindow.onResized(() => {
    void syncMaximizeIcon();
  });
}

async function syncMaximizeIcon(): Promise<void> {
  const btn = document.getElementById("titlebar-maximize");
  if (!btn) return;
  try {
    const maximized = await appWindow.isMaximized();
    btn.classList.toggle("is-maximized", maximized);
    btn.innerHTML = maximized ? ICON_RESTORE : ICON_MAXIMIZE;
    btn.setAttribute("aria-label", maximized ? "还原" : "最大化");
    btn.title = maximized ? "还原" : "最大化";
  } catch {
    // Browser preview without Tauri window APIs.
  }
}
