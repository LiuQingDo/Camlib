// 由 main.ts 拆分而来：仅做搬移，未改动逻辑。
import { app } from "../../render/context";
import { EditorSegment, state } from "../../state";
import { EDITOR_DEFAULT_SEGMENT_MS, EDITOR_MIN_TRIM_MS, EDITOR_NUDGE_MS, editorUpdateFooter } from "./shared";

export function formatEditorMs(ms: number): string {
  const total = Math.max(0, Math.round(ms / 100) / 10);
  const minutes = Math.floor(total / 60);
  const seconds = total - minutes * 60;
  return `${minutes}:${seconds.toFixed(1).padStart(4, "0")}`;
}

/** The segment the handles, stats and loop playback currently follow. */
export function editorActiveSegment(): EditorSegment | null {
  return state.editorSegments[state.editorActiveSegment] ?? null;
}

export function renderEditorVideoBody(): string {
  const active = editorActiveSegment();
  const keep = active ? Math.max(0, active.outMs - active.inMs) : 0;
  const segmentCount = state.editorSegments.length;
  const ranges = state.editorSegments
    .map(
      (_, index) =>
        `<span class="trim-range${index === state.editorActiveSegment ? " is-active" : ""}" data-segment="${index}"></span>`,
    )
    .join("");
  return `<div class="editor-workbench is-video">
    <div class="editor-stage-wrap"><div class="editor-stage is-video" id="editor-stage">${
      state.editorLoading
        ? `<span class="spinner large"></span>`
        : `<video id="editor-video" src="${state.editorSourceUrl}" controls playsinline preload="metadata"></video>`
    }</div></div>
    <div class="editor-console">
      <div class="editor-console-row">
        <div class="trim-stats">
          <span class="trim-stat" id="trim-seg-stat"${segmentCount > 1 ? "" : " hidden"}><span class="trim-stat-label">片段</span><strong class="trim-stat-value" id="trim-seg-label">–</strong></span>
          <span class="trim-stat"><span class="trim-stat-label">入点</span><strong class="trim-stat-value" id="trim-in-label">${active ? formatEditorMs(active.inMs) : "–:––"}</strong></span>
          <span class="trim-stat"><span class="trim-stat-label">出点</span><strong class="trim-stat-value" id="trim-out-label">${active ? formatEditorMs(active.outMs) : "–:––"}</strong></span>
          <span class="trim-stat is-keep"><span class="trim-stat-label">保留</span><strong class="trim-stat-value" id="trim-len-label">${formatEditorMs(keep)}</strong></span>
          <span class="trim-stat"><span class="trim-stat-label">总时长</span><strong class="trim-stat-value" id="trim-dur-label">${state.editorDurationMs > 0 ? formatEditorMs(state.editorDurationMs) : "–:––"}</strong></span>
        </div>
        <div class="trim-modes" role="radiogroup" aria-label="剪辑方式">
          <label class="trim-mode-card"><input type="radio" name="editor-trim-mode" value="fast" ${state.editorPrecise ? "" : "checked"} /><strong>快速</strong><span>无损流复制 · 秒级完成，切点对齐关键帧</span></label>
          <label class="trim-mode-card"><input type="radio" name="editor-trim-mode" value="precise" ${state.editorPrecise ? "checked" : ""} /><strong>精确</strong><span>重新编码 · 任意时刻切点，耗时较长</span></label>
        </div>
      </div>
      <div class="trim-ruler" aria-hidden="true"></div>
      <div class="trim-track" id="trim-track">
        ${ranges}
        <span class="trim-playhead" id="trim-playhead"></span>
        <span class="trim-handle handle-start" id="trim-handle-in" data-trim="in" title="入点"></span>
        <span class="trim-handle handle-end" id="trim-handle-out" data-trim="out" title="出点"></span>
      </div>
      <div class="editor-console-row">
        <div class="editor-tool-row">
          <button class="outline-button" id="trim-set-in" type="button">设为入点</button>
          <button class="outline-button" id="trim-set-out" type="button">设为出点</button>
          <span class="trim-nudges" role="group" aria-label="入点微调"><span class="trim-nudges-label">入点</span><button class="outline-button trim-nudge" id="trim-nudge-in-back" type="button" title="入点前移 0.1 秒">◂</button><button class="outline-button trim-nudge" id="trim-nudge-in-fwd" type="button" title="入点后移 0.1 秒">▸</button></span>
          <span class="trim-nudges" role="group" aria-label="出点微调"><span class="trim-nudges-label">出点</span><button class="outline-button trim-nudge" id="trim-nudge-out-back" type="button" title="出点前移 0.1 秒">◂</button><button class="outline-button trim-nudge" id="trim-nudge-out-fwd" type="button" title="出点后移 0.1 秒">▸</button></span>
        </div>
        <label class="editor-check"><input type="checkbox" id="trim-loop" checked />循环播放选段</label>
      </div>
      <div class="editor-console-row">
        <div class="editor-tool-row">
          <button class="outline-button" id="trim-add-segment" type="button" ${state.editorJobId ? "disabled" : ""}>＋ 添加片段</button>
          <span class="editor-hint">${segmentCount > 1 ? `已添加 ${segmentCount} 个片段，导出时每段各生成一个视频` : "可添加多个片段，一次性导出多个视频"}</span>
        </div>
      </div>
      <div class="segment-list" id="segment-list" hidden></div>
    </div>
  </div>`;
}

// --- video editor ----------------------------------------------------------

export function bindEditorVideoEvents(modal: HTMLElement): void {
  const video = modal.querySelector<HTMLVideoElement>("#editor-video");
  const track = modal.querySelector<HTMLElement>("#trim-track");
  video?.addEventListener("loadedmetadata", () => {
    state.editorDurationMs = Math.round((Number.isFinite(video.duration) ? video.duration : 0) * 1000);
    state.editorSegments = [{ inMs: 0, outMs: state.editorDurationMs, merge: false }];
    state.editorActiveSegment = 0;
    editorRebuildTrack();
    editorSyncTrimBar();
    editorSyncSegmentList();
    editorSyncPlayhead(video);
  });
  video?.addEventListener("timeupdate", () => {
    if (!video) return;
    // Playhead mirrors the player even while paused, before any early return.
    editorSyncPlayhead(video);
    if (video.paused) return;
    const loop = modal.querySelector<HTMLInputElement>("#trim-loop")?.checked ?? true;
    const segment = editorActiveSegment();
    if (!loop || !segment) return;
    const time = video.currentTime * 1000;
    if (time < segment.inMs - 60 || time >= segment.outMs) {
      video.currentTime = segment.inMs / 1000 + 0.01;
    }
  });
  video?.addEventListener("seeked", () => editorSyncPlayhead(video));
  const setPoint = (which: "in" | "out"): void => {
    const segment = editorActiveSegment();
    if (!video || !segment || !Number.isFinite(video.currentTime)) return;
    const ms = Math.round(video.currentTime * 1000);
    if (which === "in") segment.inMs = Math.min(ms, segment.outMs - EDITOR_MIN_TRIM_MS);
    else segment.outMs = Math.max(ms, segment.inMs + EDITOR_MIN_TRIM_MS);
    segment.inMs = Math.max(0, segment.inMs);
    segment.outMs = Math.min(state.editorDurationMs, segment.outMs);
    editorSyncTrimBar();
  };
  modal.querySelector<HTMLButtonElement>("#trim-set-in")?.addEventListener("click", () => setPoint("in"));
  modal.querySelector<HTMLButtonElement>("#trim-set-out")?.addEventListener("click", () => setPoint("out"));
  const nudgePoint = (which: "in" | "out", deltaMs: number): void => {
    const segment = editorActiveSegment();
    if (!segment) return;
    if (which === "in") {
      segment.inMs = Math.min(Math.max(0, segment.inMs + deltaMs), segment.outMs - EDITOR_MIN_TRIM_MS);
    } else {
      segment.outMs = Math.max(
        Math.min(state.editorDurationMs, segment.outMs + deltaMs),
        segment.inMs + EDITOR_MIN_TRIM_MS,
      );
    }
    editorSyncTrimBar();
    // Jump the player to the adjusted point so the new cut is visible.
    if (video) video.currentTime = (which === "in" ? segment.inMs : segment.outMs) / 1000;
  };
  modal
    .querySelector<HTMLButtonElement>("#trim-nudge-in-back")
    ?.addEventListener("click", () => nudgePoint("in", -EDITOR_NUDGE_MS));
  modal
    .querySelector<HTMLButtonElement>("#trim-nudge-in-fwd")
    ?.addEventListener("click", () => nudgePoint("in", EDITOR_NUDGE_MS));
  modal
    .querySelector<HTMLButtonElement>("#trim-nudge-out-back")
    ?.addEventListener("click", () => nudgePoint("out", -EDITOR_NUDGE_MS));
  modal
    .querySelector<HTMLButtonElement>("#trim-nudge-out-fwd")
    ?.addEventListener("click", () => nudgePoint("out", EDITOR_NUDGE_MS));
  modal.querySelector<HTMLButtonElement>("#trim-add-segment")?.addEventListener("click", () => {
    const duration = state.editorDurationMs;
    if (duration <= 0) return;
    const playMs = video && Number.isFinite(video.currentTime) ? Math.round(video.currentTime * 1000) : 0;
    let inMs = Math.min(Math.max(0, playMs), Math.max(0, duration - EDITOR_MIN_TRIM_MS));
    const outMs = Math.min(duration, inMs + EDITOR_DEFAULT_SEGMENT_MS);
    if (outMs - inMs < EDITOR_MIN_TRIM_MS) inMs = Math.max(0, outMs - EDITOR_MIN_TRIM_MS);
    state.editorSegments.push({ inMs, outMs, merge: false });
    state.editorActiveSegment = state.editorSegments.length - 1;
    editorRebuildTrack();
    editorSyncTrimBar();
    editorSyncSegmentList();
    editorUpdateFooter();
    if (video) video.currentTime = inMs / 1000;
  });
  // Delegated list events survive row re-renders; the checkbox and delete
  // button opt out of row activation.
  const segmentList = modal.querySelector<HTMLElement>("#segment-list");
  segmentList?.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    const remove = target.closest<HTMLElement>("[data-segment-remove]");
    if (remove) {
      editorRemoveSegment(Number(remove.dataset.segmentRemove));
      return;
    }
    if (target.closest("input[data-segment-merge]")) return;
    const row = target.closest<HTMLElement>("[data-segment-row]");
    if (row) editorActivateSegment(Number(row.dataset.segmentRow));
  });
  segmentList?.addEventListener("change", (event) => {
    const input = event.target as HTMLInputElement;
    const segment = state.editorSegments[Number(input.dataset.segmentMerge)];
    if (!segment) return;
    segment.merge = input.checked;
    // The save button label reflects the merge selection.
    editorUpdateFooter();
  });
  for (const input of modal.querySelectorAll<HTMLInputElement>('input[name="editor-trim-mode"]')) {
    input.addEventListener("change", () => {
      if (input.checked) state.editorPrecise = input.value === "precise";
    });
  }
  if (!track || !video) return;
  let trimDrag: "in" | "out" | null = null;
  const fractionFromEvent = (event: PointerEvent): number => {
    const bounds = track.getBoundingClientRect();
    if (bounds.width <= 0) return 0;
    return Math.min(Math.max(0, (event.clientX - bounds.left) / bounds.width), 1);
  };
  const moveTrim = (event: PointerEvent): void => {
    const segment = editorActiveSegment();
    if (!trimDrag || !segment) return;
    const ms = Math.round(fractionFromEvent(event) * state.editorDurationMs);
    if (trimDrag === "in") {
      segment.inMs = Math.min(Math.max(0, ms), segment.outMs - EDITOR_MIN_TRIM_MS);
    } else {
      segment.outMs = Math.max(Math.min(state.editorDurationMs, ms), segment.inMs + EDITOR_MIN_TRIM_MS);
    }
    editorSyncTrimBar();
  };
  const stopTrim = (): void => {
    trimDrag = null;
  };
  track.addEventListener("pointerdown", (event) => {
    const target = event.target as HTMLElement;
    const handle = target.dataset?.trim;
    if (handle === "in" || handle === "out") {
      event.preventDefault();
      trimDrag = handle;
      return;
    }
    // Clicking a range strip activates that segment; every click also seeks.
    const range = target.closest<HTMLElement>(".trim-range");
    if (range) {
      const index = Number(range.dataset.segment);
      if (state.editorSegments[index]) editorActivateSegment(index);
    }
    video.currentTime = fractionFromEvent(event) * (state.editorDurationMs / 1000);
  });
  track.addEventListener("pointermove", moveTrim);
  track.addEventListener("pointerup", stopTrim);
  track.addEventListener("pointercancel", stopTrim);
  track.addEventListener("pointerleave", stopTrim);
}

/** Recreate the per-segment range strips after segments were added, removed
 * or reset; styling and positions follow via editorSyncTrimBar. */
export function editorRebuildTrack(): void {
  const track = app.querySelector<HTMLElement>("#trim-track");
  if (!track) return;
  track.querySelectorAll(".trim-range").forEach((node) => node.remove());
  const playhead = track.querySelector("#trim-playhead");
  const fragment = document.createDocumentFragment();
  state.editorSegments.forEach((_, index) => {
    const range = document.createElement("span");
    range.className = "trim-range";
    range.dataset.segment = String(index);
    fragment.appendChild(range);
  });
  track.insertBefore(fragment, playhead);
}

export function editorActivateSegment(index: number): void {
  if (!state.editorSegments[index] || index === state.editorActiveSegment) return;
  state.editorActiveSegment = index;
  editorSyncTrimBar();
}

export function editorRemoveSegment(index: number): void {
  if (!state.editorSegments[index] || state.editorSegments.length <= 1) return;
  state.editorSegments.splice(index, 1);
  if (state.editorActiveSegment >= state.editorSegments.length) {
    state.editorActiveSegment = state.editorSegments.length - 1;
  }
  if (state.editorSegments.length < 2) {
    // Merge needs at least two segments; drop stale flags.
    for (const segment of state.editorSegments) segment.merge = false;
  }
  editorRebuildTrack();
  editorSyncTrimBar();
  editorSyncSegmentList();
  editorUpdateFooter();
}

/** Full rebuild of the segment list (open/add/remove/reset). Drag-time and
 * activation updates go through editorSyncTrimBar so rows never re-mount. */
export function editorSyncSegmentList(): void {
  const list = app.querySelector<HTMLElement>("#segment-list");
  if (!list) return;
  const count = state.editorSegments.length;
  list.hidden = count < 2;
  if (count < 2) {
    list.innerHTML = "";
    return;
  }
  list.innerHTML = state.editorSegments
    .map(
      (
        segment,
        index,
      ) => `<div class="segment-row${index === state.editorActiveSegment ? " is-active" : ""}" data-segment-row="${index}">
        <button class="segment-pick" type="button" title="选中该片段"><strong>片段 ${index + 1}</strong><span class="segment-range" data-segment-range="${index}">${formatEditorMs(segment.inMs)} – ${formatEditorMs(segment.outMs)}（${formatEditorMs(segment.outMs - segment.inMs)}）</span></button>
        <label class="segment-merge" title="勾选后与其他勾选片段在导出时合并为一个视频"><input type="checkbox" data-segment-merge="${index}" ${segment.merge ? "checked" : ""} />并入合并</label>
        <button class="segment-delete" type="button" data-segment-remove="${index}" title="删除该片段" aria-label="删除片段 ${index + 1}">×</button>
      </div>`,
    )
    .join("");
}

/** Range strips and the handles are percentage-positioned over the track; the
 * handles follow the active segment while every strip shows its own bounds. */
export function editorSyncTrimBar(): void {
  const track = app.querySelector<HTMLElement>("#trim-track");
  if (!track) return;
  const duration = state.editorDurationMs;
  const active = editorActiveSegment();
  const frac = (ms: number): number => (duration > 0 ? (ms / duration) * 100 : 0);
  // Track-level vars keep the handles glued to the active segment.
  track.style.setProperty("--trim-in", `${active ? frac(active.inMs) : 0}%`);
  track.style.setProperty("--trim-out", `${active ? frac(active.outMs) : 0}%`);
  track.classList.toggle("is-multi", state.editorSegments.length > 1);
  track.querySelectorAll<HTMLElement>(".trim-range").forEach((node) => {
    const segment = state.editorSegments[Number(node.dataset.segment)];
    if (!segment) return;
    node.style.setProperty("--trim-in", `${frac(segment.inMs)}%`);
    node.style.setProperty("--trim-out", `${frac(segment.outMs)}%`);
    node.classList.toggle("is-active", Number(node.dataset.segment) === state.editorActiveSegment);
  });
  const inLabel = app.querySelector<HTMLElement>("#trim-in-label");
  const outLabel = app.querySelector<HTMLElement>("#trim-out-label");
  const lenLabel = app.querySelector<HTMLElement>("#trim-len-label");
  if (inLabel) inLabel.textContent = active ? formatEditorMs(active.inMs) : "–:––";
  if (outLabel) outLabel.textContent = active ? formatEditorMs(active.outMs) : "–:––";
  if (lenLabel) lenLabel.textContent = active ? formatEditorMs(active.outMs - active.inMs) : "0:00.0";
  const durLabel = app.querySelector<HTMLElement>("#trim-dur-label");
  if (durLabel && duration > 0) durLabel.textContent = formatEditorMs(duration);
  const segStat = app.querySelector<HTMLElement>("#trim-seg-stat");
  const segLabel = app.querySelector<HTMLElement>("#trim-seg-label");
  if (segStat) segStat.hidden = state.editorSegments.length <= 1;
  if (segLabel) {
    segLabel.textContent = `${state.editorActiveSegment + 1}/${state.editorSegments.length}`;
  }
  // Row summaries mirror the state in place; rows never re-mount mid gesture.
  app.querySelectorAll<HTMLElement>("#segment-list [data-segment-row]").forEach((row) => {
    const index = Number(row.dataset.segmentRow);
    const segment = state.editorSegments[index];
    row.classList.toggle("is-active", index === state.editorActiveSegment);
    const range = row.querySelector<HTMLElement>("[data-segment-range]");
    if (segment && range) {
      range.textContent = `${formatEditorMs(segment.inMs)} – ${formatEditorMs(segment.outMs)}（${formatEditorMs(segment.outMs - segment.inMs)}）`;
    }
  });
}

/** Playhead mirrors the player position; a style write, safe per timeupdate. */
export function editorSyncPlayhead(video?: HTMLVideoElement | null): void {
  const player = video ?? app.querySelector<HTMLVideoElement>("#editor-video");
  const track = app.querySelector<HTMLElement>("#trim-track");
  if (!player || !track || !Number.isFinite(player.currentTime)) return;
  const frac =
    state.editorDurationMs > 0 ? Math.min(1, Math.max(0, (player.currentTime * 1000) / state.editorDurationMs)) : 0;
  track.style.setProperty("--trim-play", `${frac * 100}%`);
}
