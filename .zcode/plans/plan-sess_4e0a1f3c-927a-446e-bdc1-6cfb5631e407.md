# 视频多段剪辑 + 勾选合并

## 背景
现有能力：编辑弹窗一次只能剪出一段（`media_trim_video` → 产物 `{stem}_edited`）；网格多选后可用合并弹窗合成一个视频（`video_merge.rs` → `{stem}_merged`）。需求：**一次把一个视频剪成多个片段（多个文件）**，并且在同一流程中**勾选哪些片段要合并**，导出时自动合成一个文件。

## 交互设计
- 编辑弹窗（视频）保留现有单段时间轴，新增「＋ 添加片段」：可在一条时间轴上定义多个片段。
- 时间轴渲染多条 `.trim-range`（激活段高亮、其余降透明度）；入/出点手柄、「设为入点/出点」、±0.1s 微调、循环播放始终作用于**当前激活片段**；点击某段 range 即激活，点空白轨道仍为 seek。允许片段区间重叠（每段独立剪切）。
- N≥2 时显示片段列表：每行 `片段 i · 起–止（时长）`＋「并入合并」勾选框＋删除按钮，行点击激活。
- 底部按钮：1 段 →「开始剪辑」（走现有 `media_trim_video`，产物名与行为完全不变）；N 段 →「导出 N 个片段」；勾选合并 ≥2 段 →「导出 N 个片段并合并 M 段」。
- 提交后一个后台任务：依次剪切每段 → 再把勾选段按片段顺序 concat 合并为 `{stem}_edited_merged{ext}`。进度显示「片段 i/N · x%」→「正在合并片段 · x%」。所有产物（各片段 + 合并文件）均作为新副本入库，原文件不动。
- 片段命名：`{stem}_edited_1..N`；整族冲突检查（任一重名则整族后缀 `_2` 递增），永不覆盖。

## 后端（src-tauri）
1. `src-tauri/src/editing.rs`
   - 新增 `CutSegmentSpec { in_ms, out_ms, merge }` 与 `CutSegmentsParams { media_item_id, segments, precise }`（serde camelCase）。
   - `EditProgress` 增加可选字段：`segment_index`、`segment_count`、`results: Option<Vec<EditResultDto>>`、`merged_result`（旧字段不动，向后兼容）。
   - `run_ffmpeg_trim`（editing.rs:661）增加进度上下文参数（本段序号/单元总数），把每段百分比折算成整体百分比并在事件中带段序号；单段路径传 `None` 保持现状。
   - 新增 `spawn_cut_segments` / `run_cut_segments`：复用 `video_source_file`、`resolve_media_path`、`resolve_ffmpeg`、`library_root`；每段用临时文件 `.{name}.camlib-edit{ext}` → `run_ffmpeg_trim` → rename 提交，段间检查取消标志；合并步复用 `backup.rs::merge_and_verify`（backup.rs:1126，concat 流复制，`expected_size` = 各段字节和，进度走 `on_bytes`）；完成 emit `completed` 带 `results`/`merged_result` 并触发 `scanner::spawn_scan`；失败/取消时对已提交片段同样触发扫描，错误信息注明失败段序号。
   - 新增命名函数 `cut_destinations(source, ext, count, want_merged)` + 单元测试（沿用文件尾部 `mod tests` 的 tempfile 风格）。
2. `src-tauri/src/lib.rs`
   - 新增 `#[tauri::command] media_cut_video_segments`：校验段数 1..=100、每段 `in_ms ≥ 0 && out_ms > in_ms`、合并勾选 <2 时忽略合并；复用 `EditJobManagerState::start()` 单槽（沿用「已有剪辑任务正在运行」约束）；注册进 `generate_handler!`。
   - 现有 `media_trim_video`、`video_merge.rs`、合并弹窗均不改动。

## 前端（src）
1. `src/api/media.ts`
   - `EditProgressDto` 增加可选 `segmentIndex/segmentCount/results/mergedResult`；新增 `startVideoCutSegments(mediaItemId, segments: {inMs,outMs,merge}[], precise)`（保留 `startVideoTrim` 供单段路径）。
2. `src/main.ts`
   - AppState（main.ts:248-251）：把 `editorInMs/editorOutMs` 升级为单一数据源 `editorSegments: {inMs,outMs,merge}[]` + `editorActiveSegment` 索引；现有引用点（openEditor 初始化、loadedmetadata、setPoint、nudge、moveTrim、循环播放、editorSyncTrimBar、saveVideoTrim）改为经 `editorActiveSegment()` 访问。
   - `renderEditorVideoBody`（main.ts:4433）：按段渲染多条 `.trim-range`（各自内联 `--trim-in/--trim-out`，现有 CSS 规则基本不动）；两个手柄仍是 track 级元素、跟随激活段；新增「＋ 添加片段」按钮和片段列表容器（N≥2 显示）。
   - `bindEditorVideoEvents`（main.ts:4856）：拖拽/设点/微调作用于激活段；点击 range 激活对应段；「添加片段」在播放头处新建 2s 段（端点 clamp、保证 ≥100ms）；列表交互用容器级事件委托（激活/勾选合并/删除）；段数变化时重建 track/列表 DOM（不在拖拽中）。
   - `saveVideoTrim` → `saveVideoCut`：单段且未勾选合并 → `startVideoTrim`；否则 → `startVideoCutSegments`；校验每段 ≥100ms、合并勾选 ≥2。
   - `renderEditorFooter`（main.ts:4474）：按钮文案按上述规则；running 文案显示「片段 i/N · x%」或「正在合并片段 · x%」。
   - `onEditProgress` 监听（main.ts:6024）：completed 且带 `results` → 新 `handleCutCompleted`（toast 汇总「已导出 N 个片段（并合并为 xxx）」，关编辑器、`refreshMedia()` 立即 + 2.5s 后各一次，复用 handleEditSaved 模式）。
3. `src/styles.css`
   - `.trim-range` 独立变量 + `.is-active` 高亮/非激活降透明/z-index 分层；新增 `.segment-list/.segment-row/.segment-merge/.segment-delete/.segment-add`（含暗色主题覆盖，跟随 styles.css:2544 起的 editor 样式段；列表限高滚动）。

## 验证
1. `cargo check` + `cargo test`（src-tauri，含新增命名测试）；`npm run build`（tsc 类型检查）。
2. `npm run tauri dev` 手工验收：
   - 打开视频 → 添加 3 段 → 勾选第 2、3 段合并 → 导出：生成 `_edited_1/_edited_2/_edited_3` + `_edited_merged`，toast 与列表自动刷新；
   - 快速/精确两种模式各跑一次；运行中取消：临时文件清理、无残留；
   - 单段剪辑回归：产物仍为 `{stem}_edited`，行为不变；
   - 交互：段激活切换、删除、勾选、进度「片段 i/N」显示、重叠区间显示正常。