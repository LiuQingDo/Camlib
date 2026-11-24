// 由 main.ts 拆分而来：仅做搬移，未改动逻辑。
import {
  AiConfigDto,
  AiProcessPreviewDto,
  AiProgressDto,
  AiRunMode,
  AiSearchResultDto,
  AiStatsDto,
  AiTestResultDto,
} from "./api/ai";
import {
  AppAboutDto,
  CloseBehavior,
  DialogSize,
  LibraryAvailability,
  LibraryIndexSummaryDto,
  ScanRunDto,
  ThumbnailCacheStatsDto,
  UiPreviewMode,
  UiSortMode,
  UiTheme,
} from "./api/infrastructure";
import {
  BackupItemDto,
  BackupPreviewDto,
  BackupProgressDto,
  BackupRunDto,
  BackupVolumeDto,
  ConflictPolicy,
  DateFacetDto,
  DeletePreviewDto,
  DeleteProgressDto,
  DeleteResultDto,
  EditProgressDto,
  LibraryDto,
  LibraryMergePreviewDto,
  LibraryMergeProgressDto,
  MediaItemDto,
  MediaKind,
  MediaPageDto,
  PreviewProgressDto,
  ScanProgressDto,
  TagDto,
  VideoMergeMode,
  VideoMergeProgressDto,
} from "./api/media";
import type { DeletedItemDto } from "./api/deleted";
import type { AiPanelView } from "./lib/ai-providers";

export type SortMode = UiSortMode;

export type Density = 1 | 2 | 3 | 4 | 5;

/** One requested cut range of the video editor; the active one drives the handles. */
export type EditorSegment = { inMs: number; outMs: number; merge: boolean };

/** AI 助手抽屉的一条消息；streaming 标记正在流式接收的助手回复。 */
export interface AiChatUiMessage {
  role: "user" | "assistant";
  content: string;
  streaming?: boolean;
  /** 助手回复末尾解析出的 [搜索] 标记，渲染为一键语义搜索 chip。 */
  searchAction?: string;
}

export interface AppState {
  availability: LibraryAvailability;
  rootPath: string | null;
  library: LibraryDto | null;
  libraries: LibraryDto[];
  facets: DateFacetDto[];
  page: MediaPageDto;
  search: string;
  kind: MediaKind | undefined;
  favoriteOnly: boolean;
  burstOnly: boolean;
  datePrefix: string | undefined;
  dateFrom: string | undefined;
  dateTo: string | undefined;
  /** Selected tag ids for combined filtering (AND). */
  tagIds: Set<string>;
  /** Exact rating filter; null = any. 0 = unrated only. */
  ratingEq: number | null;
  /** Minimum rating filter; null = any. */
  ratingMin: number | null;
  /** All tags known to the library, for filter chips and preview editing. */
  tags: TagDto[];
  /** Projected ratings from the current page, keyed by media id. */
  ratings: Map<string, number>;
  tagsBusy: boolean;
  tagsManagerOpen: boolean;
  tagsManagerBusy: boolean;
  tagsManagerError: string | null;
  /** Tag id awaiting delete confirmation inside the manager. */
  tagDeleteConfirmId: string | null;
  /** Years whose month list is visible in the sidebar. */
  expandedYears: Set<string>;
  sort: SortMode;
  density: Density;
  /** Default preview surface: framed modal or focus view (pure media). */
  previewMode: UiPreviewMode;
  /** 预览是否处于专注视图（对话框几何计算、CSS 与渲染都要读）。 */
  previewImmersive: boolean;
  /** Light / dark chrome; persisted via set_ui_prefs (not localStorage). */
  theme: UiTheme;
  /** Manually adjusted dialog sizes keyed by DIALOG_SPECS id. */
  dialogSizes: Record<string, DialogSize>;
  loading: boolean;
  scanning: boolean;
  scanProgress: ScanProgressDto | null;
  error: string | null;
  previewIndex: number | null;
  selectedIds: Set<string>;
  favorites: Set<string>;
  favoritePendingIds: Set<string>;
  favoritesBusy: boolean;
  lastSelectIndex: number | null;
  /**
   * roving tabindex 的落点：网格里唯一 tabindex="0" 的卡片下标（展示顺序，即
   * 卡片上的 data-index）。null = 还没用键盘进过网格，停靠点退回第一张。
   */
  focusIndex: number | null;
  deleting: boolean;
  deleteConfirm: { preview: DeletePreviewDto; ids: string[] } | null;
  deleteProgress: DeleteProgressDto | null;
  deleteResult: DeleteResultDto | null;
  /** 侧栏「已删除」只读列表：浮层开关与最近一次查询结果。 */
  deletedOpen: boolean;
  deletedLoading: boolean;
  deletedItems: DeletedItemDto[];
  /** 后端去重后的总数；可能大于已加载的 100 条。 */
  deletedTotal: number;
  deletedError: string | null;
  backupOpen: boolean;
  backupSources: BackupVolumeDto[];
  backupPreview: BackupPreviewDto | null;
  backupLoading: boolean;
  backupConflictPolicy: ConflictPolicy;
  backupProgress: BackupProgressDto | null;
  backupJobId: string | null;
  backupSourceId: string | null;
  backupTargetId: string | null;
  backupIgnoreExtensions: string;
  backupMergeSegments: boolean;
  /** 深度校验：按内容哈希比对源文件与目标文件，默认关闭。 */
  backupDeepVerify: boolean;
  backupHistory: BackupRunDto[];
  backupFailedItems: BackupItemDto[];
  backupHistoryItems: BackupItemDto[];
  backupExpandedRunId: string | null;
  backupLastRunId: string | null;
  backupRetrying: boolean;
  firstSeenFrom: string | null;
  libraryFormOpen: boolean;
  autoScanOnStartup: boolean;
  settingsOpen: boolean;
  settingsSection: SettingsSection;
  settingsLoading: boolean;
  settingsError: string | null;
  settingsNotice: string | null;
  indexSummary: LibraryIndexSummaryDto | null;
  scanRuns: ScanRunDto[];
  aboutInfo: AppAboutDto | null;
  thumbnailStats: ThumbnailCacheStatsDto | null;
  thumbnailRebuilding: boolean;
  thumbnailJobId: string | null;
  thumbnailProgress: PreviewProgressDto | null;
  fullRebuildConfirm: boolean;
  purgeMissingConfirm: boolean;
  settingsBusy: boolean;
  libraryStatusReason: string | null;
  thumbnailCacheDir: string;
  notificationsEnabled: boolean;
  closeBehavior: CloseBehavior;
  /** Dismissible note about the newest interrupted/failed run after restart. */
  recentTaskNotice: string | null;
  /** 首帧之后再探测：只有确认缺失 ffmpeg 时才为 true（用于一行安装引导）。 */
  ffmpegMissing: boolean;
  /** 用户点过「知道了」就本次运行不再提示；下次启动重新判断。 */
  ffmpegHintDismissed: boolean;
  /** Load-more failure message; sticky in the sentinel until retry (not the top banner). */
  loadMoreError: string | null;
  /** Library segment-merge maintenance. */
  libraryMergePreview: LibraryMergePreviewDto | null;
  libraryMergeLoading: boolean;
  libraryMergeConfirm: boolean;
  libraryMergeRecycle: boolean;
  /** Destination paths chosen after a library-merge preview. */
  libraryMergeSelected: Set<string>;
  libraryMergeFilter: string;
  libraryMergeProgress: LibraryMergeProgressDto | null;
  libraryMergeJobId: string | null;
  libraryMergeNotice: string | null;
  /** Media editor (photo crop/rotate/adjust + video trim). */
  editorOpen: boolean;
  editorItem: MediaItemDto | null;
  editorKind: "image" | "video";
  /** Stream URL of the editing surface (original; HEIC falls back to thumbnail). */
  editorSourceUrl: string;
  editorLoading: boolean;
  editorBusy: boolean;
  editorError: string | null;
  editorNotice: string | null;
  /** Image ops; crop is relative 0..1 on the EXIF-oriented image. */
  editorCrop: { x: number; y: number; w: number; h: number };
  editorRotate90: number;
  editorFlipH: boolean;
  editorFlipV: boolean;
  editorBrightness: number;
  editorContrast: number;
  editorSaturation: number;
  /** Video cut segments in milliseconds; at least one always exists. */
  editorSegments: EditorSegment[];
  /** Index into `editorSegments`; handles and stats follow this segment. */
  editorActiveSegment: number;
  editorDurationMs: number;
  editorPrecise: boolean;
  editorJobId: string | null;
  editorProgress: EditProgressDto | null;
  /** Merge selected videos into one copy (order arranged in the dialog). */
  mergeModalOpen: boolean;
  /** Ordered snapshot of the selected videos; index 0 plays first. */
  mergeItems: MediaItemDto[];
  mergeMode: VideoMergeMode;
  mergeRecycleSources: boolean;
  mergeBusy: boolean;
  mergeJobId: string | null;
  mergeProgress: VideoMergeProgressDto | null;
  mergeError: string | null;
  mergeNotice: string | null;
  /** AI 增强（云端 API 自动打标 + 自然语言检索），配置/统计/任务进度。 */
  aiConfig: AiConfigDto | null;
  /** 设置页 AI 表单草稿：改动先落这里，保存/测试时才提交后端；含多条配置档案。 */
  aiDraft: AiConfigDto | null;
  /** API Key 是否明文显示（仅 UI）。 */
  aiKeyVisible: boolean;
  /** 供应商面板当前视图：列表 / 添加（厂商网格）/ 单个供应商配置。 */
  aiView: AiPanelView;
  /** 添加面板的搜索词。 */
  aiPickerQuery: string;
  /** 正在编辑的供应商档案 id（编辑页只认它，不跟着「使用中」跑）。 */
  aiEditingId: string;
  /** 这条档案是不是刚从厂商网格新建的：决定「取消」要不要把它丢掉。 */
  aiCreating: boolean;
  aiStats: AiStatsDto | null;
  aiPreview: AiProcessPreviewDto | null;
  aiPreviewLoading: boolean;
  aiJobId: string | null;
  aiProgress: AiProgressDto | null;
  aiProcessMode: AiRunMode;
  aiConfirming: boolean;
  aiTestBusy: boolean;
  aiTestResult: AiTestResultDto | null;
  /** 「获取模型」拉回来的上游清单；null 表示这次编辑还没取过。 */
  aiModels: string[] | null;
  aiModelsBusy: boolean;
  aiModelsError: string | null;
  /** 已取回清单时的过滤词（清单可能上百条）。 */
  aiModelQuery: string;
  /** 激活的语义搜索查询（null = 常规筛选模式）。 */
  semanticSearch: string | null;
  semanticDraft: string;
  semanticMeta: AiSearchResultDto["parsed"] | null;
  semanticMode: AiSearchResultDto["mode"] | null;
  /** 单张/选中打标（前端逐张调用单条命令）的进行中状态。 */
  aiSingleBusy: boolean;
  aiSingleTotal: number;
  aiSingleDone: number;
  aiSingleFailed: number;
  aiSingleCurrent: string | null;
  aiSingleNotice: string | null;
  /** AI 助手聊天抽屉（仅会话内存，不持久化）。 */
  aiChatOpen: boolean;
  aiChatBusy: boolean;
  aiChatMessages: AiChatUiMessage[];
}

export const state: AppState = {
  availability: "unconfigured",
  rootPath: null,
  library: null,
  libraries: [],
  facets: [],
  page: { items: [], total: 0, offset: 0, limit: 120 },
  search: "",
  kind: undefined,
  favoriteOnly: false,
  burstOnly: false,
  datePrefix: undefined,
  dateFrom: undefined,
  dateTo: undefined,
  tagIds: new Set(),
  ratingEq: null,
  ratingMin: null,
  tags: [],
  ratings: new Map(),
  tagsBusy: false,
  tagsManagerOpen: false,
  tagsManagerBusy: false,
  tagsManagerError: null,
  tagDeleteConfirmId: null,
  expandedYears: new Set(),
  sort: "newest",
  density: 3,
  previewMode: "standard",
  previewImmersive: false,
  theme: "light",
  dialogSizes: {},
  loading: true,
  scanning: false,
  scanProgress: null,
  error: null,
  previewIndex: null,
  selectedIds: new Set(),
  favorites: new Set(),
  favoritePendingIds: new Set(),
  favoritesBusy: false,
  lastSelectIndex: null,
  focusIndex: null,
  deleting: false,
  deleteConfirm: null,
  deleteProgress: null,
  deleteResult: null,
  deletedOpen: false,
  deletedLoading: false,
  deletedItems: [],
  deletedTotal: 0,
  deletedError: null,
  backupOpen: false,
  backupSources: [],
  backupPreview: null,
  backupLoading: false,
  backupConflictPolicy: "skip_same",
  backupProgress: null,
  backupJobId: null,
  backupSourceId: null,
  backupTargetId: null,
  backupIgnoreExtensions: ".dng, .lrv",
  backupMergeSegments: true,
  backupDeepVerify: false,
  backupHistory: [],
  backupFailedItems: [],
  backupHistoryItems: [],
  backupExpandedRunId: null,
  backupLastRunId: null,
  backupRetrying: false,
  firstSeenFrom: null,
  libraryFormOpen: false,
  autoScanOnStartup: true,
  settingsOpen: false,
  settingsSection: "library",
  settingsLoading: false,
  settingsError: null,
  settingsNotice: null,
  indexSummary: null,
  scanRuns: [],
  aboutInfo: null,
  thumbnailStats: null,
  thumbnailRebuilding: false,
  thumbnailJobId: null,
  thumbnailProgress: null,
  fullRebuildConfirm: false,
  purgeMissingConfirm: false,
  settingsBusy: false,
  libraryStatusReason: null,
  thumbnailCacheDir: "",
  notificationsEnabled: true,
  closeBehavior: "minimize_to_tray",
  recentTaskNotice: null,
  ffmpegMissing: false,
  ffmpegHintDismissed: false,
  loadMoreError: null,
  libraryMergePreview: null,
  libraryMergeLoading: false,
  libraryMergeConfirm: false,
  libraryMergeRecycle: false,
  libraryMergeSelected: new Set(),
  libraryMergeFilter: "",
  libraryMergeProgress: null,
  libraryMergeJobId: null,
  libraryMergeNotice: null,
  editorOpen: false,
  editorItem: null,
  editorKind: "image",
  editorSourceUrl: "",
  editorLoading: false,
  editorBusy: false,
  editorError: null,
  editorNotice: null,
  editorCrop: { x: 0, y: 0, w: 1, h: 1 },
  editorRotate90: 0,
  editorFlipH: false,
  editorFlipV: false,
  editorBrightness: 1,
  editorContrast: 1,
  editorSaturation: 1,
  editorSegments: [],
  editorActiveSegment: 0,
  editorDurationMs: 0,
  editorPrecise: false,
  editorJobId: null,
  editorProgress: null,
  mergeModalOpen: false,
  mergeItems: [],
  mergeMode: "copy",
  mergeRecycleSources: false,
  mergeBusy: false,
  mergeJobId: null,
  mergeProgress: null,
  mergeError: null,
  mergeNotice: null,
  aiConfig: null,
  aiDraft: null,
  aiKeyVisible: false,
  aiView: "list",
  aiPickerQuery: "",
  aiEditingId: "",
  aiCreating: false,
  aiStats: null,
  aiPreview: null,
  aiPreviewLoading: false,
  aiJobId: null,
  aiProgress: null,
  aiProcessMode: "incremental",
  aiConfirming: false,
  aiTestBusy: false,
  aiTestResult: null,
  aiModels: null,
  aiModelsBusy: false,
  aiModelsError: null,
  aiModelQuery: "",
  semanticSearch: null,
  semanticDraft: "",
  semanticMeta: null,
  semanticMode: null,
  aiSingleBusy: false,
  aiSingleTotal: 0,
  aiSingleDone: 0,
  aiSingleFailed: 0,
  aiSingleCurrent: null,
  aiSingleNotice: null,
  aiChatOpen: false,
  aiChatBusy: false,
  aiChatMessages: [],
};

export type SettingsSection = "library" | "index" | "thumbnails" | "backup" | "ai" | "system" | "about";
