/**
 * Toast —— 「结果」通道。fixed 在右下角，跟内容滚动无关。
 *
 * 队列语义（纯函数部分可直接单测，不需要 jsdom）：
 *   - 同 key 合并：连续点收藏只留一条，不会互相顶掉；
 *   - 屏上最多 3 条，多出来的排队等待，某条消失后自动递补；
 *   - 成功 / 信息 4s 自动消失，错误默认常驻并带关闭。
 *
 * DOM 部分只在本模块里：toast 的按钮是闭包，不走全局 data-action 委托，
 * 因为动作本身就存在队列条目里。
 */
export type ToastKind = "success" | "error" | "info";

export interface ToastAction {
  label: string;
  run: () => void;
}

export interface ToastOptions {
  kind?: ToastKind;
  action?: ToastAction;
  /** 毫秒；0 = 常驻。缺省按 kind 决定（错误常驻，其余 4s）。 */
  timeout?: number;
  /** 合并键：同 key 原地替换而不是新增一条。 */
  key?: string;
}

export interface ToastEntry {
  key: string;
  kind: ToastKind;
  message: string;
  action?: ToastAction;
  timeout: number;
}

export interface ToastQueue {
  visible: ToastEntry[];
  pending: ToastEntry[];
}

/** 屏上上限。 */
export const TOAST_LIMIT = 3;

/** 成功 / 信息的默认停留时长。 */
export const TOAST_DEFAULT_MS = 4000;

/** 错误默认常驻：用户必须自己关掉，避免「一眼没看见就没了」。 */
export function defaultToastTimeout(kind: ToastKind): number {
  return kind === "error" ? 0 : TOAST_DEFAULT_MS;
}

function mergeByKey(list: ToastEntry[], entry: ToastEntry): ToastEntry[] {
  return list.map((item) => (item.key === entry.key ? entry : item));
}

/** 入队：同 key 合并；有空位就上屏，否则排队。 */
export function enqueueToastEntry(queue: ToastQueue, entry: ToastEntry, limit: number = TOAST_LIMIT): ToastQueue {
  if (queue.visible.some((item) => item.key === entry.key)) {
    return { visible: mergeByKey(queue.visible, entry), pending: queue.pending };
  }
  if (queue.pending.some((item) => item.key === entry.key)) {
    return { visible: queue.visible, pending: mergeByKey(queue.pending, entry) };
  }
  if (queue.visible.length < limit) {
    return { visible: [...queue.visible, entry], pending: queue.pending };
  }
  return { visible: queue.visible, pending: [...queue.pending, entry] };
}

/** 出队：移除一条；空出位置时从队首递补。 */
export function removeToastEntry(queue: ToastQueue, key: string, limit: number = TOAST_LIMIT): ToastQueue {
  const visible = queue.visible.filter((item) => item.key !== key);
  let pending = queue.pending.filter((item) => item.key !== key);
  while (visible.length < limit && pending.length > 0) {
    const [next, ...rest] = pending;
    visible.push(next);
    pending = rest;
  }
  return { visible, pending };
}

// ---------------------------------------------------------------------------
// 运行时 + DOM
// ---------------------------------------------------------------------------

let queue: ToastQueue = { visible: [], pending: [] };

const timers = new Map<string, ReturnType<typeof setTimeout>>();
const elements = new Map<string, HTMLElement>();
let hostRef: HTMLElement | null = null;

function clearTimer(key: string): void {
  const timer = timers.get(key);
  if (timer !== undefined) {
    clearTimeout(timer);
    timers.delete(key);
  }
}

function armTimer(entry: ToastEntry): void {
  if (entry.timeout <= 0) return;
  timers.set(
    entry.key,
    setTimeout(() => dismissToast(entry.key), entry.timeout),
  );
}

function syncTimers(): void {
  const visibleKeys = new Set(queue.visible.map((entry) => entry.key));
  for (const key of [...timers.keys()]) {
    if (visibleKeys.has(key)) continue;
    clearTimer(key);
  }
  for (const entry of queue.visible) {
    if (timers.has(entry.key)) continue;
    armTimer(entry);
  }
}

function toastHost(): HTMLElement | null {
  const node = document.querySelector<HTMLElement>("#toast-host");
  if (node !== hostRef) {
    // 骨架重建过：旧节点连同 elements 表一起作废，重新按队列铺一遍。
    elements.clear();
    hostRef = node;
  }
  return node;
}

function elementSignature(entry: ToastEntry): string {
  return `${entry.kind}|${entry.action?.label ?? ""}|${entry.message}`;
}

function createToastElement(entry: ToastEntry): HTMLElement {
  const toast = document.createElement("div");
  toast.className = `toast is-${entry.kind}`;
  toast.dataset.toastKey = entry.key;
  toast.dataset.signature = elementSignature(entry);
  toast.setAttribute("role", entry.kind === "error" ? "alert" : "status");

  const icon = document.createElement("span");
  icon.className = "toast-icon";
  icon.setAttribute("aria-hidden", "true");
  icon.textContent = entry.kind === "success" ? "✓" : entry.kind === "error" ? "!" : "i";

  const copy = document.createElement("div");
  copy.className = "toast-copy";
  const message = document.createElement("span");
  message.className = "toast-message";
  message.textContent = entry.message;
  copy.appendChild(message);
  toast.append(icon, copy);

  if (entry.action) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "text-button toast-action";
    button.textContent = entry.action.label;
    button.addEventListener("click", () => {
      const run = entry.action?.run;
      dismissToast(entry.key);
      run?.();
    });
    toast.appendChild(button);
  }

  const close = document.createElement("button");
  close.type = "button";
  close.className = "toast-close";
  close.setAttribute("aria-label", "关闭提示");
  close.textContent = "×";
  close.addEventListener("click", () => dismissToast(entry.key));
  toast.appendChild(close);

  return toast;
}

function renderToastHost(): void {
  const host = toastHost();
  if (!host) return;
  const alive = new Set(queue.visible.map((entry) => entry.key));
  for (const [key, element] of elements) {
    if (alive.has(key)) continue;
    element.remove();
    elements.delete(key);
  }
  let previous: HTMLElement | null = null;
  for (const entry of queue.visible) {
    let element = elements.get(entry.key);
    if (element && element.dataset.signature !== elementSignature(entry)) {
      // 同 key 内容变了（例如「收藏 3 项」→「收藏 5 项」）：原地换节点，位置不动。
      const next = createToastElement(entry);
      element.replaceWith(next);
      element = next;
      elements.set(entry.key, next);
    } else if (!element) {
      element = createToastElement(entry);
      elements.set(entry.key, element);
    }
    const anchor: ChildNode | null = previous ? previous.nextSibling : host.firstChild;
    if (anchor !== element) host.insertBefore(element, anchor);
    previous = element;
  }
}

/**
 * 弹一条结果提示。message 是给人看的一句话；技术细节不要塞这里。
 */
export function showToast(message: string, options: ToastOptions = {}): void {
  if (!message) return;
  const kind = options.kind ?? "success";
  const entry: ToastEntry = {
    key: options.key ?? `${kind}:${message}`,
    kind,
    message,
    action: options.action,
    timeout: options.timeout ?? defaultToastTimeout(kind),
  };
  // 同 key 再来一次 = 重新计时（并可能换了文案），而不是叠一条新的。
  clearTimer(entry.key);
  queue = enqueueToastEntry(queue, entry);
  renderToastHost();
  syncTimers();
}

export function dismissToast(key: string): void {
  if (!queue.visible.some((item) => item.key === key) && !queue.pending.some((item) => item.key === key)) return;
  clearTimer(key);
  queue = removeToastEntry(queue, key);
  renderToastHost();
  syncTimers();
}

export function clearToasts(): void {
  for (const key of [...timers.keys()]) clearTimer(key);
  queue = { visible: [], pending: [] };
  for (const element of elements.values()) element.remove();
  elements.clear();
}

/** 单测用：只看队列，不碰 DOM。 */
export function toastQueueSnapshot(): ToastQueue {
  return { visible: queue.visible.slice(), pending: queue.pending.slice() };
}
