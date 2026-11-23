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

### Added

- 反馈拆成三条互不抢占的通道：错误条（常驻错误/告警，最多并列 3 条、其余报「还有 N 条」，技术细节默认折叠）、任务胶囊（顶栏最前，显示「标题 42%」，点开可见明细与取消）、右下角 toast（成功 4s 自动收、错误常驻；同文案合并，屏上最多 3 条、多的排队而不是互相顶掉）。原来是一条 if-else 横幅，同一时刻只能显示一条，扫描一开始「索引损坏」「媒体库已断开」就被盖掉
- 供应商的模型改成「现取」：配置页不再预置模型清单，改用一个「获取模型」按钮，按当前地址与密钥向上游请求 `GET /models`，把厂商真实可用的模型列成可勾选的网格（超过 8 条自动出现过滤框），可保留多个模型，并分别指定**识图模型**（自动打标，需支持图片输入）与**对话模型**（AI 助手与检索解析）；两个角色可以是同一个模型，选不中或厂商没提供该接口时仍可直接手填模型 ID。各家在售型号几个月换一轮，写死的清单迟早会给出过期答案
- 「获取模型」按表单里**此刻**的地址与密钥请求（不要求先保存），失败不弹窗、只把厂商原话留在模型栏，手填照常可用；换档案、切区域或保存后自动丢弃旧清单，避免点到上游并不存在的名字

- AI 配置支持多套档案：同一服务商可以保存多条（两个账号、打标用便宜模型 + 对话用强模型），每条档案**各自保存自己的 API Key**，切换、改名或删除某条不会串用或覆盖其它条的 Key；切换服务商时 Key 输入框自动换成该服务商已存的 Key（没有就留空），新建档案默认沿用当前服务商与它的 Key。旧版单条配置在读取时自动迁移成一条档案，原有 Key 与模型保持不变

### Fixed

- 删除与批量操作的反馈不再跟着内容滚走：删除进度进任务胶囊，结果走右下角 toast；部分失败时 toast 常驻，点「查看 N 条失败」把逐条错误折叠进错误条，并带「重试失败项」（只把失败项放回选择集，重走既有的预览→确认）。删除本身的行为一字未改
- 保存配置时拦截「还没指定识图 / 对话模型」的档案并指明是哪一条、怎么补——模型不再预填，空着保存等于存一条跑不起来的配置；旧配置里的单一 `model` 读取时自动填进两个角色，升级后无需重配
- 修复新版推理模型选好也打不了标：OpenAI GPT-6 系、部分国产推理模型会以 400 直接拒收请求体里的 `temperature` / `max_tokens`（要求改用 `max_completion_tokens` 或干脆不传），而传输层这两个字段是写死的。现在识别到 400 报文点名这些参数时，去掉 `temperature` / `max_tokens` / `top_p` 自动重发一次；其余错误仍按原样透出状态码与服务商原文，不会把"模型不存在"之类的真错误也重试一遍
- 修复主页滚轮停下时整屏缩略图"闪一下"：入场淡入原来写成 `.card-preview img` 的常驻 `animation`，滚动降级期间被 `html.is-scrolling … { animation:none }` 摘掉，撤掉降级标记的那一刻浏览器把它当成新动画重放——所有已显示的缩略图一起从 `opacity:0` 淡回 1（实测停手后第 56ms，12 张可见图 `opacity` 全部归 0）。现在淡入只挂在真正到货的那张图上（`.card-preview img.is-fresh`，`render/grid.ts` 建 `<img>` 时按是否在滚动决定加不加），骨架 shimmer 的降级也从 `animation:none` 改成 `animation-play-state:paused`，暂停不重启动画
- 修复预览里 ←/→ 换图的"卡一下、闪一下"：换图走的是整块签名重建，`.modal-backdrop` 连同全屏 `backdrop-filter: blur(18px)` 和面板一起被替换，入场动画重播、弹窗几何重算、媒体节点重新挂载。现在外壳只在打开时建一次，换图只改位置计数/标题/按钮可见性，`#modal-media` 由装载钩子交叉替换（旧图一直留到替换那一刻，不再先清成转圈）。12 次连续换图同条件实测：脚本耗时 −40%、样式重算 −11%、主线程繁忙 −17%，入场动画 `startTime` 不再重置
- 修复关闭弹窗是硬切：原来是直接把容器 `innerHTML` 清空，画面上"闪没了"。现在先给根节点播 140ms 淡出再摘 DOM，退场期间 `pointer-events:none` 不吃点击；这 140ms 内重新打开同一个弹窗会撤掉定时器直接换新内容，不会清掉刚绘制的面板
- 修复打开设置/预览时面板动画掉帧：liquid-glass 的位移贴图按元素当前尺寸生成，入场动画每帧都在改它的尺寸与位置，`url(#lg-filter-*)` 整条滤镜链要逐帧重放，同一时间观察器还会对刚插入的面板跑一次 canvas 生成 + `toDataURL()`。现在过渡窗口里摘掉位移贴图、只留同档纯模糊，动画结束补一次全量同步把折射带还回来（与滚动降级同一套思路）
- 修复设置分区切换里的强制同步回流：原来靠「摘类 → 读一次 `offsetWidth` → 加类」重启 CSS 动画，那次读发生在 `innerHTML` 写入之后，等于逼浏览器当场把新内容回流一遍；改用 WAAPI 播放透明度，不碰布局，连切时也只是把上一条动画换掉
- 修复主页（媒体库网格）滚动卡顿：两张原因叠在一起——每张卡片自带 3 个 `backdrop-filter`（选择/收藏按钮 + 类型角标 + 时长胶囊），窗口化滚动时同时挂着二三十张就是近百个每帧重采样的合成层；粘性工具条的 `url(#lg-filter-*)` 位移贴图又因为 `position:sticky` 落在滚动容器内，被每帧重放整条滤镜链。现在滚动期间临时降级玻璃质感（停手 180ms 自动恢复，静止画面逐像素不变），并断开液体玻璃观察器、停手后全量同步一次。同条件实测：脚本耗时 −61%、样式重算 −76%、主线程繁忙 −48%
- 修复虚拟滚动每帧的无谓重排：`paintGridWindow()` 原先即使挂载的窗口一像素没变，也要走完整条 reconcile（读 rect → 写 spacer → keyed diff → 每张卡 6 次 `querySelector` + 无条件 `setAttribute` → 最后再读 N 次 rect 触发一次强制同步回流）。改为先算窗口签名，相同就直接返回；非滚动的变化由 `patchGrid()` 主动失效
- 修复虚拟滚动与浏览器滚动锚定打架：顶部 spacer 改高度时，`overflow-anchor` 会把它当成「内容在视口上方长出来」并反向补偿 `scrollTop`，表现为滚动位置一抽一抽地对不上指针。`.content` 现为 `overflow-anchor:none`
- 修复 `.content` 滚动条样式整段失效：同时声明了 `scrollbar-width`/`scrollbar-color` 与 `::-webkit-scrollbar`，标准属性一旦命中就让 webkit 那套全部作废，条体宽度、圆角、拖拽热区都没生效
- 修复拆分后启动只剩空骨架：`main.ts` 把 `render/paint.ts` 门面里的壳函数当成实现注入了 `installPaint()`，第一次重绘即自我递归爆栈（侧栏、工具栏、网格全部空白，只剩品牌栏与搜索框）。改为从 `app/`、`views/` 导入真实实现；`installPaint()` 增加装配期自检，注入门面自身时直接抛错并点名是哪个成员
- 补回拆分时丢失的两处顶层副作用注册：`render/events.ts`（卡片/工具栏的 `data-action` 事件委托）与 `app/bindings/global.ts`（全局快捷键、拖放、后端进度事件流）此前无人 import，界面能画出来但卡片、筛选 chip、`/` 搜索快捷键全部无响应。`src/main.wiring.test.ts` 用静态断言堵住这两类回归

### Changed

- 设置页 AI 区改成 magpie 那样的供应商面板，三段式替代原来的「卡片墙 + 档案下拉」：**已添加列表**（每行一个供应商，显示模型与掩码 Key、所属分类、是否使用中，可设为使用中 / 编辑 / 删除）→ **添加供应商**（顶部「订阅 / API 供应商 / 中转 / 本机」四个分类页签 + 搜索框 + 厂商卡片网格，本版本只接入 API 供应商，订阅页给空态说明）→ **单个供应商配置**（模型下拉、API Key、厂商控制台的「获取 Key ↗」跳转、备注名、接口地址与并发放折叠的高级设置）。原来「新建配置 / 删除」按钮与档案下拉被列表取代，同厂商加多条仍是「再点一次那张卡片」，每条各存 Key 的隔离性不变
- 服务商预设增加分类、品牌色与「获取 Key」链接三个字段：厂商直连归 API 供应商，硅基流动 / OpenRouter 归中转，Ollama / LM Studio 归本机（能力不变，只是分到各自页签下）；卡片徽标改用各家品牌色做浅底，不再是统一的灰块
- AI 供应商面板收敛成「只有模型厂商的 API」：去掉「订阅 / 中转 / 本机」分类页签，添加面板改成一屏三列厂商网格（19 家）。国内 DeepSeek / Kimi / 智谱 GLM / 通义千问 / 火山方舟 / MiniMax / 百度千帆 / 腾讯混元 / 阶跃星辰 / LongCat / 小米 MiMo 全在，海外是 OpenAI / Anthropic / Google Gemini / Grok / Mistral / Groq，加「自定义」。已添加过的中转与本机配置仍能凭预设回显，只是不再出现在添加面板里
- 供应商配置页按厂商控制台的「添加供应商」弹窗重做：头部是厂商标识 + 控制台域名（可点开），字段依次为 API 密钥（显示/隐藏 + 获取密钥）、端点（按 OpenAI / Responses / Anthropic 三种协议各一行，应用只走 OpenAI 兼容那条，其余标「仅展示」）、区域（多区域厂商：Kimi 中国/国际、通义千问 中国/新加坡、智谱 GLM 国内/海外 z.ai、MiniMax 国内/国际）、模型（卡片单选，标出看图 / 仅文本）、备注名；接口地址与并发折进「高级」，底部是「测试连接 / 取消 / 添加（保存）」
- 取消新建会连带丢弃那条空档案：原来从厂商网格点进配置页再返回，列表里会留一条谁也没填过、又不能用的配置
- 供应商预设按官方文档重新核对（2026-11）：DeepSeek 的 base_url 改为 `https://api.deepseek.com`（并登记 Anthropic 端点），新增 Anthropic / Mistral / Groq，模型清单更新到当前在售（deepseek-flash、kimi-k3、glm-5.3、qwen4-max、doubao-seed-2.1、MiniMax-M3、ernie-5.1、hy4、step-5-preview、LongCat-2.0、mimo-v2.6、claude-opus-4-7、gemini-4-hydrogen、grok-4.7 等）
- `findProvider()` 的兜底从「数组最后一项」改成显式找预设里的 `custom`：分组重排后最后一项变成了本机服务，未知厂商 id 会被静默指向 `127.0.0.1` 的 Ollama，已修正
- AI 服务商清单按 2026-11 各家官方文档重核，服务商从 9 家扩到 14 家：新增豆包·方舟（`doubao-seed-2.1-pro/lite/turbo`）、百度千帆（`ernie-5.1`）、腾讯混元（`hy4`）、MiniMax（`MiniMax-M3`）、Google Gemini（`gemini-4-argon`，走 `v1beta/openai` 兼容层）、Grok（`grok-4.7`）。原有预设的模型也换成当前在售型号——OpenAI `gpt-6.1-terra/6-luna/6.1-sol/6-astra`、通义 `qwen4-max/qwen3.8-flash/qwen3-vl-plus`、GLM `glm-5.3-flash/glm-5v-turbo/glm-4.6v-flash`、Kimi `kimi-k3.1-pro/kimi-k2.6`、DeepSeek `deepseek-flash`（现已支持图片）、硅基流动 `Qwen3-VL-32B/30B-A3B/8B`、Ollama `qwen3-vl:8b/4b/30b-a3b`；清单只收能走 Chat Completions 且吃 `image_url` 的模型，`vision` 标记逐条核对，纯文本模型仍会被设置页提示
- AI 增强取消 Embedding 模型与向量检索：模型配置从「对话 + embedding 两组」收成一套，语义检索改为对话模型解析出时间/类型条件 + 关键词，条件走 SQL、关键词匹配已生成的描述与标签后取交集；批量处理去掉「仅补算向量」。`media_ai` 的 `embedding` / `embedding_model` / `embedding_dim` 三列由迁移 `0009_ai_drop_embeddings.sql` 删除（schema v9）
- AI 模型配置改为服务商卡片 + 模型下拉，不再要求手填 Base URL：OpenAI / 通义千问 / 智谱 GLM / Moonshot / DeepSeek / 硅基流动 / OpenRouter / Ollama / LM Studio 各带接口地址与常用模型，私有部署或清单外的模型走「自定义」；选中纯文本模型时提前提示打标不可用，配置改动先落草稿、保存或测试时才写库
- 界面文案里的「语义搜索」统一改为「AI 搜索」，与"检索依据是描述与标签而不是向量"保持一致
- 虚拟滚动的缩略图排队改为只处理本帧新建的卡片：原来每次挂载新行都要把整棵树拉出来、对每张卡读一次 `getBoundingClientRect`，而写入之后的读会当场触发一次强制同步回流——其中绝大多数卡片早就装载过，属于白读
- 弹出层开关统一走 `render/overlay-transition.ts` 的过渡窗口，新增 `html.is-overlay-animating` 标记，进出场的动画只动 `opacity`/`transform` 两个合成属性
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
