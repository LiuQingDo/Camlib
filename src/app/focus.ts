/**
 * 模态焦点管理（预览 / 删除确认 / 标签管理 / 编辑器 / 合并 / 设置 / 导入抽屉）。
 *
 * 三个契约，缺一不可——少了任何一条，`aria-modal="true"` 都只是一句口号：
 *
 *   1. 焦点进入：打开时把焦点放进 `[data-autofocus]`；没有就取容器里第一个可
 *      聚焦元素；连一个都没有（纯文字弹窗）就把容器本身临时设成 `tabindex="-1"`。
 *   2. Tab 循环：容器内 Tab / Shift+Tab 首尾相接，不跑到弹窗外面。焦点被点到
 *      弹窗外的空白处时（activeElement 变成 body），下一次 Tab 也会被拉回来。
 *   3. 背景 inert：`.shell` 挂 `inert`，遮罩后面的界面既不可点也不可 Tab 到。
 *      用计数栈记录嵌套层数：只有最上层响应键盘，关掉一层不会误解锁背景。
 *
 * 关闭时 release() 把焦点还给打开前的元素——键盘用户不会"丢"在页面顶部。
 *
 * 纯逻辑（nextFocusIndex / nextInertDepth / isTopOfStack）单独抽出来是为了能
 * 单测：仓库的 vitest 跑在 node 环境，没有 DOM。模块顶层不碰 document，
 * 需要 DOM 的副作用全部放在函数里（含 focusin 守卫的延迟注册）。
 */

export interface TrapOptions {
  /** 覆盖 `[data-autofocus]`：强制指定打开时聚焦哪个元素（相对容器的选择器）。 */
  initialFocus?: string;
  /**
   * Esc：只由最上层调用。缺省时不拦 Esc，让它继续冒泡回全局 keydown 的阶梯
   * （设置面板里还有二级确认、导入抽屉运行中要先提示，这些都在那边）。
   */
  onClose?: () => void;
}

/** release(restoreFocus = true)：重建内容时传 false，别把焦点抢回旧位置。 */
export type ReleaseTrap = (restoreFocus?: boolean) => void;

interface TrapRecord {
  container: HTMLElement;
  previousFocus: HTMLElement | null;
  onClose?: () => void;
  handler: (event: KeyboardEvent) => void;
  released: boolean;
}

/** 可聚焦元素的候选集。是否真的能 Tab 到由 isFocusable() 再筛一遍。 */
const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button",
  "input",
  "select",
  "textarea",
  "summary",
  "[contenteditable='true']",
  "[tabindex]",
].join(",");

/** 后进先出：数组末尾就是最上层。 */
const traps: TrapRecord[] = [];

/** inert 计数栈的深度（>0 即背景锁定）。 */
let inertDepth = 0;

let focusGuardBound = false;

// ---------------------------------------------------------------------------
// 纯逻辑
// ---------------------------------------------------------------------------

/**
 * Tab 循环的下一个下标。
 * `current < 0` 表示焦点不在容器内：向后从第一个开始，向前从最后一个开始。
 */
export function nextFocusIndex(current: number, count: number, backwards: boolean): number {
  if (count <= 0) return -1;
  if (current < 0 || current >= count) return backwards ? count - 1 : 0;
  return backwards ? (current - 1 + count) % count : (current + 1) % count;
}

/** inert 计数栈：只有最外层解开（深度回到 0）才算真的解锁。 */
export function nextInertDepth(depth: number, push: boolean): number {
  return push ? depth + 1 : Math.max(0, depth - 1);
}

/** 是否是最上层——只有它能处理 Tab / Esc。 */
export function isTopOfStack<T>(stack: readonly T[], entry: T): boolean {
  return stack.length > 0 && stack[stack.length - 1] === entry;
}

// ---------------------------------------------------------------------------
// 可聚焦元素
// ---------------------------------------------------------------------------

function isFocusable(element: HTMLElement): boolean {
  if (element.hasAttribute("disabled")) return false;
  if (element.hidden) return false;
  if (element.getAttribute("aria-hidden") === "true") return false;
  // tabindex="-1" 可被脚本聚焦但不在 Tab 序列里，循环时要跳过。
  if (element.tabIndex < 0) return false;
  if (element instanceof HTMLInputElement && element.type === "hidden") return false;
  // `hidden` 属性只标在自己身上；父级隐藏要靠计算样式兜住。
  const style = window.getComputedStyle(element);
  return style.display !== "none" && style.visibility !== "hidden";
}

/** 容器内能 Tab 到的元素，按 DOM 顺序。容器自身不参与。 */
export function focusableElements(container: HTMLElement): HTMLElement[] {
  const found = container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
  const result: HTMLElement[] = [];
  for (const element of found) {
    if (isFocusable(element)) result.push(element);
  }
  return result;
}

function pickInitial(container: HTMLElement, initialFocus?: string): HTMLElement | null {
  if (initialFocus) {
    const explicit = container.querySelector<HTMLElement>(initialFocus);
    if (explicit && isFocusable(explicit)) return explicit;
  }
  const auto = container.querySelector<HTMLElement>("[data-autofocus]");
  if (auto && isFocusable(auto)) return auto;
  return focusableElements(container)[0] ?? null;
}

/**
 * 把焦点放进容器：`initialFocus` → `[data-autofocus]` → 第一个可聚焦元素 → 容器本身。
 * 容器上留一个 `tabindex="-1"` 是 ARIA 对对话框的推荐做法，也让"纯文字弹窗"
 * 仍然有键盘落点（否则 keydown 事件根本落不到容器上）。
 */
export function focusInside(container: HTMLElement, initialFocus?: string): HTMLElement {
  const target = pickInitial(container, initialFocus);
  if (target) {
    target.focus({ preventScroll: true });
    return target;
  }
  if (!container.hasAttribute("tabindex")) container.setAttribute("tabindex", "-1");
  container.focus({ preventScroll: true });
  return container;
}

// ---------------------------------------------------------------------------
// 背景 inert
// ---------------------------------------------------------------------------

/** 背景锁定的当前深度（0 = 背景可交互）。调试与单测用。 */
export function backgroundInertDepth(): number {
  return inertDepth;
}

/**
 * 背景 inert 的 push / pop。
 *
 * 一层弹窗压一层栈：预览上叠编辑器时 shell 只被锁一次，关掉编辑器只让计数
 * 从 2 回到 1，背景仍然不可交互；预览也关掉才真正解锁。
 */
export function setBackgroundInert(push: boolean): void {
  inertDepth = nextInertDepth(inertDepth, push);
  const shell = document.querySelector<HTMLElement>(".shell");
  if (!shell) return;
  if (inertDepth > 0) {
    shell.setAttribute("inert", "");
    return;
  }
  shell.removeAttribute("inert");
}

// ---------------------------------------------------------------------------
// 焦点陷阱
// ---------------------------------------------------------------------------

/** 焦点跑到最上层弹窗之外时拉回来。toast 例外（它在弹窗之上，仍要能点）。 */
function onDocumentFocusIn(event: FocusEvent): void {
  const record = traps[traps.length - 1];
  if (!record || record.released) return;
  const target = event.target;
  if (!(target instanceof Node)) return;
  if (record.container.contains(target)) return;
  if (target instanceof Element && target.closest("#toast-host")) return;
  focusInside(record.container);
}

function bindFocusGuard(): void {
  if (focusGuardBound) return;
  focusGuardBound = true;
  document.addEventListener("focusin", onDocumentFocusIn, true);
}

function onTrapKeydown(record: TrapRecord, event: KeyboardEvent): void {
  if (record.released) return;
  // 嵌套时只有最上层响应：下层弹窗的 Tab/Esc 一律让路。
  if (!isTopOfStack(traps, record)) return;
  if (event.key === "Tab") {
    const items = focusableElements(record.container);
    if (items.length === 0) {
      event.preventDefault();
      focusInside(record.container);
      return;
    }
    const active = document.activeElement;
    const current = active instanceof HTMLElement ? items.indexOf(active) : -1;
    const next = nextFocusIndex(current, items.length, event.shiftKey);
    if (next < 0) return;
    event.preventDefault();
    items[next].focus({ preventScroll: true });
    return;
  }
  if (event.key !== "Escape" || !record.onClose) return;
  event.preventDefault();
  // 关键：拦在这里，同一次 Esc 不会再冒到 window 上的全局分派去关第二层。
  event.stopPropagation();
  record.onClose();
}

function releaseTrap(record: TrapRecord, restoreFocus: boolean): void {
  if (record.released) return;
  record.released = true;
  record.container.removeEventListener("keydown", record.handler);
  const index = traps.indexOf(record);
  if (index >= 0) traps.splice(index, 1);
  setBackgroundInert(false);
  if (!restoreFocus) return;
  const target = record.previousFocus;
  if (!target || !target.isConnected) return;
  // 焦点已经被别人挪走（例如调用方把焦点放进了新弹窗）就别抢回来。
  const active = document.activeElement;
  if (active && active !== document.body && !record.container.contains(active)) return;
  target.focus({ preventScroll: true });
}

/**
 * 清掉容器已脱离文档的陷阱（骨架强制重建后残留的那些）。
 * 不清理的话 inert 计数会永远停在 >0，整个界面被锁死。
 */
export function pruneDetachedTraps(): void {
  for (let index = traps.length - 1; index >= 0; index -= 1) {
    const record = traps[index];
    if (record.container.isConnected) continue;
    record.released = true;
    record.container.removeEventListener("keydown", record.handler);
    traps.splice(index, 1);
    setBackgroundInert(false);
  }
}

/**
 * 把容器变成模态焦点区：焦点进入 + Tab 循环 + 背景 inert + 关闭返还焦点。
 * 返回的 release() 必须由调用方在关闭时执行（一次即可，重复调用无害）。
 */
export function trapDialogFocus(container: HTMLElement, opts: TrapOptions = {}): ReleaseTrap {
  pruneDetachedTraps();
  bindFocusGuard();
  const active = document.activeElement;
  const record: TrapRecord = {
    container,
    previousFocus: active instanceof HTMLElement ? active : null,
    onClose: opts.onClose,
    handler: (event) => onTrapKeydown(record, event),
    released: false,
  };
  traps.push(record);
  container.addEventListener("keydown", record.handler);
  setBackgroundInert(true);
  focusInside(container, opts.initialFocus);
  return (restoreFocus = true) => releaseTrap(record, restoreFocus);
}
