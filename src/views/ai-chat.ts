// 由 main.ts 拆分而来：仅做搬移，未改动逻辑。
import { AiChatContextDto, AiChatPreviewDto, AiChatTurnDto, getAiConfig, streamAiChat } from "../api/ai";
import { toUserMessage } from "../api/errors";
import { hasAnyFilter } from "../lib/filters";
import { formatCount } from "../lib/format";
import { app } from "../render/context";
import { openSettings, render, showTransientNotice } from "../render/paint";
import { escapeHtml, kindLabel } from "../render/text";
import { AiChatUiMessage, state } from "../state";
import { previewUi } from "./preview/state";

// AI 助手抽屉：输入草稿与会话内调宽。消息本体在 state 中（会话内存）。
/** AI 抽屉输入草稿与被钉住的照片上下文。 */
export const aiChatUi = {
  draft: "",
  pinned: null as AiChatPreviewDto | null,
};
export let aiChatWidth = 400;

// 预览弹窗“问 AI 助手”时钉住的照片上下文：抽屉层级低于预览，需先关预览，
// 再把这张照片作为固定上下文带入抽屉（mediaId 仍可用于取缩略图）。
/**
 * Sidebar AI section: run counters plus quick entries for semantic search,
 * batch processing and the settings. Only rendered once a library exists.
 */
export function renderAiSidebarSection(): string {
  if (!state.library) return "";
  const stats = state.aiStats;
  const busy = state.aiSingleBusy;
  const progressPercent =
    state.aiSingleTotal > 0 ? Math.min(100, Math.round((state.aiSingleDone / state.aiSingleTotal) * 100)) : 0;
  const statsRow = stats
    ? `<dl class="ai-sidebar-stats"><div><dt>已处理</dt><dd>${formatCount(stats.processed)}</dd></div><div><dt>待处理</dt><dd>${formatCount(stats.pending)}</dd></div><div class="${stats.failed > 0 ? "has-failed" : ""}"><dt>失败</dt><dd>${formatCount(stats.failed)}</dd></div></dl>`
    : `<div class="ai-sidebar-hint">加载统计…</div>`;
  return `<div class="sidebar-section ai-section" aria-label="AI 增强"><div class="section-label"><span>AI 增强</span><span class="section-actions"><button class="icon-button" id="ai-open-settings" title="AI 设置" aria-label="AI 设置">⚙</button></span></div>
    ${statsRow}
    ${
      busy
        ? `<div class="ai-single-progress" id="ai-single-progress"><div class="ai-single-copy"><span class="spinner"></span><span data-ai-single-count>${state.aiSingleDone} / ${state.aiSingleTotal}</span><button class="text-button" id="ai-single-cancel" type="button">取消</button></div><div class="progress-track"><span data-ai-single-track style="width:${progressPercent}%"></span></div><div class="ai-single-current" data-ai-single-current>${escapeHtml(state.aiSingleCurrent ?? "")}</div></div>`
        : state.aiSingleNotice
          ? `<div class="ai-single-notice">${escapeHtml(state.aiSingleNotice)}</div>`
          : ""
    }
    <div class="ai-sidebar-actions"><button class="text-button" id="ai-chat-open" type="button">✬ AI 助手</button><button class="text-button" id="ai-semantic-focus" type="button">✦ 语义搜索</button><button class="text-button" id="ai-open-batch" type="button">批量处理${stats && stats.pending > 0 ? `（${formatCount(stats.pending)}）` : ""}</button></div>
  </div>`;
}

// ── AI 助手（聊天抽屉） ─────────────────────────────────────────────────────

/** 对话模型是否已配置完整（前端预检，与 Rust validate_config_for_run 对齐）。 */
export function aiChatReady(): boolean {
  const config = state.aiConfig;
  return !!config?.enabled && config.chatModel.trim().length > 0 && /^https?:\/\//.test(config.chatBaseUrl.trim());
}

/** 助手当前能“看到”的照片：预览中者优先，其次预览里钉住的那张。 */
export function aiChatActivePreview(): AiChatPreviewDto | null {
  if (state.previewIndex !== null) {
    const item = state.page.items[state.previewIndex];
    if (!item) return null;
    return {
      mediaId: item.id,
      displayName: item.displayName,
      kind: item.kind,
      captureDate: item.captureDate ?? undefined,
      rating: item.rating || undefined,
      favorite: item.favorite || undefined,
      aiCaption: previewUi.metaCache?.aiCaption ?? undefined,
      aiTags: previewUi.metaCache?.aiTags?.map((tag) => tag.name),
    };
  }
  return aiChatUi.pinned;
}

/** 抽屉头部的上下文提示，让用户知道助手当前掌握哪些信息。 */
export function aiChatContextSummary(): string {
  const bits: string[] = [];
  const preview = aiChatActivePreview();
  if (preview) bits.push(`预览 ${preview.displayName}`);
  if (state.selectedIds.size) bits.push(`已选 ${state.selectedIds.size} 张`);
  if (state.semanticSearch) bits.push(`语义「${state.semanticSearch}」`);
  else if (hasAnyFilter(state)) bits.push("筛选中");
  return bits.join(" · ");
}

export function renderAiChatMessage(message: AiChatUiMessage, index: number): string {
  if (message.role === "user") {
    return `<div class="ai-chat-message is-user" data-chat-index="${index}"><div class="ai-chat-bubble">${escapeHtml(message.content)}</div></div>`;
  }
  const action = message.searchAction
    ? `<button type="button" class="ai-chat-search-chip" data-chat-search="${escapeHtml(message.searchAction)}" title="用语义搜索在媒体库中查找">⌕ 执行语义搜索：${escapeHtml(message.searchAction)}</button>`
    : "";
  return `<div class="ai-chat-message is-assistant" data-chat-index="${index}"><div class="ai-chat-bubble">${escapeHtml(message.content)}${message.streaming ? `<span class="ai-chat-caret" aria-hidden="true"></span>` : ""}</div>${action}</div>`;
}

export function renderAiChatDrawer(): string {
  if (!state.aiChatOpen) return "";
  const ready = aiChatReady();
  const summary = aiChatContextSummary();
  const body = !ready
    ? `<div class="ai-chat-empty"><span class="ai-chat-empty-icon" aria-hidden="true">✬</span><p>AI 助手需要在设置中启用 AI 增强，并填写对话模型的 Base URL 与模型名称。</p><button class="primary-button" id="ai-chat-goto-settings" type="button">去设置</button></div>`
    : state.aiChatMessages.length === 0
      ? `<div class="ai-chat-empty"><span class="ai-chat-empty-icon" aria-hidden="true">✬</span><p>我是你的相册助手，可以试试：</p><ul><li>去年十月我拍了哪些照片？</li><li>帮我找海边的照片</li><li>这张照片里是什么？（预览时可用）</li></ul></div>`
      : state.aiChatMessages.map((message, index) => renderAiChatMessage(message, index)).join("");
  return `<aside class="ai-chat-drawer" id="ai-chat-drawer" role="dialog" aria-label="AI 助手" style="width:${aiChatWidth}px">
    <div class="ai-chat-resize-handle" id="ai-chat-resize-handle" aria-hidden="true"></div>
    <header class="ai-chat-head">
      <div class="ai-chat-title"><span class="ai-chat-glyph" aria-hidden="true">✬</span><div><strong>AI 助手</strong><span>${summary ? escapeHtml(summary) : "基于当前媒体库回答"}</span></div></div>
      <div class="ai-chat-head-actions">${state.aiChatMessages.length && !state.aiChatBusy ? `<button class="text-button" id="ai-chat-clear" type="button">清空</button>` : ""}<button class="icon-button" id="ai-chat-close" type="button" aria-label="关闭 AI 助手" title="关闭">×</button></div>
    </header>
    <div class="ai-chat-body" id="ai-chat-body">${body}</div>
    <footer class="ai-chat-input-row">
      <textarea id="ai-chat-input" rows="1" placeholder="${state.aiChatBusy ? "回复中…" : "输入问题，Enter 发送，Shift+Enter 换行"}" aria-label="AI 助手输入框" ${state.aiChatBusy || !ready ? "disabled" : ""}></textarea>
      ${
        state.aiChatBusy
          ? `<button class="outline-button ai-chat-send" id="ai-chat-stop" type="button" aria-label="停止生成" title="停止生成">■</button>`
          : `<button class="primary-button ai-chat-send" id="ai-chat-send" type="button" aria-label="发送" title="发送" ${ready ? "" : "disabled"}>↑</button>`
      }
    </footer>
  </aside>`;
}

/** Stream 期间不整层 render，只 patch 当前气泡（防丢焦点/闪烁）。 */
export function appendAiChatDelta(text: string): void {
  if (!state.aiChatMessages.length) return;
  const body = app.querySelector<HTMLElement>("#ai-chat-body");
  if (body) {
    const nearBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 80;
    const last = state.aiChatMessages[state.aiChatMessages.length - 1];
    last.content += text;
    const bubble = body.querySelector<HTMLElement>(".ai-chat-message:last-child .ai-chat-bubble");
    if (bubble) {
      bubble.textContent = last.content;
      const caret = document.createElement("span");
      caret.className = "ai-chat-caret";
      caret.setAttribute("aria-hidden", "true");
      bubble.appendChild(caret);
    }
    if (nearBottom) body.scrollTop = body.scrollHeight;
    return;
  }
  // 抽屉不在 DOM（例如被浮层盖住后重建过）也要保住内容。
  const last = state.aiChatMessages[state.aiChatMessages.length - 1];
  last.content += text;
}

export function scrollAiChatBody(force = false): void {
  const body = app.querySelector<HTMLElement>("#ai-chat-body");
  if (!body) return;
  if (force || body.scrollHeight - body.scrollTop - body.clientHeight < 80) {
    body.scrollTop = body.scrollHeight;
  }
}

/** 解析回复末尾的 [搜索] 标记：从正文剥离，返回语义搜索词。 */
export function splitSearchMarker(content: string): { content: string; query: string | null } {
  const match = content.match(/(?:^|\n)\s*\[搜索\][ \t]*(.+?)\s*$/);
  if (!match) return { content: content.trim(), query: null };
  return { content: content.slice(0, match.index ?? 0).trim(), query: match[1].trim() };
}

/** 打包当前筛选/预览/多选状态，作为助手回答的「你在这里」上下文。 */
export function collectAiChatContext(): AiChatContextDto {
  const view: Record<string, unknown> = {};
  if (state.search) view["文件名搜索"] = state.search;
  if (state.semanticSearch) view["语义搜索"] = state.semanticSearch;
  if (state.kind) view["类型"] = kindLabel(state.kind);
  if (state.datePrefix) view["日期"] = state.datePrefix;
  if (state.dateFrom) view["起始日期"] = state.dateFrom;
  if (state.dateTo) view["结束日期"] = state.dateTo;
  if (state.favoriteOnly) view["仅收藏"] = true;
  if (state.burstOnly) view["仅连拍"] = true;
  if (state.ratingEq !== null) view["评分等于"] = state.ratingEq;
  if (state.ratingMin !== null) view["评分至少"] = state.ratingMin;
  if (state.tagIds.size) {
    const names = [...state.tagIds].map((id) => state.tags.find((tag) => tag.id === id)?.name).filter(Boolean);
    if (names.length) view["标签"] = names;
  }
  const context: AiChatContextDto = { view };
  const preview = aiChatActivePreview();
  if (preview) context.preview = preview;
  if (state.selectedIds.size > 0) {
    const names = [...state.selectedIds]
      .slice(0, 10)
      .map((id) => state.page.items.find((item) => item.id === id)?.displayName ?? "")
      .filter(Boolean);
    context.selection = { count: state.selectedIds.size, names };
  }
  return context;
}

/** 发送当前草稿：占位气泡 → 流式 patch → 结束后一次性 render 挂搜索 chip。 */
/** AI 助手抽屉尚未增量化：消息数 / 忙碌态变化即重建（流式增量除外）。 */
export async function sendAiChatMessage(): Promise<void> {
  if (state.aiChatBusy) return;
  const draft = aiChatUi.draft.trim();
  if (!draft || !state.library) return;
  if (!aiChatReady()) {
    void openSettings("ai");
    return;
  }
  state.aiChatMessages.push({ role: "user", content: draft });
  state.aiChatMessages.push({ role: "assistant", content: "", streaming: true });
  aiChatUi.draft = "";
  state.aiChatBusy = true;
  render();
  scrollAiChatBody(true);
  // 发给模型的历史去掉流式占位，并截到最后 16 条。
  const history: AiChatTurnDto[] = state.aiChatMessages
    .slice(0, -1)
    .slice(-16)
    .map((message) => ({ role: message.role, content: message.content }));
  try {
    const result = await streamAiChat(state.library.id, history, collectAiChatContext(), (text) =>
      appendAiChatDelta(text),
    );
    const reply = state.aiChatMessages[state.aiChatMessages.length - 1];
    reply.streaming = false;
    const parsed = splitSearchMarker(result.content);
    reply.content = parsed.content;
    reply.searchAction = parsed.query ?? undefined;
  } catch (error) {
    const reply = state.aiChatMessages[state.aiChatMessages.length - 1];
    if (reply?.role === "assistant") {
      if (reply.content.trim()) reply.streaming = false;
      else state.aiChatMessages.pop();
    }
    showTransientNotice(toUserMessage(error), "error");
  } finally {
    state.aiChatBusy = false;
    render();
    scrollAiChatBody(true);
    const input = app.querySelector<HTMLTextAreaElement>("#ai-chat-input");
    input?.focus();
    if (input) autoGrowAiChatInput(input);
  }
}

export function autoGrowAiChatInput(input: HTMLTextAreaElement): void {
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, 120)}px`;
}

/** AI 助手抽屉尚未增量化。 */
export function closeAiChatDrawer(): void {
  state.aiChatOpen = false;
  aiChatUi.pinned = null;
  render();
}

/**
 * 打开抽屉。配置只在设置页 AI 分区时加载过；抽屉的就绪判断依赖它，
 * 所以首次打开前按需拉取一次（失败则保持 null，抽屉渲染引导空态）。
 */
export async function openAiChatDrawer(): Promise<void> {
  if (!state.aiConfig) {
    try {
      state.aiConfig = await getAiConfig();
    } catch {
      // 网络级失败罕见（本地 SQLite），引导空态即可。
    }
  }
  state.aiChatOpen = true;
  render();
  app.querySelector<HTMLTextAreaElement>("#ai-chat-input")?.focus();
}

/** 左缘拖拽调宽（会话内有效）；与对话框的 8 向缩放无关，避免破坏全高布局。 */
export function setupAiChatResize(): void {
  const drawer = app.querySelector<HTMLElement>("#ai-chat-drawer");
  const handle = app.querySelector<HTMLElement>("#ai-chat-resize-handle");
  if (!drawer || !handle || drawer.dataset.chatResizeBound === "1") return;
  drawer.dataset.chatResizeBound = "1";
  handle.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = drawer.getBoundingClientRect().width;
    const onMove = (moveEvent: PointerEvent) => {
      aiChatWidth = Math.min(560, Math.max(320, Math.round(startWidth + (startX - moveEvent.clientX))));
      drawer.style.width = `${aiChatWidth}px`;
    };
    const stop = () => window.removeEventListener("pointermove", onMove);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", stop, { once: true });
    window.addEventListener("pointercancel", stop, { once: true });
  });
}
