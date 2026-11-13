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
  /** Months whose day list is visible in the sidebar. */
  expandedMonths: Set<string>;
  sort: SortMode;
  density: Density;
  /** Default preview surface: framed modal or immersive pure media. */
  previewMode: UiPreviewMode;
  /** 预览是否处于沉浸态（对话框几何计算与渲染都要读）。 */
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
  deleting: boolean;
  deleteConfirm: { preview: DeletePreviewDto; ids: string[] } | null;
  deleteProgress: DeleteProgressDto | null;
  deleteResult: DeleteResultDto | null;
  deleteNotice: string | null;
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
  /** Sticky toolbar secondary filters (tags/date/rating) expanded state. */
  filtersExpanded: boolean;
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
  /** AI 增强（云端 API 自动打标 + 语义搜索），配置/统计/任务进度。 */
  aiConfig: AiConfigDto | null;
  aiStats: AiStatsDto | null;
  aiPreview: AiProcessPreviewDto | null;
  aiPreviewLoading: boolean;
  aiJobId: string | null;
  aiProgress: AiProgressDto | null;
  aiProcessMode: AiRunMode;
  aiConfirming: boolean;
  aiTestBusy: "chat" | "embedding" | null;
  aiTestResult: (AiTestResultDto & { target: "chat" | "embedding" }) | null;
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
  expandedMonths: new Set(),
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
  deleting: false,
  deleteConfirm: null,
  deleteProgress: null,
  deleteResult: null,
  deleteNotice: null,
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
  filtersExpanded: false,
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
  aiStats: null,
  aiPreview: null,
  aiPreviewLoading: false,
  aiJobId: null,
  aiProgress: null,
  aiProcessMode: "incremental",
  aiConfirming: false,
  aiTestBusy: null,
  aiTestResult: null,
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
