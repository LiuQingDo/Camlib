// 由 main.ts 拆分而来：仅做搬移，未改动逻辑。

export const appRoot = document.querySelector<HTMLElement>("#app");

if (!appRoot) throw new Error("找不到应用容器");

export const app: HTMLElement = appRoot;

// ---------------------------------------------------------------------------
// 分区增量渲染（S3b）
//
// 改造前 render() 用 app.innerHTML 重建整个界面，再整套重跑 bindEvents /
// applyDialogSizes / setupDialogResizing / syncLiquidGlass，于是散落了一批
// “重建后补偿”代码（手存滚动位置、重放预览、恢复标签弹层滚动、重挂玻璃）。
// 现在骨架只建一次，之后按区域 patch：
//
//   renderShell()    —— 启动 / 切换媒体库时建骨架，产出稳定的挂载点。
//   patchSidebar()   —— 侧栏四块各自整块 patch（无图片，整块可接受）。
//   patchToolbar()   —— 标题 / 状态横幅 / 筛选行 / 选择工具栏；排序与密度滑块
//                       只同步值，绝不替换节点（否则拖动会断）。
//   patchGrid()      —— 卡片按 data-id keyed 复用，只改变化字段，<img> 不重建。
//   renderOverlays() —— 每个弹窗独立容器，互不牵连；预览按签名复用。
//
// 骨架不重建 ⇒ 滚动位置自然保持、搜索框不丢焦点、缩略图不重新解码、已挂上的
// inline backdrop-filter 也不会被冲掉（新出现的玻璃表面见 liquid-glass 观察器）。
// ---------------------------------------------------------------------------

/** 区域容器 → 上次写入的 HTML；相同就跳过，避免无意义的 DOM 重建。 */
export const regionHtmlCache = new WeakMap<HTMLElement, string>();

/** 网格区走节点级 reconcile，不用 HTML 缓存；占位值永不等于真实 HTML。 */
export const GRID_REGION = "::grid::";

/** 按 data-region 取稳定挂载点。 */
export function region(name: string): HTMLElement | null {
  return app.querySelector<HTMLElement>(`[data-region="${name}"]`);
}

/**
 * 区域级写入：渲染结果没变就不动 DOM。
 * 返回 true 表示这块真的被重建了，调用方据此决定是否重绑事件。
 */
export function setRegionHtml(element: HTMLElement | null, html: string): boolean {
  if (!element) return false;
  if (regionHtmlCache.get(element) === html) return false;
  regionHtmlCache.set(element, html);
  element.innerHTML = html;
  return true;
}

/** 只写不一样的文本节点——为了改一个数字重设整段 innerHTML 才是傻的。 */
export function setText(element: Element | null | undefined, text: string): void {
  if (element && element.textContent !== text) element.textContent = text;
}

/** 渲染片段 → 元素。<template> 内容不会提前解码其中的 <img>。 */
export function fragmentElement(html: string): HTMLElement | null {
  const template = document.createElement("template");
  template.innerHTML = html;
  return template.content.firstElementChild as HTMLElement | null;
}

/** 幂等绑定：同节点同事件只挂一次，区域 patch 后可以放心整块重跑 binder。 */
export function bind(element: Element | null | undefined, type: string, handler: EventListener): void {
  if (!(element instanceof HTMLElement)) return;
  const key = `bound${type}`;
  if (element.dataset[key] === "1") return;
  element.dataset[key] = "1";
  element.addEventListener(type, handler);
}

/** 在 app 范围内按选择器幂等绑定。 */
export function bindAll(selector: string, type: string, handler: EventListener): void {
  app.querySelectorAll(selector).forEach((element) => bind(element, type, handler));
}
