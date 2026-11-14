# Changelog

All notable changes to Camlib are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

- **PATCH** — bug fixes, copy, security hardening; no data migration
- **MINOR** — features; index/settings stay backward compatible
- **MAJOR** — breaking changes (migration or re-scan required)

SQLite schema version lives in `CURRENT_SCHEMA_VERSION` (`src-tauri/src/db/mod.rs`). See [docs/data-model.md](docs/data-model.md).

Release installers may bundle ffmpeg for video thumbnails; the **Git repository does not**. Uninstall does not delete the media library directory; index/settings live under `%APPDATA%\com.camera.media-library\`.

## [Unreleased]

### Fixed

- 修复主页（媒体库网格）滚动卡顿：两张原因叠在一起——每张卡片自带 3 个 `backdrop-filter`（选择/收藏按钮 + 类型角标 + 时长胶囊），窗口化滚动时同时挂着二三十张就是近百个每帧重采样的合成层；粘性工具条的 `url(#lg-filter-*)` 位移贴图又因为 `position:sticky` 落在滚动容器内，被每帧重放整条滤镜链。现在滚动期间临时降级玻璃质感（停手 180ms 自动恢复，静止画面逐像素不变），并断开液体玻璃观察器、停手后全量同步一次。同条件实测：脚本耗时 −61%、样式重算 −76%、主线程繁忙 −48%
- 修复虚拟滚动每帧的无谓重排：`paintGridWindow()` 原先即使挂载的窗口一像素没变，也要走完整条 reconcile（读 rect → 写 spacer → keyed diff → 每张卡 6 次 `querySelector` + 无条件 `setAttribute` → 最后再读 N 次 rect 触发一次强制同步回流）。改为先算窗口签名，相同就直接返回；非滚动的变化由 `patchGrid()` 主动失效
- 修复虚拟滚动与浏览器滚动锚定打架：顶部 spacer 改高度时，`overflow-anchor` 会把它当成「内容在视口上方长出来」并反向补偿 `scrollTop`，表现为滚动位置一抽一抽地对不上指针。`.content` 现为 `overflow-anchor:none`
- 修复 `.content` 滚动条样式整段失效：同时声明了 `scrollbar-width`/`scrollbar-color` 与 `::-webkit-scrollbar`，标准属性一旦命中就让 webkit 那套全部作废，条体宽度、圆角、拖拽热区都没生效
- 修复拆分后启动只剩空骨架：`main.ts` 把 `render/paint.ts` 门面里的壳函数当成实现注入了 `installPaint()`，第一次重绘即自我递归爆栈（侧栏、工具栏、网格全部空白，只剩品牌栏与搜索框）。改为从 `app/`、`views/` 导入真实实现；`installPaint()` 增加装配期自检，注入门面自身时直接抛错并点名是哪个成员
- 补回拆分时丢失的两处顶层副作用注册：`render/events.ts`（卡片/工具栏的 `data-action` 事件委托）与 `app/bindings/global.ts`（全局快捷键、拖放、后端进度事件流）此前无人 import，界面能画出来但卡片、筛选 chip、`/` 搜索快捷键全部无响应。`src/main.wiring.test.ts` 用静态断言堵住这两类回归

### Changed

- 滚动条改为常驻自定义样式：可拖拽热区 11px（透明 border 撑开，视觉仍是细条）、圆角拇指、hover/active 逐级加深，替换掉系统默认那条又窄又没有反馈的
- 前端渲染层按职责拆分：`src/main.ts` 从 8443 行收敛到 84 行，渲染原语进 `src/render/`、界面进 `src/views/`、动作与事件绑定进 `src/app/`，`state` 单例独立成 `src/state.ts`；模块间零循环依赖，视图层通过 `render/paint.ts` 门面回调重绘，不再反向依赖动作层。行为、DOM 结构、CSS 类名与事件全部不变

## [0.6.0] - 2026-11-12

Assets: [GitHub Release v0.6.0](https://github.com/LiuQingDo/Camlib/releases/tag/v0.6.0) — `Camlib_0.6.0_x64-setup.exe` (NSIS, recommended)

### Added

- 启动时探测 ffmpeg：首帧渲染后异步检测 ffmpeg 是否可用，缺失时在顶部给一行可关闭的安装引导（提示 `winget install ffmpeg`，装完重启生效），设置 → 关于 显示可用性与实际解析到的路径；探测放在首帧之后、缺失也不阻塞首屏，不再等到真正转码时才报错
- 备份可选深度校验（默认关闭）：复制时边读边算源文件 SHA-256，落盘后回读目标文件比对，能发现"大小不变但内容已损坏"的静默损坏（USB 传输错码、存储卡位翻转）；不一致的文件不会提交到媒体库，记为可重试的失败项，可直接用「重试失败文件」重跑。开关在备份预览面板第 1 步，随预览计划持久化（新增 migration 0008，schema 版本 8），重试沿用同一设置。分段合并生成的视频不做内容比对（ffmpeg 重新封装，字节不同，仍按大小窗口校验）

### Changed

- 媒体网格改用固定行高虚拟滚动：只渲染视口内与上下缓冲区内的行，长列表的 DOM 节点数量封顶，滚动与筛选不再随库大小线性变慢；按天分组的 section 与卡片列表复用、上下 spacer 撑高，滚动位置与分组吸顶保持不变
- 卡片区与粘性工具栏改用事件委托：点击、双击等交互统一绑在容器上按 `data-*` 分发，监听器不再随每次渲染重建，选择模式切换与筛选重绘时不再累积监听成本
- `render()` 改为骨架 + 分区增量更新：外壳只建一次，状态变化只重绘受影响的分区，缩略图不再随选中、收藏、评分等状态切换被重建，消除闪白与重复解码
- 后端按实体拆分模块：`db/queries/` 与 `commands/` 按实体分文件，`lib.rs` 从 2025 行收敛到 165 行，`db/mod.rs` 从 3974 行收敛到 437 行，对外命令签名不变
- AI 网络命令移出命令线程：阻塞式 HTTP 调用改到独立线程执行，不再占用 Tauri 命令线程，并补齐 connect 15s / read 60s / total 120s 三段超时，弱网或提供商无响应时能按预期失败而不是无限挂起

## [0.5.0] - 2026-11-02

Assets: [GitHub Release v0.5.0](https://github.com/LiuQingDo/Camlib/releases/tag/v0.5.0) — `Camlib_0.5.0_x64-setup.exe` (NSIS, recommended), `Camlib_0.5.0_x64_en-US.msi` (WiX)

### Added

- AI 助手对话抽屉：侧边栏入口打开可伸缩的对话抽屉，多轮流式对话（逐段回传、可中途停止），系统提示词由 Rust 端注入媒体库概况与当前浏览/预览/多选上下文，前端不持有提示词；助手只读，回复末尾的 `[搜索] 关键词` 标记由前端渲染为一键语义搜索 chip
- 侧边栏 AI 区块：提供单张/选中打标入口，与详情面板的 AI 打标结果共用同一套任务与统计
- AI 增强（可选，默认关闭）：云端 API 自动打标与语义搜索，共用一条 OpenAI 兼容管线
  - 设置 → AI 增强：总开关（含隐私提示）、对话模型与 Embedding 两组独立配置、"测试连通性"按钮、已处理/待处理/失败统计
  - 自动打标：多模态对话模型对照片缩略图（~512px，复用现有缩略图管线，不上传原图）生成中文标签 + 一句话描述；标签写入现有标签体系但存于独立关联表 `media_ai_tags`，删除手打标签绝不误删 AI 标签，筛选区 AI 标签带徽标
  - 批量处理：增量 / 全量 / 仅重试失败 / 仅补算向量四种模式；预览预计 API 调用次数后确认执行；进度事件、可取消、并发 1–4 可调、失败指数退避；缩略图不可用的照片跳过并保持待处理
  - 语义搜索：筛选区自然语言输入（如"去年秋天湖边的照片"）→ 对话模型解析为时间范围/类型 + 语义文本；条件走 SQL、语义文本实时 embedding 后与库存向量暴力余弦检索，结果取交集；纯向量无法处理"去年秋天"类时间表达，查询解析为必需环节
  - 降级路径：未配置 Embedding 模型时语义搜索退化为 caption/标签关键字（LIKE）匹配；纯时间/类型查询直接走 SQL
  - 详情面板新增"AI 描述"区块；新增 migration 0007（media_ai、media_ai_tags），schema 版本 7

### Changed

- 预览"媒体信息"的标签区合并显示 AI 标签：AI 标签带 AI 徽标与手动标签并列展示、可单独移除（存储仍分离：`media_tags` / `media_ai_tags`，后端 `ai_tags` 由标签名列表改为解析后的真实标签行）；同一条目同时存在两类关联的标签只渲染一枚 chip（用户色 + AI 徽标，× 先移除手动关联再移除 AI 关联）；"AI 描述"区块仅保留描述文本与打标入口；"＋ 添加标签"选择器不再建议已由 AI 挂载的标签
- 标签展示为大量 AI 标签做收起式改版：预览"媒体信息"中平铺的候选标签行替换为「＋ 添加标签」可搜索选择器（按使用数量排序、输入即过滤不丢焦点、支持连续添加、Esc 收起）；媒体总览工具栏标签筛选改为「已选标签 + 热门标签（≤8，按条目数排序）」内联展示，其余收进「更多标签 ▾」可搜索下拉面板（含条目数与 AI 徽标、点击切换筛选、保持滚动与搜索状态、点击外部/Esc 关闭）

### Fixed

- 预览窗口中打的标签、评分、收藏与 AI 打标结果在关闭后"消失"（数据实际已写入数据库）：预览资产缓存把元数据与媒体流一起缓存，写库后未失效，重开预览时回放旧元数据；现在所有元数据写入（单张/批量打标、评分、收藏、标签重命名与删除、AI 任务完成）都会失效对应缓存，重开立即显示最新值
- AI 连通性测试不发送 Authorization 请求头（键存在性判断写反），导致所有带鉴权的提供商返回 401 并被笼统提示为"请求参数无效"；同时 AI 相关错误改为直接显示后端原始信息（含 HTTP 状态码、排查提示与提供商响应摘要），不再被通用文案吞掉

## [0.4.0] - 2026-11-01

Assets: [GitHub Release v0.4.0](https://github.com/LiuQingDo/Camlib/releases/tag/v0.4.0) — `Camlib_0.4.0_x64-setup.exe` (NSIS, recommended), `Camlib_0.4.0_x64_en-US.msi` (WiX)

### Added

- Media editor with image editing and video clipping: edited products are saved as new copies into the library instead of overwriting the originals
- Video multi-segment clipping: cut a video into several segments on a bottom full-width console (timeline scale, playhead, fine-tune buttons) and choose which segments to merge-export
- Multi-select video merge: select multiple videos in the library and merge them into one file
- All dialogs (媒体预览 / 媒体编辑 / 设置 / 标签管理 / 删除确认) are now manually resizable: drag any edge or corner to resize, and the size is saved automatically so the next launch opens the dialog at the adjusted size
- Settings → 系统 gains a 弹窗大小 card with numeric width/height fine-tuning per dialog (leave a field empty to fall back to the stylesheet default) plus per-dialog and global 恢复默认 buttons
- Media preview / edit dialogs auto-size to the media being shown (弹窗按媒体自适应尺寸)

### Changed

- Reworked media edit dialog UI: image panel uses icon tiles, double-row sliders (double-click to reset) with an adaptive output preview; video clipping console spans the bottom of the dialog; background preview playback pauses while the editor is open

### Fixed

- Preview modal content reloads after full rendering, so an already-open viewer no longer stays stuck on the placeholder state

## [0.3.1] - 2026-10-05

Assets: [GitHub Release v0.3.1](https://github.com/LiuQingDo/Camlib/releases/tag/v0.3.1) — `Camlib_0.3.1_x64-setup.exe` (NSIS, recommended), `Camlib_0.3.1_x64_en-US.msi` (WiX)

### Fixed

- Merged-away video segments no longer linger in the media list: recycling merge sources now also drops their index rows (the follow-up scan previously only flipped them to permanent 离线 cards)
- New 清理离线条目 action in the index settings clears existing offline index rows whose files are gone; it is blocked while the library is unavailable so an unplugged drive cannot wipe the index

## [0.3.0] - 2026-10-03

Assets: [GitHub Release v0.3.0](https://github.com/LiuQingDo/Camlib/releases/tag/v0.3.0) — `Camlib_0.3.0_x64-setup.exe` (NSIS, recommended), `Camlib_0.3.0_x64_en-US.msi` (WiX)

### Added

- Merge camera-split video segments during backup: same-timestamp consecutive clips concatenate with progress and cancel; selective merge for already backed-up segments; scans ignore leftover merge scratch and drop those rows from the library
- Sort media by file size (`文件大→小` / `文件小→大`); the choice persists as part of UI preferences

### Fixed

- Sort dropdown reverted to 最新 after choosing 评分/大小 sorts: `ui_sort` was serialized as camelCase (`ratingDesc`) while the frontend expects kebab-case (`rating-desc`); persisted values from older builds still load correctly

## [0.2.0] - 2026-09-21

Assets: [GitHub Release v0.2.0](https://github.com/LiuQingDo/Camlib/releases/tag/v0.2.0) — `Camlib_0.2.0_x64-setup.exe` (NSIS, recommended), `Camlib_0.2.0_x64_en-US.msi` (WiX)

### Added

- Persisted light/dark `ui_theme` preference
- Collapsible filters, infinite-scroll load-more, and thumbnail cache
- SVG star ratings, duration badge, and preview skeleton
- Auto-dismissing toast kinds and dismissible error banner
- Open-source scaffolding: GitHub Actions CI, issue / PR templates, `CONTRIBUTING.md`, `SECURITY.md`, this changelog
- Repo and package metadata (description, repository links, keywords)

## [0.1.2] - 2026-09-20

Assets: [GitHub Release v0.1.2](https://github.com/LiuQingDo/Camlib/releases/tag/v0.1.2) — `Camlib_0.1.2_x64-setup.exe` (NSIS, recommended), `Camlib_0.1.2_x64_en-US.msi` (WiX)

### Added

- Custom embedded titlebar with window controls
- `ui_preview_mode` setting (standard / immersive preview)
- English README (`README.en.md`) and language switcher links
- MIT `LICENSE` and package metadata
- Documentation for Insta360 Ace Pro 2 USB backup and default ignored extensions (`.dng`, `.lrv`)
- Settings for default ignore extensions; backup panel can override per job

### Changed

- README rewritten with feature tables and project structure
- UI polish (e.g. glass header panel radius)
- Local `ffmpeg.exe` under `src-tauri/resources/ffmpeg/` is gitignored; repo keeps layout README only

## [0.1.1] - 2026-09

### Fixed

- Serve image streams whole; photo zoom / pan viewer

### Changed

- Version bump and related frontend / Tauri fixes

## [0.1.0] - 2026

Initial line: local media library (scan, browse, filter), favorites / tags / ratings, Recycle Bin deletes, camera USB backup (DCIM discover → preview → copy verify), tray / single-instance shell, SQLite index.

<!-- Link refs -->

[Unreleased]: https://github.com/LiuQingDo/Camlib/compare/v0.3.1...HEAD
[0.3.1]: https://github.com/LiuQingDo/Camlib/releases/tag/v0.3.1
[0.3.0]: https://github.com/LiuQingDo/Camlib/releases/tag/v0.3.0
[0.2.0]: https://github.com/LiuQingDo/Camlib/releases/tag/v0.2.0
[0.1.2]: https://github.com/LiuQingDo/Camlib/releases/tag/v0.1.2
[0.1.1]: https://github.com/LiuQingDo/Camlib/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/LiuQingDo/Camlib/releases/tag/v0.1.0
