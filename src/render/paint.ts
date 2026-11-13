/**
 * 重绘门面（paint host）。
 *
 * 视图层（render/ 与 views/）只负责「画」，不认识 app/ 里的动作与绑定。但区域
 * patch 之后要重绑事件、动作执行完要重绘，这些能力天然在 app 层，直接互相
 * import 会形成 A→B→A 的静态环。
 *
 * 所以这里放一层纯接口：视图只依赖本文件，具体实现由 main.ts 在启动时用
 * installPaint() 注入一次。门面自身不 import 任何业务模块，静态依赖图因此保持
 * 单向；注入发生在任何交互之前，运行期没有「未装配」的窗口。
 */
import { DialogSize, UiPreviewMode, UiTheme } from "../api/infrastructure";
import { MediaItemDto } from "../api/media";
import { SettingsSection, SortMode } from "../state";

export type UiPrefsPatch = {
  uiDensity?: number;
  uiSort?: SortMode;
  uiPreviewMode?: UiPreviewMode;
  uiTheme?: UiTheme;
  uiDialogSizes?: Record<string, DialogSize>;
};

export type PaintHost = {
  render: () => void;
  refreshMedia: () => Promise<void>;
  renderSettingsAware: () => void;
  updateSettingsPanel: (options?: { animate?: boolean }) => void;
  persistUiPrefs: (input: UiPrefsPatch) => Promise<void>;
  showTransientNotice: (message: string, kind?: "success" | "error") => void;
  openSettings: (section?: SettingsSection) => Promise<void>;
  loadMoreScrollRoot: () => Element | null;
  updateLoadMoreFooter: () => void;
  bindShellEvents: () => void;
  bindSidebarEvents: () => void;
  bindStatusEvents: () => void;
  bindToolbarEvents: () => void;
  bindEmptyStateEvents: () => void;
  bindMergeModalEvents: () => void;
  bindMergeFooterEvents: () => void;
  bindSettingsEvents: () => void;
  bindPreviewMetaEvents: (panel: HTMLElement, item: MediaItemDto) => void;
  bindEditorFooterEvents: (modal: HTMLElement) => void;
};

let host: PaintHost | null = null;

/** 由 main.ts 在启动装配阶段调用一次。 */
export function installPaint(next: PaintHost): void {
  host = next;
}

function paint(): PaintHost {
  if (!host) throw new Error("渲染宿主尚未装配：main.ts 启动时应先调用 installPaint()");
  return host;
}

export function render(): void {
  paint().render();
}

export function refreshMedia(): Promise<void> {
  return paint().refreshMedia();
}

export function renderSettingsAware(): void {
  paint().renderSettingsAware();
}

export function updateSettingsPanel(options?: { animate?: boolean }): void {
  paint().updateSettingsPanel(options);
}

export function persistUiPrefs(input: UiPrefsPatch): Promise<void> {
  return paint().persistUiPrefs(input);
}

export function showTransientNotice(message: string, kind: "success" | "error" = "success"): void {
  paint().showTransientNotice(message, kind);
}

export function openSettings(section?: SettingsSection): Promise<void> {
  return paint().openSettings(section);
}

export function loadMoreScrollRoot(): Element | null {
  return paint().loadMoreScrollRoot();
}

export function updateLoadMoreFooter(): void {
  paint().updateLoadMoreFooter();
}

export function bindShellEvents(): void {
  paint().bindShellEvents();
}

export function bindSidebarEvents(): void {
  paint().bindSidebarEvents();
}

export function bindStatusEvents(): void {
  paint().bindStatusEvents();
}

export function bindToolbarEvents(): void {
  paint().bindToolbarEvents();
}

export function bindEmptyStateEvents(): void {
  paint().bindEmptyStateEvents();
}

export function bindMergeModalEvents(): void {
  paint().bindMergeModalEvents();
}

export function bindMergeFooterEvents(): void {
  paint().bindMergeFooterEvents();
}

export function bindSettingsEvents(): void {
  paint().bindSettingsEvents();
}

export function bindPreviewMetaEvents(panel: HTMLElement, item: MediaItemDto): void {
  paint().bindPreviewMetaEvents(panel, item);
}

export function bindEditorFooterEvents(modal: HTMLElement): void {
  paint().bindEditorFooterEvents(modal);
}
