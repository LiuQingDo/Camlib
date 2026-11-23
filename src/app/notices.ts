/**
 * 通知注册表 —— 「错误条」通道的数据源。
 *
 * 纯数据：不碰 DOM，也不认识渲染。渲染在 render/toolbar.ts 的 renderErrorBar()。
 * 与任务胶囊、toast 分开存：扫描中不再盖住「索引损坏」这类常驻错误。
 *
 * 旧代码里 state.error / availability / recentTaskNotice / ffmpegMissing 是
 * 同一条 if-else 链的分支，这里把它们映射成「派生通知」：条件成立就在表里，
 * 条件消失就撤掉；用户点关闭时同时清回源字段，否则下一次 patch 又会推回来。
 */
import { state } from "../state";

export type NoticeKind = "error" | "warning" | "info" | "success";

export interface NoticeAction {
  label: string;
  run: () => void;
}

export interface Notice {
  id: string;
  kind: NoticeKind;
  /** 主文案：一句人话，不放路径与错误码。 */
  title: string;
  /** 技术细节：渲染成折叠区，默认收起。 */
  detail?: string;
  actions?: NoticeAction[];
  /** 常驻：不参与任何自动消失逻辑（注册表本身也没有超时）。 */
  sticky?: boolean;
  /** 是否给关闭按钮；派生通知（断盘/路径无效）关掉也会被下一次同步推回，因此不给。 */
  closable?: boolean;
}

export type NoticeInput = Omit<Notice, "id"> & { id?: string };

export interface NoticeView {
  visible: Notice[];
  hidden: number;
}

/** 屏上最多并列 3 条，其余只报数量。 */
export const NOTICE_VISIBLE_LIMIT = 3;

/** 注册表硬上限：防止长时间运行无限增长（超出时丢最旧的）。 */
const NOTICE_CAP = 24;

/** 错误优先：错误条自己排一次序，不受推入先后影响。 */
const KIND_RANK: Record<NoticeKind, number> = { error: 0, warning: 1, info: 2, success: 3 };

const notices: Notice[] = [];
let autoId = 0;

/**
 * 推入 / 更新一条通知。同 id 原地替换而非重排，错误条不会因为刷新而跳动。
 * 不返回 id 之外的任何东西：调用方需要重绘就自己 patchErrorBar()。
 */
export function pushNotice(input: NoticeInput): string {
  const id = input.id ?? `notice-${++autoId}`;
  const notice: Notice = { ...input, id, closable: input.closable ?? true };
  const index = notices.findIndex((entry) => entry.id === id);
  if (index >= 0) {
    notices[index] = notice;
    return id;
  }
  notices.unshift(notice);
  if (notices.length > NOTICE_CAP) notices.length = NOTICE_CAP;
  return id;
}

function removeNotice(id: string): void {
  const index = notices.findIndex((entry) => entry.id === id);
  if (index >= 0) notices.splice(index, 1);
}

/**
 * 关闭一条通知。派生通知在这里顺手清回它的源状态字段——只删注册表的话，
 * 下一次同步会立刻把它推回来，表现为「点了关闭没反应」。
 */
export function dismissNotice(id: string): void {
  removeNotice(id);
  const clearLegacy = LEGACY_DISMISS[id];
  if (clearLegacy) clearLegacy();
}

/** 注册表里的派生通知 id → 关闭时该清的源字段。 */
const LEGACY_DISMISS: Record<string, () => void> = {
  "state-error": () => {
    state.error = null;
  },
  "recent-task": () => {
    state.recentTaskNotice = null;
  },
  "ffmpeg-missing": () => {
    state.ffmpegHintDismissed = true;
  },
};

/** 可见的 3 条 + 剩下的条数。 */
export function listNotices(limit: number = NOTICE_VISIBLE_LIMIT): NoticeView {
  // sort 是稳定排序：同 kind 内保持推入顺序（新的在前）。
  const ordered = notices.slice().sort((a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind]);
  return { visible: ordered.slice(0, limit), hidden: Math.max(0, ordered.length - limit) };
}

/** 执行某条通知上的第 index 个动作（由错误条的按钮代理）。 */
export function runNoticeAction(id: string, index: number): void {
  const notice = notices.find((entry) => entry.id === id);
  notice?.actions?.[index]?.run();
}

/**
 * 把旧 state 字段同步成通知（派生通知）。
 * 由 patchErrorBar() 在每次重绘前调用，因此所有既有的 `state.error = ...` 写法
 * 无需改动就能出现在错误条里。
 */
export function syncStateNotices(): void {
  syncDerived("state-error", Boolean(state.error), () => ({
    kind: "error",
    title: state.error ?? "",
    sticky: true,
  }));
  syncDerived("library-disconnected", state.availability === "disconnected", () => ({
    kind: "warning",
    title: "媒体库已断开",
    detail: `${state.rootPath ?? "原媒体库"} 不可用。已禁用扫描、删除、缩略图重建与备份目标写入。请重新连接磁盘，或在设置中更换媒体库路径。`,
    sticky: true,
    closable: false,
  }));
  syncDerived("library-invalid", state.availability === "invalid", () => ({
    kind: "warning",
    title: "媒体库路径无效",
    detail: "当前卷与记录的媒体库不一致。请在设置中重新选择可访问的媒体库目录。",
    sticky: true,
    closable: false,
  }));
  syncDerived("recent-task", Boolean(state.recentTaskNotice), () => ({
    kind: "info",
    title: "最近任务",
    detail: state.recentTaskNotice ?? "",
  }));
  syncDerived("ffmpeg-missing", state.ffmpegMissing && !state.ffmpegHintDismissed, () => ({
    kind: "info",
    title: "缺少 ffmpeg",
    detail:
      "视频缩略图与部分预览需要 ffmpeg：在终端运行 winget install ffmpeg 即可，装完重启 Camlib 生效。已安装则忽略这行提示。",
  }));
}

function syncDerived(id: string, active: boolean, build: () => Omit<Notice, "id">): void {
  // 条件不成立只摘注册表，不触发 LEGACY_DISMISS：源字段本来就是空的。
  if (!active) {
    removeNotice(id);
    return;
  }
  pushNotice({ ...build(), id });
}

/** 单测用：清空注册表，避免用例之间互相污染。 */
export function resetNoticesForTest(): void {
  notices.length = 0;
  autoId = 0;
}
