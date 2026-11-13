import { describe, expect, it } from "vitest";
import {
  installPaint,
  bindEmptyStateEvents,
  bindMergeFooterEvents,
  bindMergeModalEvents,
  bindSettingsEvents,
  bindShellEvents,
  bindSidebarEvents,
  bindStatusEvents,
  bindToolbarEvents,
  bindPreviewMetaEvents,
  bindEditorFooterEvents,
  loadMoreScrollRoot,
  openSettings,
  persistUiPrefs,
  refreshMedia,
  render,
  renderSettingsAware,
  showTransientNotice,
  updateLoadMoreFooter,
  updateSettingsPanel,
} from "./paint";

// 回归：main.ts 曾把 render/paint 的门面函数当成实现注入 installPaint，
// 第一次重绘就自我递归爆栈，界面只剩空骨架（内容区全空）。
describe("installPaint", () => {
  it("rejects a host wired back to the facade itself", () => {
    expect(() =>
      installPaint({
        render,
        refreshMedia,
        renderSettingsAware,
        updateSettingsPanel,
        persistUiPrefs,
        showTransientNotice,
        openSettings,
        loadMoreScrollRoot,
        updateLoadMoreFooter,
        bindShellEvents,
        bindSidebarEvents,
        bindStatusEvents,
        bindToolbarEvents,
        bindEmptyStateEvents,
        bindMergeModalEvents,
        bindMergeFooterEvents,
        bindSettingsEvents,
        bindPreviewMetaEvents,
        bindEditorFooterEvents,
      }),
    ).toThrow(/门面自身/);
  });

  it("names the offending member so the bad import is easy to find", () => {
    const noop = () => undefined;
    const host = {
      render: noop,
      refreshMedia: async () => undefined,
      renderSettingsAware: noop,
      updateSettingsPanel: noop,
      persistUiPrefs: async () => undefined,
      showTransientNotice: noop,
      openSettings: async () => undefined,
      loadMoreScrollRoot: () => null,
      updateLoadMoreFooter: noop,
      bindShellEvents: noop,
      bindSidebarEvents: noop,
      bindStatusEvents: noop,
      bindToolbarEvents: noop,
      bindEmptyStateEvents: noop,
      bindMergeModalEvents: noop,
      bindMergeFooterEvents: noop,
      bindSettingsEvents: noop,
      // 只错一个：其余都是真实实现，这一项是门面壳。
      bindPreviewMetaEvents,
      bindEditorFooterEvents: () => undefined,
    };
    expect(() => installPaint(host)).toThrow(/bindPreviewMetaEvents/);
  });

  it("accepts distinct implementations and routes calls to them", () => {
    let rendered = 0;
    installPaint({
      render: () => {
        rendered += 1;
      },
      refreshMedia: async () => undefined,
      renderSettingsAware: () => undefined,
      updateSettingsPanel: () => undefined,
      persistUiPrefs: async () => undefined,
      showTransientNotice: () => undefined,
      openSettings: async () => undefined,
      loadMoreScrollRoot: () => null,
      updateLoadMoreFooter: () => undefined,
      bindShellEvents: () => undefined,
      bindSidebarEvents: () => undefined,
      bindStatusEvents: () => undefined,
      bindToolbarEvents: () => undefined,
      bindEmptyStateEvents: () => undefined,
      bindMergeModalEvents: () => undefined,
      bindMergeFooterEvents: () => undefined,
      bindSettingsEvents: () => undefined,
      bindPreviewMetaEvents: () => undefined,
      bindEditorFooterEvents: () => undefined,
    });
    render();
    expect(rendered).toBe(1);
  });
});
