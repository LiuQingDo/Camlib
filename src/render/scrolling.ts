/**
 * 滚动期降级开关。
 *
 * 网格里每张卡片自带 3 个 `backdrop-filter`（选择/收藏按钮 + 类型角标 + 时长
 * 胶囊），滚动窗口里同时挂着的卡片乘以 3 就是上百个需要每帧重采样背景的合成
 * 层；`.sticky-controls` 更是粘在滚动容器里，位置每帧都在动。这两件事叠加，
 * 滚动时掉帧的主因不在虚拟滚动的算术上，而在合成器。
 *
 * 所以滚动的这一小段时间里把「只有静止时才看得出来」的玻璃质感降一档：
 * 徽章直接去掉模糊（它们的底色本来就是不透明度 .42–.58 的纯黑，模糊在移动
 * 画面里根本分辨不出），粘性工具条保留同一档模糊、只摘掉边缘位移贴图。指针
 * 停下来 `SCROLL_IDLE_MS` 之后原样恢复，静止画面逐像素不变。
 *
 * 标记挂在 `<html>` 上而不是 `#app`：滚动条、滚动容器本身也在降级范围内。
 */
const SCROLL_IDLE_MS = 180;

let idleTimer: number | null = null;
let scrolling = false;
let bound = false;

const listeners: Array<(scrolling: boolean) => void> = [];

export function isScrolling(): boolean {
  return scrolling;
}

/** 滚动态翻转时回调；用来暂停那些「只在静止时才有意义」的观察器。 */
export function onScrollingChange(listener: (scrolling: boolean) => void): void {
  listeners.push(listener);
}

function setScrolling(next: boolean): void {
  if (next === scrolling) return;
  scrolling = next;
  document.documentElement.classList.toggle("is-scrolling", next);
  for (const listener of listeners) listener(next);
}

/**
 * 一次滚动位移。每次事件都重排尾定时器，指针停住才算结束——用「最后一次滚动
 * 之后再等一会儿」而不是「按频率判断」，连续滚动不会中途恢复。
 */
export function markScrolled(): void {
  if (document.hidden) return;
  setScrolling(true);
  if (idleTimer !== null) window.clearTimeout(idleTimer);
  idleTimer = window.setTimeout(() => {
    idleTimer = null;
    setScrolling(false);
  }, SCROLL_IDLE_MS);
}

/** 滚动事件源是不是「会让画面整体位移」的那个容器。 */
function isPageScroller(target: EventTarget | null): boolean {
  if (target === null || target === document) return true;
  if (target === document.documentElement || target === document.body) return true;
  return target instanceof Element && target.classList.contains("content");
}

/**
 * 绑定滚动监听。用捕获阶段挂 window：`.content` 是滚动容器，窄屏下退化成
 * body 滚动，一条监听同时覆盖两种布局，不必在骨架 patch 之后重绑。
 */
export function initScrolling(): void {
  if (bound) return;
  bound = true;
  window.addEventListener(
    "scroll",
    (event) => {
      if (isPageScroller(event.target)) markScrolled();
    },
    { passive: true, capture: true },
  );
}
