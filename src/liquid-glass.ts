/**
 * Liquid Glass edge-refraction for UI panels.
 *
 * Adapted from shuding/liquid-glass (MIT, © 2025 Shu Ding)
 * https://github.com/shuding/liquid-glass
 *
 * Builds an SVG feDisplacementMap from a canvas-generated rounded-rect SDF,
 * then applies it via backdrop-filter so panel rims bend the backdrop like
 * thick glass. Falls back to plain CSS blur when the runtime rejects SVG
 * filters in backdrop-filter.
 */

type GlassStyle = {
  /** 0–1 — how hard the rim bends the backdrop. */
  strength: number;
  /** Relative thickness of the refraction band (fraction of the shorter side). */
  band: number;
  blur: number;
  saturate: number;
  contrast: number;
  brightness: number;
};

type GlassTarget = {
  /** Stable key — one filter is shared by every match of this selector. */
  key: string;
  selector: string;
  style: Partial<GlassStyle>;
};

const DEFAULT_STYLE: GlassStyle = {
  strength: 0.55,
  band: 0.14,
  blur: 18,
  saturate: 1.45,
  contrast: 1.06,
  brightness: 1.04,
};

/** Displacement maps are low-frequency; capping keeps generation cheap. */
const MAX_MAP_EDGE = 144;
const MIN_MAP_EDGE = 16;

/** Priority order: larger hero surfaces first so early bail-outs stay cheap. */
const TARGETS: GlassTarget[] = [
  {
    key: "sidebar",
    selector: ".sidebar",
    style: { strength: 0.62, band: 0.12, blur: 28, saturate: 1.55, contrast: 1.07, brightness: 1.05 },
  },
  {
    key: "sticky-controls",
    selector: ".sticky-controls",
    style: { strength: 0.5, band: 0.14, blur: 22, saturate: 1.4, contrast: 1.05, brightness: 1.04 },
  },
  {
    key: "preview-modal",
    selector: ".preview-modal",
    style: { strength: 0.48, band: 0.1, blur: 28, saturate: 1.35, contrast: 1.04, brightness: 1.02 },
  },
  {
    key: "settings-panel",
    selector: ".settings-panel",
    style: { strength: 0.45, band: 0.1, blur: 24, saturate: 1.4, contrast: 1.04, brightness: 1.03 },
  },
  {
    key: "backup-panel",
    selector: ".backup-panel",
    style: { strength: 0.42, band: 0.16, blur: 22, saturate: 1.4, contrast: 1.05, brightness: 1.04 },
  },
  {
    key: "search-box",
    selector: ".search-box",
    style: { strength: 0.5, band: 0.28, blur: 18, saturate: 1.3, contrast: 1.04, brightness: 1.05 },
  },
  {
    key: "banner",
    selector: ".notice-banner, .scan-banner",
    style: { strength: 0.38, band: 0.2, blur: 18, saturate: 1.35, contrast: 1.04, brightness: 1.04 },
  },
];

function smoothStep(a: number, b: number, t: number): number {
  t = Math.max(0, Math.min(1, (t - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

function length2(x: number, y: number): number {
  return Math.sqrt(x * x + y * y);
}

/** Standard rounded-rect SDF. `width`/`height` are half-extents; negative inside. */
function roundedRectSDF(
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): number {
  const qx = Math.abs(x) - width + radius;
  const qy = Math.abs(y) - height + radius;
  return (
    Math.min(Math.max(qx, qy), 0) +
    length2(Math.max(qx, 0), Math.max(qy, 0)) -
    radius
  );
}

function parseBorderRadius(el: Element): number {
  const raw = getComputedStyle(el).borderRadius;
  if (!raw || raw === "0px") return 0;
  // Take the first length; multi-value corners are close enough for an SDF.
  const px = parseFloat(raw);
  return Number.isFinite(px) ? px : 0;
}

function detectSupport(): boolean {
  try {
    const probe = document.createElement("div");
    probe.style.backdropFilter = "blur(1px) url(#liquid-glass-probe)";
    if (probe.style.backdropFilter) return true;
    probe.style.setProperty("-webkit-backdrop-filter", "blur(1px) url(#liquid-glass-probe)");
    return !!probe.style.getPropertyValue("-webkit-backdrop-filter");
  } catch {
    return false;
  }
}

class GlassFilter {
  readonly id: string;
  private style: GlassStyle;
  private svg: SVGSVGElement;
  private filter: SVGFilterElement;
  private feImage: SVGFEImageElement;
  private feDisplacementMap: SVGFEDisplacementMapElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private cacheKey = "";

  constructor(parent: HTMLElement, id: string, style: GlassStyle) {
    this.id = id;
    this.style = style;

    this.canvas = document.createElement("canvas");
    const ctx = this.canvas.getContext("2d", { willReadFrequently: false });
    if (!ctx) throw new Error("2d context unavailable");
    this.ctx = ctx;

    const ns = "http://www.w3.org/2000/svg";
    this.svg = document.createElementNS(ns, "svg");
    this.svg.setAttribute("width", "0");
    this.svg.setAttribute("height", "0");
    this.svg.setAttribute("aria-hidden", "true");
    this.svg.style.cssText =
      "position:fixed;top:0;left:0;width:0;height:0;pointer-events:none;overflow:hidden;";

    const defs = document.createElementNS(ns, "defs");
    this.filter = document.createElementNS(ns, "filter");
    this.filter.setAttribute("id", id);
    this.filter.setAttribute("filterUnits", "userSpaceOnUse");
    this.filter.setAttribute("color-interpolation-filters", "sRGB");
    this.filter.setAttribute("x", "0");
    this.filter.setAttribute("y", "0");
    this.filter.setAttribute("width", "1");
    this.filter.setAttribute("height", "1");

    this.feImage = document.createElementNS(ns, "feImage");
    this.feImage.setAttribute("result", "map");
    this.feImage.setAttribute("preserveAspectRatio", "none");

    this.feDisplacementMap = document.createElementNS(ns, "feDisplacementMap");
    this.feDisplacementMap.setAttribute("in", "SourceGraphic");
    this.feDisplacementMap.setAttribute("in2", "map");
    this.feDisplacementMap.setAttribute("x-channel-selector", "R");
    this.feDisplacementMap.setAttribute("y-channel-selector", "G");
    this.feDisplacementMap.setAttribute("scale", "0");

    this.filter.append(this.feImage, this.feDisplacementMap);
    defs.append(this.filter);
    this.svg.append(defs);
    parent.append(this.svg);
  }

  filterValue(): string {
    const s = this.style;
    return (
      `url(#${this.id}) ` +
      `blur(${s.blur}px) saturate(${s.saturate}) contrast(${s.contrast}) brightness(${s.brightness})`
    );
  }

  /** Regenerates the map only when the measured box or radius actually changed. */
  update(width: number, height: number, radius: number): boolean {
    const w = Math.round(width);
    const h = Math.round(height);
    if (w < 8 || h < 8) return false;

    const key = `${w}x${h}r${Math.round(radius)}`;
    if (key === this.cacheKey) return false;
    this.cacheKey = key;

    this.generateMap(w, h, radius);
    this.filter.setAttribute("x", "0");
    this.filter.setAttribute("y", "0");
    this.filter.setAttribute("width", String(w));
    this.filter.setAttribute("height", String(h));
    this.feImage.setAttribute("x", "0");
    this.feImage.setAttribute("y", "0");
    this.feImage.setAttribute("width", String(w));
    this.feImage.setAttribute("height", String(h));
    return true;
  }

  private generateMap(width: number, height: number, radius: number): void {
    let mapW = width;
    let mapH = height;
    const longest = Math.max(mapW, mapH);
    if (longest > MAX_MAP_EDGE) {
      const scale = MAX_MAP_EDGE / longest;
      mapW = Math.max(MIN_MAP_EDGE, Math.round(mapW * scale));
      mapH = Math.max(MIN_MAP_EDGE, Math.round(mapH * scale));
    }

    this.canvas.width = mapW;
    this.canvas.height = mapH;

    const minSide = Math.min(width, height);
    // Aspect-corrected unit space so the SDF stays circular in pixels.
    const aspectX = width / minSide;
    const aspectY = height / minSide;
    const hx = aspectX / 2;
    const hy = aspectY / 2;
    const radiusNorm = Math.min(radius / minSide, Math.min(hx, hy));
    const band = Math.max(0.04, this.style.band);
    const strength = Math.max(0, this.style.strength);
    // Rim magnifies toward the center (same family as the original shader);
    // sampling stays inside the element so the backdrop never clips to empty.
    const rim = strength * 0.42;

    const data = new Uint8ClampedArray(mapW * mapH * 4);
    const raw = new Float32Array(mapW * mapH * 2);
    let maxScale = 1e-6;

    for (let y = 0; y < mapH; y++) {
      const v = (y + 0.5) / mapH;
      const iy = v - 0.5;
      for (let x = 0; x < mapW; x++) {
        const u = (x + 0.5) / mapW;
        const ix = u - 0.5;
        const d = roundedRectSDF(ix * aspectX, iy * aspectY, hx, hy, radiusNorm);
        // d < 0 inside · 0 on the edge · > 0 outside
        const interior = smoothStep(0, band, -d);
        const amount = (1 - interior) * rim;
        const scale = 1 - amount;
        const sx = 0.5 + ix * scale;
        const sy = 0.5 + iy * scale;
        const dx = sx * mapW - x;
        const dy = sy * mapH - y;
        maxScale = Math.max(maxScale, Math.abs(dx), Math.abs(dy));
        const i = (y * mapW + x) * 2;
        raw[i] = dx;
        raw[i + 1] = dy;
      }
    }

    // feDisplacementMap interprets 0.5 as zero offset; scale is in user space.
    maxScale *= 0.5;
    for (let i = 0, p = 0; i < raw.length; i += 2, p += 4) {
      data[p] = (raw[i] / maxScale + 0.5) * 255;
      data[p + 1] = (raw[i + 1] / maxScale + 0.5) * 255;
      data[p + 2] = 0;
      data[p + 3] = 255;
    }

    this.ctx.putImageData(new ImageData(data, mapW, mapH), 0, 0);
    const dataUrl = this.canvas.toDataURL();
    this.feImage.setAttribute("href", dataUrl);
    this.feImage.setAttributeNS("http://www.w3.org/1999/xlink", "href", dataUrl);
    // Map pixels are stretched to the element box — convert the scale.
    this.feDisplacementMap.setAttribute(
      "scale",
      String(maxScale * (width / mapW)),
    );
  }

  destroy(): void {
    this.svg.remove();
  }
}

const filters = new Map<string, GlassFilter>();
let root: HTMLElement | null = null;
let supported = false;
let resizeBound = false;
let syncQueued = false;

function ensureRoot(): HTMLElement | null {
  if (root?.isConnected) return root;
  root = document.getElementById("liquid-glass-root");
  if (root) return root;
  root = document.createElement("div");
  root.id = "liquid-glass-root";
  root.setAttribute("aria-hidden", "true");
  root.style.cssText =
    "position:fixed;top:0;left:0;width:0;height:0;pointer-events:none;overflow:hidden;z-index:-1;";
  document.body.append(root);
  return root;
}

function getFilter(key: string, style: GlassStyle): GlassFilter | null {
  const host = ensureRoot();
  if (!host) return null;
  const existing = filters.get(key);
  if (existing) return existing;
  try {
    const created = new GlassFilter(host, `lg-filter-${key}`, style);
    filters.set(key, created);
    return created;
  } catch {
    return null;
  }
}

function applyToElement(el: HTMLElement, filter: GlassFilter): void {
  const rect = el.getBoundingClientRect();
  if (rect.width < 8 || rect.height < 8) {
    el.style.removeProperty("backdrop-filter");
    el.style.removeProperty("-webkit-backdrop-filter");
    return;
  }
  const radius = parseBorderRadius(el);
  filter.update(rect.width, rect.height, radius);
  const value = filter.filterValue();
  el.style.backdropFilter = value;
  el.style.setProperty("-webkit-backdrop-filter", value);
}

/** Re-measure every glass surface and refresh its displacement map. */
export function syncLiquidGlass(): void {
  if (!supported) return;
  syncQueued = false;
  // Dark chrome: skip SVG displacement (noisy on low-contrast glass); CSS blur remains.
  const dark = document.documentElement.dataset.theme === "dark";
  for (const target of TARGETS) {
    const style = { ...DEFAULT_STYLE, ...target.style };
    const nodes = document.querySelectorAll<HTMLElement>(target.selector);
    if (dark) {
      for (const el of nodes) {
        if (el.dataset.liquidGlass === "off") {
          el.style.removeProperty("backdrop-filter");
          el.style.removeProperty("-webkit-backdrop-filter");
          continue;
        }
        const rect = el.getBoundingClientRect();
        if (rect.width < 8 || rect.height < 8) {
          el.style.removeProperty("backdrop-filter");
          el.style.removeProperty("-webkit-backdrop-filter");
          continue;
        }
        const value = `blur(${Math.round(style.blur * 0.65)}px) saturate(1.1) contrast(1.02)`;
        el.style.backdropFilter = value;
        el.style.setProperty("-webkit-backdrop-filter", value);
      }
      continue;
    }
    const filter = getFilter(target.key, style);
    if (!filter) continue;
    for (const el of nodes) {
      // Skip surfaces that opt out explicitly.
      if (el.dataset.liquidGlass === "off") {
        el.style.removeProperty("backdrop-filter");
        el.style.removeProperty("-webkit-backdrop-filter");
        continue;
      }
      applyToElement(el, filter);
    }
  }
}

function scheduleSync(): void {
  if (syncQueued) return;
  syncQueued = true;
  requestAnimationFrame(() => syncLiquidGlass());
}

/**
 * Enable liquid-glass refraction across known UI panels.
 * Safe to call repeatedly — e.g. after every full `render()`.
 */
export function initLiquidGlass(): void {
  if (!supported) {
    // CSS keeps the blur/saturate fallback; nothing else to do.
    return;
  }
  ensureRoot();
  document.documentElement.classList.add("has-liquid-glass");
  if (!resizeBound) {
    resizeBound = true;
    window.addEventListener("resize", scheduleSync, { passive: true });
  }
  scheduleSync();
}

supported = detectSupport();
