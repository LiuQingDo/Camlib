/**
 * 弹窗进出场（页面切换）的过渡窗口。
 *
 * 打开或关闭一个弹窗时，两件昂贵的事情恰好撞在同一段时间里：
 *
 *  1. 入场/退场动画每帧都在改 transform/opacity。面板上挂着 liquid-glass 写进去的
 *     内联 SVG 位移贴图（`backdrop-filter: url(#lg-filter-*)`），而这个贴图是按元素
 *     当前尺寸生成的——元素一边缩放一边被重采样，整条滤镜链要按新位置逐帧重放。
 *  2. 玻璃观察器在紧接着的 rAF 里对刚插入的面板做一次测量 + canvas 生成位移图 +
 *     `toDataURL()`，全部落在动画正在跑的那几帧上。
 *
 * 于是"打开设置/预览时顿一下"的主因不在 DOM 构建，而在这段过渡。做法和滚动降级
 * 完全一致：过渡窗口里把位移贴图摘掉，留下同一档纯模糊（尺寸与亮度不变，只少了
 * 边缘折射带），结束之后全量同步一次把折射带补回来。静止画面逐像素不变。
 *
 * 开关同时挂在 `<html>` 上（`is-overlay-animating`）和 liquid-glass 的模块状态上：
 * CSS 需要对其它元素做降级，JS 需要跳过位移图生成。
 */
import { setGlassDisplacementPaused, syncLiquidGlass } from "../liquid-glass";

/** 最长的一条入场动画是 `.preview-modal` 的 280ms。 */
export const OVERLAY_ENTER_MS = 320;

/** 退场动画时长（与 styles.css 里的 overlay-fade-out 对齐）。 */
export const OVERLAY_LEAVE_MS = 140;

/** 系统开了"减少动效"时，过渡窗口缩到肉眼不可见的量级。 */
const REDUCED_MS = 60;

let timer: number | null = null;
let active = false;

function prefersReducedMotion(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

function stop(): void {
  if (timer !== null) {
    window.clearTimeout(timer);
    timer = null;
  }
  if (!active) return;
  active = false;
  document.documentElement.classList.remove("is-overlay-animating");
  setGlassDisplacementPaused(false);
  // 过渡期间位移贴图被摘掉，结束后补一次全量同步把折射带还回来。
  requestAnimationFrame(() => syncLiquidGlass());
}

/**
 * 进入过渡窗口：立刻降级并同步一次（保证动画第一帧就不带折射带），
 * `ms` 之后自动收尾。重复调用会重排尾定时器——连续开关弹窗不会中途恢复。
 */
export function beginOverlayTransition(ms: number): void {
  const duration = prefersReducedMotion() ? Math.min(ms, REDUCED_MS) : ms;
  if (duration <= 0) {
    stop();
    return;
  }
  const first = !active || !document.documentElement.classList.contains("is-overlay-animating");
  document.documentElement.classList.add("is-overlay-animating");
  setGlassDisplacementPaused(true);
  // 只在刚进入窗口时同步一次：后面每帧都同步反而会把测量摊到动画里。
  if (first) syncLiquidGlass();
  active = true;
  if (timer !== null) window.clearTimeout(timer);
  timer = window.setTimeout(() => {
    timer = null;
    stop();
  }, duration);
}
