# 媒体列表多选视频合并功能

## Context

Camlib（Tauri 2 + 原生 TS + Rust）的媒体列表已支持多选与批量操作（收藏/标签/评分/删除），但缺少「把多个视频合并成一个」的能力。本次新增：多选 ≥2 个视频后，批量工具栏出现「合并视频」按钮 → 打开独立的合并弹窗（可拖动排序、选择编码策略、可选回收源视频）→ 确认后后台 ffmpeg 合并，产物以新副本入库（复用现有增量扫描机制），带进度与取消。

用户已确认：① 编码策略在弹窗中可选（默认「快速无损」流复制，可选「兼容重编码」）；② 弹窗提供「合并后将原视频移入回收站」复选框（默认不勾选）。

## 后端（Rust）

### 1. 新模块 `src-tauri/src/video_merge.rs`（仿 `library_merge.rs` + `editing.rs`）
- `VideoMergeManagerState`：单槽任务管理器（`start()` 返回 `(job_id, Arc<AtomicBool>)`，`cancel()`、`finish()`），lib.rs 中 `app.manage()`。
- DTO（serde camelCase）：`VideoMergeStartDto { jobId }`、`VideoMergeResultDto { fileName, relativePath, sizeBytes }`、`VideoMergeProgress { jobId, kind: "merge", phase, state, percent, bytesProcessed, bytesTotal, speedBytesPerSec, etaSeconds, error, result }`，事件名 `media-merge-progress`。
- `VideoMergeParams { media_item_ids: Vec<String>, mode: "copy"|"reencode", recycle_sources: bool }`（**数组顺序即拼接顺序**，serde 保留 JSON 数组顺序）。
- `spawn()` 后台线程 → `run()`：
  1. 打开 Repository，校验媒体库 available、ids ≥2、逐个 `get_media_item_details` 并取视频文件（复用 `editing::video_source_file`，改为 `pub(crate)`）+ `resolve_media_path`。
  2. **探测**（新增 `probe_video(ffmpeg, path)`）：跑 `ffmpeg -hide_banner -i <file>` 解析 stderr 的 `Duration:` 行与 `Video:` 行的 `WxH`，得到每个输入的时长/分辨率/编码名 → 总时长用于重编码进度百分比；无需 ffprobe、无需前端传时长。
  3. 目标文件：新 `merged_destination()`（仿 `editing::edited_destination` 409-432 的 `_edited`→`_merged` 链式避让），放在**第一个源视频**旁边；copy 模式用第一个源的扩展名，reencode 模式用 `mp4`。
  4. **copy 模式**：直接调用 `backup::merge_and_verify`（`backup.rs:1126`，已 `pub(crate)`，含 concat 列表、size 轮询进度、取消、5% 校验、原子 rename）——传全部源绝对路径 + 尺寸之和。
  5. **reencode 模式**：新 `merge_reencode()`：N 个 `-i` 输入 + `-filter_complex "[0:v][0:a?][1:v][1:a?]…concat=n=N:v=1:a=1[v][a]" -map [v] -map [a]`（`a?` 容忍无音轨输入），把非首段 `scale=<首段W>x<H>,setsar=1` 归一化后进 concat，编码参数沿用剪辑精准模式（`libx264 -preset veryfast -crf 18 -c:a aac -b:a 192k`）+ `-movflags +faststart` + `-progress pipe:1 -nostats`；复用/仿照 `editing.rs` 的 `spawn_progress_reader`/`parse_out_time_micros`（改 `pub(crate)`）解析 `out_time_ms` 计算百分比，wait 循环内检查 cancel 并 kill 子进程（仿 `run_ffmpeg_trim` 716-731）。临时文件命名 `.{目标名}.camlib-merge{ext}` + `TempGuard`（scanner 的 `is_merge_scratch` 会跳过含 `.camlib-` 的文件，scanner.rs:673）。
  6. 成功后：`recycle_sources=true` 时逐个 `deletion::send_to_recycle_bin` + `repository.purge_files_and_empty_items`（仿 `library_merge.rs:369-399`）；随后 `scan_manager.start` + `scanner::spawn_scan(…, full=false)` 增量入库（仿 `editing.rs:536-546`）。取消/失败发对应事件。
  - 单元测试：`merged_destination` 链式命名、probe 的 Duration/WxH 行解析。

### 2. `src-tauri/src/lib.rs`
- 新命令 `media_merge_videos(library_id, media_item_ids, mode, recycle_sources, …)`：校验（≥2、库可用、每项属于该库且有可编辑视频文件），`manager.start()` 后 `video_merge::spawn(...)`，返回 `VideoMergeStartDto`；`media_merge_cancel(job_id)`。
- `invoke_handler`（1389-1448）追加两个命令；`run()` 中 `app.manage(VideoMergeManagerState::new())`（仿 1337-1378）。
- 需要改可见性：`editing::video_source_file`、`editing::spawn_progress_reader`/`parse_out_time_micros` → `pub(crate)`；`library_merge.rs` 的 `available_space`/`resolve_inside` → `pub(crate)` 复用。

## 前端（TypeScript）

### 3. `src/api/media.ts`
- 接口 `VideoMergeProgressDto`/`VideoMergeResultDto`（镜像 Rust camelCase），包装函数 `startVideoMerge(libraryId, mediaItemIds, { mode, recycleSources })` → `invoke("media_merge_videos", …)`、`cancelVideoMerge(jobId)`、`onVideoMergeProgress(cb)` → `listen("media-merge-progress", …)`（仿 `startVideoTrim`/`onEditProgress` 499-519）。

### 4. `src/main.ts`
- **AppState 新字段**：`mergeModalOpen`、`mergeItems: MediaItemDto[]`（打开弹窗时的有序快照）、`mergeMode: "copy"|"reencode"`、`mergeRecycleSources`、`mergeJobId`、`mergeProgress`、`mergeError`；拖拽状态用模块级变量（仿 `EditorDragState` 686）。
- **工具栏**（`renderSelectionToolbar` 1918 + `bindSelectionToolbarEvents` 1287）：在删除按钮前加 `#merge-selected`「合并视频」；仅当已选项中**全部**为 `kind==="video"` 且 ≥2 时可用，否则 disabled + title 提示原因（`applySelectionChrome` 会随选择变化自动刷新按钮态）。点击 → `openMergeModal()`：按当前网格顺序快照选中项（不在已加载页内的 id 用 `getMediaItem`（media.ts:561）补齐），置 `mergeModalOpen=true` 并 render。
- **弹窗**：
  - `DIALOG_SPECS`（393）加 `mergeVideos: { selector: "#merge-videos-modal .merge-modal", label: "合并视频", width: 640, height: null, minWidth: 460, minHeight: 320 }` → 自动获得尺寸持久化与 8 向手柄。
  - `render()` 模板（2573）追加 `${state.mergeModalOpen ? renderMergeModal() : ""}`。
  - `renderMergeModal()`：header（标题 + ×）→ body：说明行（「列表顺序即拼接顺序，可拖动 ⠿ 或 ↑↓ 调整」）、策略选择（两个互斥按钮：快速无损/兼容重编码，`is-active` 态 + 说明文案）、`ul.merge-list`（每行：拖拽手柄、序号、缩略图占位、文件名、大小、↑↓ 按钮）、回收复选框 → footer：错误反馈区 + 进度条（复用 `.progress-track`，重编码有 percent、无则 `is-indeterminate`）+ 取消/「开始合并」主按钮。
  - **排序**：手柄 `pointerdown` → `setPointerCapture`，pointermove 依据指针 Y 实时移动 DOM 行；`pointerup` 把新顺序写回 `state.mergeItems` 并重渲染弹窗 body（缩略图有 promise 缓存，不闪）；↑↓ 按钮直接交换并重渲染。拖拽期间不整页 render（仿 trim 轨道拖拽 4527-4562 的模式）。
  - 缩略图：行内占位后用现成 `loadModalThumbnail(id)`（main.ts:766）异步填充。
  - `bindMergeModalEvents()`：× / 底部取消 / backdrop 点击关闭（运行中关闭 = 先 `cancelVideoMerge`，与 `closeEditor` 取消任务的行为一致）；策略按钮、复选框、↑↓、拖拽、确认。
  - `confirmMerge()`：busy 态 → `startVideoMerge(state.library.id, mergeItems.map(i=>i.id), {mode, recycleSources})`，记 `mergeJobId`；footer 切进度视图（部分更新，仿 `editorUpdateFooter` 4139）。
- **事件监听**（模块底部，仿 `onEditProgress` 5613-5632）：`onVideoMergeProgress` → running 时 `mergeUpdateFooter()`；completed → toast `已合并为 …，正在自动入库` + 关弹窗 + `refreshMedia()`（立即 + 2500ms 后再刷，仿 `handleEditSaved` 4630）；cancelled/failed → footer 显示原因可重试。
- **Escape 路由**（5334）：在 settingsOpen 分支后加 `state.mergeModalOpen` 分支（运行中 Esc = 取消并关闭）。

### 5. `src/styles.css`
文件末尾新章节：`.merge-backdrop/.merge-modal/.merge-list/.merge-row`（含 `is-dragging`、拖拽指示）、`.merge-mode-group`、`.merge-options`、进度/按钮复用现有类；并按 `.tag-manager` 深色覆盖模式（styles.css:2455 附近）加 dark 段。

## 验证
1. `cd src-tauri && cargo check && cargo test video_merge` — 编译 + 新增单测。
2. `npm run build`（tsc + vite）— 前端类型检查。
3. `npm run tauri dev` 手动走查：多选 2 个同格式视频 → 合并（无损，秒级）→ 产物 `xxx_merged.mp4` 入库、原视频保留；再试混合格式走「兼容重编码」看进度百分比；拖拽/↑↓ 改序后确认输出顺序；勾选回收选项验证源入回收站且列表行消失；运行中点取消/Esc。
