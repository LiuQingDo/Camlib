# Camlib 优化调整计划

> 体检基线：v0.5.0（commit `3332c1d`）
> 文档目的：把体检结论拆成**可独立开一个会话就能做完**的任务，每个任务带自包含提示词。
> 行号会随迭代漂移，**以函数名/文件名为准**，行号仅作首次定位参考。

---

## 0. 结论

这个项目的工程纪律已在同类个人项目之上：TS `strict` 全开且零 `any`、统一 `{ code, message, retryable, details? }` 错误契约、CSP 与 capabilities 收得很紧、文档与迁移是真相来源、后端 112 个测试。所以本轮优化的目标不是"补窟窿"，是**止掉三处结构性利息**，再顺手把交付流水线补齐。

| # | 问题 | 证据（v0.5.0） | 影响 |
| --- | --- | --- | --- |
| P0-1 | 前端单文件 + 全量 `innerHTML` 重建 | `src/main.ts` 7482 行；`render()` 重写整个 shell；109 处 `render()` 调用；249 处 `addEventListener` 在每次 render 重绑 | 交互卡顿、缩略图闪烁、焦点丢失，且每加一个交互就要多写一段"重建后恢复"的补偿代码 |
| P0-2 | AI 命令在同步上下文里做阻塞 HTTP，且无读超时 | `lib.rs` 的 `ai_test_connection` / `ai_process_item` / `ai_search` 均为同步 `fn`；`ai.rs` 的 `UreqTransport::agent()` 只设 `timeout_connect(15s)`；失败重试的 `std::thread::sleep` 也在同一线程 | 点一次"测试连通性"界面卡到 provider 返回；服务端挂起时无限等待 |
| P0-3 | 前端 0 测试，CI 只做 typecheck | `src/` 无 `*.test.ts`；`ci.yml` 只有 `pnpm build` / `cargo fmt` / `cargo test` / `cargo check` | 前端重构没有安全网，P0-1 不敢动 |
| P1-1 | 无虚拟滚动，DOM 只增不减 | `limit` 默认 120，滚动加载 500/页，只控制"继续加载"不控制"卸载离屏" | 几千张后滚动发涩 |
| P1-2 | 备份只校验文件大小 | `backup.rs` 用 `metadata.len() == expected_size` | 静默损坏检测不出来，这是核心卖点的地基 |
| P2 | 版本号三处手改、无 lint、CI 无 clippy/打包 | `package.json` / `Cargo.toml` / `tauri.conf.json` 均为 `0.5.0` | 发布摩擦 |

**修正一条上一轮的口头判断**：`ai_search` / `ai_test_connection` 的网络调用实际发生在 `with_infrastructure` 闭包**之外**，不存在"全局锁被网络延迟绑架"的问题。P0-2 的问题范围收窄为"同步命令 + 阻塞 I/O + 缺读超时"，仍然成立。

---

## 1. 约束与红线

所有会话都必须遵守，提示词里已内联，此处为总纲：

1. **不改错误契约**：`{ code, message, retryable, details? }` 与 `src-tauri/src/errors.rs`、`src/api/errors.ts` 的码表不得增删语义。
2. **不改 Command 名与调用方式**：前端 `invoke` 的命令名、参数结构保持不变（除非该会话明确说明可以改）。
3. **不放宽安全边界**：CSP、`capabilities/default.json` 权限、路径校验（拒绝 `..`、绝对路径、UNC、设备前缀）、删除走回收站——只允许收紧，不允许放宽。
4. **Schema 变更必须新增迁移文件**，同步更新 `docs/data-model.md`。
5. **每个会话结束必须全绿**：`pnpm build`、`cargo test`、`cargo fmt --check`；改了前端再加 `pnpm test`。
6. **一个会话一个 commit**，用 conventional commit 前缀：`refactor(frontend): …` / `fix(ai): …` / `test(frontend): …` / `chore(ci): …`。
7. **不允许顺手做无关重构**——范围外的问题记进 Issue，不要塞进同一个 commit。

---

## 2. 会话总览

| 会话 | 名称 | 依赖 | 体量 | 风险 | 产出 |
| --- | --- | --- | --- | --- | --- |
| **S1** | AI 命令线程模型与超时加固 | 无 | 小（半天） | 低 | 3 个命令改 async，网络不再卡 UI |
| **S2** | 前端测试基座 + 纯函数抽取 | 无 | 小（半天） | 低 | vitest + 4 个 lib 模块 + CI 接入 |
| **S3a** | 事件委托（局部试点） | S2 | 中 | 中 | 卡片区/工具栏监听器从 ~200 降到个位数 |
| **S3b** | `render()` 分区增量更新 | S2、S3a | 大（1–2 天） | 高 | 全量重建 → 分区 patch，卡片节点可复用 |
| **S4** | 缩略图网格虚拟滚动 | S3b | 中 | 中 | 固定行高 windowing，DOM 数量封顶 |
| **S5** | 备份深度校验（可选 xxh3） | 无 | 小 | 低 | 预览面板加"深度校验"开关 |
| **S6** | 工程化清扫（版本/lint/CI/死资源） | 无 | 小 | 低 | 一次做完，无需拆分 |
| **S7** | Rust 模块拆分（`db` / commands） | S1、S2 后端测试 | 大 | 中 | 3974 行的 `db/mod.rs` 按实体拆分 |

依赖关系：

```
S1 ─────────────────────────┐
S6 ─────────────────────────┤（可并行，互不干扰）
S5 ─────────────────────────┤
S2 ──► S3a ──► S3b ──► S4 ──┘
       └──────► S7（等后端测试补齐后再动）
```

**推荐节奏**（按你 07:30–16:30 的作息，一个会话＝一个上午或一个下午）：

1. 第一轮：**S1 + S6**（都是低风险纯收益，当天可合）
2. 第二轮：**S2**（安全网）
3. 第三轮：**S3a → S3b**（分两次，中间留一晚观察）
4. 第四轮：**S4 + S5**
5. 第五轮：**S7**（可选，不着急）

---

## 3. 会话详情

### S1｜AI 命令线程模型与超时加固

**目标**：AI 相关的三类网络操作不再占用命令线程；所有 HTTP 请求都有明确的上界。

**为什么先做**：纯收益、无赔本、和后端其他改动零耦合，可以立刻发一版。

**涉及文件**
- `src-tauri/src/lib.rs`：`ai_test_connection`、`ai_process_item`、`ai_search`
- `src-tauri/src/ai.rs`：`UreqTransport::agent()`、`chat_with_retry`

**改动要点**
1. 三个同步 `fn` 改为 `#[tauri::command] async fn`，把阻塞工作移入 `tauri::async_runtime::spawn_blocking`。
2. **`State<'_, T>` 不能跨 `await` 持有**：先在同步段把所需数据（`database_path`、`root`、`cache_dir`、config）取出来，再 move 进闭包。`ai_chat` / `ai_chat_stream` 已经是这个模式，照抄结构。
3. `agent()` 目前只有 `timeout_connect(15s)`，**补读超时与整体超时**（建议整体 120s、读 60s，给图片打标留余量）。
4. 确认 `chat_with_retry` 里的 `std::thread::sleep` 现在跑在阻塞线程上，而不是命令线程。

**验收**
- [x] `cargo fmt --check`、`cargo check`、`cargo test`（112 个全绿）
- [x] `pnpm build` 通过（前端零改动）
- [ ] 手动：设置 → AI 增强 → 测试连通性，填一个不可达的 Base URL，**界面不冻结**，15s 内返回错误
- [ ] 单张打标（`ai_process_item`）期间可以正常滚动、切换筛选

**提示词**

```text
项目：Camlib，Tauri 2 + Rust 后端的本地相机媒体库（Windows 优先）。仓库根目录就是当前工作目录。

## 背景
src-tauri/src/lib.rs 里三个 AI 命令是同步函数，内部走 ureq 做阻塞 HTTP：
- ai_test_connection（约 1493 行）
- ai_process_item（约 1780 行，单张打标，一次 vision 调用可能 5–30 秒）
- ai_search（约 1849 行，先调对话模型解析查询，再走向量检索）
同步 command 在 IPC 线程上执行，所以这三处会冻住界面。另外 src-tauri/src/ai.rs 的 UreqTransport::agent()（约 271 行）只设了 timeout_connect(15s)，没有读超时和整体超时，服务端接住连接但不回包时可以无限等待。ai.rs 里 chat_with_retry 含 std::thread::sleep 的重试退避，现在也跑在命令线程上。

## 任务
1. 把上述三个命令改为 `#[tauri::command] async fn`，阻塞工作放进 tauri::async_runtime::spawn_blocking。
   注意：State<'_, InfrastructureState> 的引用不能跨 await 持有。先在同步段取出 database_path / root / cache_dir / config 等所需数据，再 move 进闭包。
   参考同文件已有的 ai_chat（约 1680 行）与 ai_chat_stream（约 1726 行）的拆分方式，保持一致风格。
2. 在 UreqTransport::agent() 上补齐超时：整体超时 120 秒、读超时 60 秒（图片打标需要余量），保留现有 connect 15 秒。若 ureq 的 API 不支持某个维度，就用它能提供的等价组合，并在注释里写清实际生效的值。
3. 确认重试退避的 sleep 现在发生在阻塞线程上。

## 约束（必须遵守）
- 不改错误码与 { code, message, retryable, details? } 契约（见 errors.rs）。
- 不改前端 invoke 的命令名和参数结构，前端代码本次零改动。
- 不放宽 CSP / capabilities / 路径校验。
- 不顺手重构其他模块。

## 验收
- cargo fmt --check、cargo check、cargo test 全绿（现有 112 个测试不许减少）
- pnpm build 通过
- 三个命令改造后签名与 Tauri 的 generate_handler! 注册仍能编译（注意 async 命令在 handler 里的注册方式不变）

## 输出
改完后说明：每个命令改成了什么形态、超时值最终落在哪几个参数上、如何手动验证"界面不冻结"。
建议 commit：fix(ai): 网络命令移出命令线程并补齐超时
```

---

### S2｜前端测试基座 + 纯函数抽取

**目标**：给前端建立最小可信的测试网，为 S3a/S3b 的重构兜底。

**为什么第二做**：没有这层，后面动 `render()` 等于裸奔。

**涉及文件**
- 新增：`vitest.config.ts`、`src/lib/format.ts`、`src/lib/filters.ts`、`src/lib/selection.ts`、`src/lib/*.test.ts`
- 修改：`src/main.ts`（只做"搬走 + import"）、`package.json`、`.github/workflows/ci.yml`

**改动要点**
1. vitest 装为 devDependency，先跑 `environment: "node"`——第一阶段只测纯函数，不要引入 jsdom 的复杂度。
2. 抽三类纯函数（先从 `main.ts` 里读实现，不要凭空重写）：
   - 格式化：`formatSize` / `formatSpeed` / `formatEtaSeconds` / `formatDuration` / `formatCount` / `truncatePath` / `formatCaptureAt`
   - 输入解析：`parseExtensionsInput` / `extensionsToInput` / `hasAnyFilter` / `secondaryFilterParts`
   - 选择逻辑：Shift 区间选择的计算（先定位实现再抽）
3. `main.ts` 里删掉原实现，改为 import。**要求 main.ts 净行数下降，不允许增加。**
4. `package.json` 加 `"test": "vitest run"`；CI 在 `pnpm build` 之后加一步 `pnpm test`。

**验收**
- [ ] `pnpm test` 全绿，断言数 ≥ 20
- [ ] 边界覆盖：0 字节、负数、超大值（> 1TB）、空字符串、非法扩展名输入、跨月日期区间
- [ ] `pnpm build` 通过（`noUnusedLocals` 不会因搬移报错）
- [ ] `main.ts` 行数相比 7482 减少

**提示词**

```text
项目：Camlib，Tauri 2 + 原生 TypeScript + Vite 的本地相机媒体库。前端没有框架，src/main.ts 是 7482 行的单文件，包含状态、渲染和一堆工具函数。

## 任务
给前端建立最小测试网，并把可测的纯逻辑从 main.ts 抽出来。

### 1. 测试基座
- 安装 vitest 为 devDependency，新增 vitest.config.ts，environment 先用 "node"（这一阶段只测纯函数，不要引入 jsdom）。
- package.json 增加 script："test": "vitest run"。
- .github/workflows/ci.yml 在 "Frontend typecheck & build" 之后增加一步运行 pnpm test。

### 2. 抽取纯函数（先在 main.ts 里定位现有实现，原样搬移，不要重写逻辑）
- src/lib/format.ts：formatSize、formatSpeed、formatEtaSeconds、formatDuration、formatCount、truncatePath、formatCaptureAt
- src/lib/filters.ts：parseExtensionsInput、extensionsToInput、hasAnyFilter、secondaryFilterParts
- src/lib/selection.ts：Shift 连选的区间计算（先找到实现，可能内联在 toggleSelection 里，抽出来时保持行为完全一致）

### 3. 测试
每个模块配同名 .test.ts，总计至少 20 条断言。必须覆盖的边界：0 字节、负数、超过 1TB 的值、空字符串、null/undefined、非法扩展名输入（".DNG, lrv ,"这种）、跨月/跨年日期区间。

### 4. main.ts 收口
删除被抽走的原实现，改为从 ./lib/* import。要求 main.ts 净行数下降，不允许增加。

## 约束
- 不改变任何函数的可观察行为（格式化输出的字符串必须逐字一致）。
- 不动渲染逻辑、不动 API 层。
- tsconfig 的 strict / noUnusedLocals / noUnusedParameters 必须保持开启通过。
- 不引入任何 UI 框架。

## 验收
- pnpm test 全绿
- pnpm build 通过
- main.ts 行数 < 7482
- 列出抽走的函数清单和各自覆盖的边界用例

建议 commit：test(frontend): 建立 vitest 基座并抽取纯函数
```

---

### S3a｜事件委托（局部试点）

**目标**：把媒体卡片区与工具栏的监听器从"每次 render 重绑几百个"改成 document 级一次委托。

**为什么只做局部**：`main.ts` 有 249 处 `addEventListener`，一次性全改风险不可控。先改两个高频区，验证模式可行再推广。

**涉及文件**：`src/main.ts`（`bindEvents`、`bindMediaCardEvents`、`bindSelectionToolbarEvents`、`renderCard`、`renderSelectionToolbar`）

**改动要点**
1. 在 `render()` 之外（模块初始化时）注册一次 document 级 `click` / `change` / `input` 委托。
2. 卡片的可交互元素加 `data-action="favorite|open|select"` + `data-id`，委托里用 `closest("[data-action]")` 派发。
3. 删除对应的逐元素绑定函数，或保留空壳调用点先置空（便于 S3b 逐步清理）。
4. 注意 `event.preventDefault()` 与选中态的既有行为必须逐条对齐——改之前先把当前行为列成清单。

**验收**
- [x] 卡片与工具栏行为逐条对齐（清单见下方"落地结果"）
- [x] `pnpm test` + `pnpm build` 通过
- [x] 卡片区/工具栏监听器不再随 render 增长（改为 document 上 4 个常驻监听）

**落地结果（2026-11-11）**

- 迁移动作 29 个：`open-media` / `toggle-select` / `toggle-favorite`、`load-more` / `retry-load-more`、选择工具栏 10 个按钮、筛选工具栏 13 个控件（类型页签、收藏/连拍、标签 chip、更多标签、标签管理、展开筛选、清除筛选、日期预设、清除区间、日期输入、评分、排序、密度）。
- 监听器：`addEventListener` 静态调用点 249 → 221；运行时每页（120 张卡）从约 500 个降到 4 个（卡片 4×120、选择工具栏 10、筛选工具栏 26、加载更多 2）。
- 委托用**捕获阶段**：卡片内缩略图"重试"按钮的处理器在 `app` 冒泡监听里 `stopPropagation()`，改造前它先冒泡到卡片打开预览；捕获派发保持同一顺序。
- 未迁移（本次范围外）：侧栏日期树、顶部搜索框、预览弹窗、删除确认、标签管理、合并弹窗、设置页、AI 抽屉/侧栏区块、编辑器。
- 提示词里提到的「Ctrl 多选 / 双击收藏 / 拖拽框选 / 点空白清空选择」在当前实现中**不存在**（卡片点击忽略修饰键、只按 `Shift` 做区间连选），本次不新增，行为保持不变。

**提示词**

```text
项目：Camlib，Tauri 2 + 原生 TypeScript 的桌面应用。src/main.ts 7482 行，render() 每次都用 app.innerHTML 重建整个界面，然后调用 bindEvents() 重新绑定所有监听器（全文件约 249 处 addEventListener）。这导致每次交互都要重绑几百个监听器。

## 任务（本会话只做媒体卡片区 + 工具栏，不要动其他区域）
1. 在 render() 之外、模块初始化阶段，注册一次 document 级事件委托（click / change / input 按需）。
2. 卡片里的可交互元素改为携带 data-action 与 data-id，例如 data-action="open-media" data-id="…"、data-action="toggle-favorite"、data-action="toggle-select"。委托处理器用 event.target.closest("[data-action]") 派发。
3. 移除卡片区/工具栏对应的逐元素绑定（bindMediaCardEvents、bindSelectionToolbarEvents 里对应的那部分）。如果这些函数还有其他区域在用，保留函数但把已迁移的部分删掉。
4. 侧栏、弹窗、设置页的绑定本次一律不动。

## 前置：先列行为清单再改
动手前，先把当前卡片区支持的交互逐条列出来（单击打开、Ctrl 多选、Shift 连选、双击收藏、拖拽框选、点空白清空选择……），包括各自的 preventDefault / stopPropagation 行为。改完逐条对照，不允许少一条。

## 约束
- 交互行为必须逐条对齐，不改变任何用户可感知的行为。
- 不动 render() 的结构（那是下一个会话的事）。
- 不改 API 层、不改错误契约。
- 保留 data-* 命名的可读性，不要用数字编号。

## 验收
- pnpm build、pnpm test 通过
- 手动回归：单击预览、Ctrl 多选、Shift 连选、双击收藏、拖拽框选、点空白清空
- 说明迁移了多少个监听器，剩余未迁移的还有哪些区域

建议 commit：refactor(frontend): 卡片区与工具栏改用事件委托
```

---

### S3b｜`render()` 分区增量更新

**目标**：`render()` 从"重建整个 shell"改成"重建一次骨架 + 分区 patch"，卡片节点按 `data-id` 复用而不是销毁重建。

**这是本轮最大的一块**，也是唯一需要认真评估退路的一块。若中途发现风险过高，**允许只完成"网格区增量 + 其余仍全量"的中间态**并合入，不要硬推。

**涉及文件**：`src/main.ts` 的 `render()` 及其调用的各 `renderXxx()` 片段

**改动要点**
1. 拆成 `renderShell()`（只在启动/换库时执行一次）+ `patchSidebar()` / `patchToolbar()` / `patchGrid()`。
2. 网格区按 `data-id` 做 keyed 复用：已存在的卡片只更新变化的字段（收藏星、评分、选中态），不重建 `<img>`。
3. **删掉补偿性代码**——这是判断改造是否成功的硬指标：
   - 手动存还滚动位置（`previousScrollTop` / `previousScrollLeft`）
   - 预览模态重放（`if (state.previewIndex !== null) void loadModalAsset()`）
   - `tagPopoverScroll`、`syncLiquidGlass()` 重挂
   这些如果还在，说明 patch 没做到位。
4. 焦点保持：搜索框输入不再丢焦点。

**验收**
- [ ] 切换收藏 / 改评分 / 改密度 / 切换筛选，**缩略图不重新解码、不闪烁**
- [ ] 搜索框连续输入不丢焦点
- [ ] 滚动位置在筛选变化时自然保持（不是靠手动恢复）
- [ ] `pnpm test` + `pnpm build` 通过，无新增 `any`
- [ ] 上述 4 处补偿代码已删除

**提示词**

```text
项目：Camlib，Tauri 2 + 原生 TypeScript。src/main.ts 7482 行，核心问题是 render()（约 3584 行）用 `app.innerHTML = ...` 重建整个界面骨架，然后调用 bindEvents()、applyDialogSizes()、setupDialogResizing()、syncLiquidGlass() 全套重跑。全文件有 109 处调用 render()。

现在代码里已经积累了一批"全量重建的补偿代码"，它们是这次改造要消灭的目标：
- render() 开头手动保存 previousScrollTop / previousScrollLeft，结尾再写回
- render() 结尾 `if (state.previewIndex !== null) void loadModalAsset();` 重放预览
- 模块级的 tagPopoverScroll 用于恢复弹出的标签列表滚动位置
- syncLiquidGlass() 因为重建丢掉了 inline backdrop-filter 而必须重挂

## 任务
把 render() 改为「骨架一次 + 分区 patch」：

1. 新增 renderShell()：只在应用启动、切换媒体库、主题切换这类全局状态变化时执行，重建侧栏/顶栏/内容区的骨架容器，为后续 patch 提供稳定的挂载点。
2. 新增 patchSidebar() / patchToolbar() / patchGrid()：
   - patchGrid 按 data-id 做 keyed 复用：同 id 的卡片节点保留，只更新变化的字段（收藏星标、评分、选中态、标签徽标）。绝不重建已存在的 <img>。
   - 新增/消失的卡片按需插入/移除。
   - 只更新文本节点的 textContent，不要为了改一个数字重设整段 innerHTML。
3. 把 109 处 render() 调用按语义改到对应的 patch 函数。拿不准的（例如设置面板、弹窗、编辑器）可以继续走全量，但要在注释里标明"尚未增量化"。
4. 删除上面列出的 4 处补偿代码——这是本任务的验收硬指标。如果删不掉，说明 patch 范围不够，回去补。
5. 搜索框输入期间不得丢失焦点。

## 允许的中间态
如果发现一次性改完风险过高，允许合入"网格区增量 + 其余仍全量"的中间版本，但必须：(a) 补偿代码中与网格相关的那部分已删除；(b) 在代码注释和 commit message 里注明剩余待增量化区域。

## 约束
- 不改后端、不改 API 层、不改错误契约。
- 不引入 UI 框架（保持零运行时依赖）。
- 不放宽 CSP。
- 每完成一个区域就跑一次 pnpm build，不要最后一次性编译。

## 验收
- 切换收藏、改评分、拖动密度滑块、切换筛选：缩略图不闪烁、不重新解码
- 搜索框连续输入不丢焦点
- pnpm build、pnpm test 通过
- 列出删除的补偿代码位置，以及仍未增量化的区域清单

建议 commit：refactor(frontend): render() 改为骨架 + 分区增量更新
```

---

### S4｜缩略图网格虚拟滚动

**目标**：把渲染中的卡片节点数量封顶，长列表滚动不随库规模退化。

**前置**：S3b（没有稳定的网格 patch 机制，虚拟滚动会和全量重建打架）

**涉及文件**：`src/main.ts` 的网格渲染与 `observePreviews` / `observeLoadMore`、`src/styles.css`

**改动要点**
1. 固定行高（由 `--tile-min` 与卡片宽高比推导），用 spacer 上下撑开高度。
2. 只渲染可视区 ± 一屏的卡片；滚动时复用节点。
3. 与现有的 `IntersectionObserver`（缩略图加载 + 加载更多）对接：离屏卡片要取消排队中的缩略图请求，避免为看不到的图浪费 I/O。
4. 密度滑块变化要重算行高并重排。

**验收**
- [ ] 5000 张的库，DOM 中 `.card` 数量不超过可视区容量 × 3
- [ ] 滚动 60fps 无明显掉帧（devtools Performance 录制确认）
- [ ] 快速滚动时不出现空白占位（缩略图未及时加载要有占位骨架）
- [ ] 加载更多、回到顶部、筛选切换行为正常

**提示词**

```text
项目：Camlib，Tauri 2 + 原生 TypeScript。媒体网格在 src/main.ts 里渲染，分页 limit 默认 120，滚动到底自动加载下一页 500 条（约 6547 行），但加载进来的卡片永远不会被卸载——DOM 节点随滚动无限增长。

## 前置条件
上一轮已经完成 render() 的分区增量更新（patchGrid 按 data-id 复用卡片）。本次在这个基础上做虚拟滚动，不要退回全量重建。

## 任务
1. 实现固定行高虚拟滚动：根据 CSS 变量 --tile-min 与卡片宽高比推导行高，用上下两个 spacer 元素撑开总高度，只渲染可视区 ±1 屏的卡片行。
2. 滚动时复用已有卡片节点（按 data-id 换内容），不要反复创建销毁。
3. 与现有 IntersectionObserver 对接：
   - 缩略图加载（observePreviews）：卡片移出可视区时取消或跳过它排队中的缩略图请求，避免为看不到的图浪费磁盘 I/O。
   - 加载更多（observeLoadMore）：哨兵逻辑保持有效。
4. 密度滑块（1–5 档）变化时重算行高并重新布局。
5. 缩略图未加载完成时显示占位骨架，避免快速滚动出现空白塌陷。

## 约束
- 不改后端分页接口（limit/offset 语义不变）。
- 不引入虚拟滚动库，自己实现（控制在 ~100 行内，保持零依赖）。
- 视觉上与当前网格完全一致，不允许出现列数或间距变化。
- 不动侧栏、弹窗、编辑器。

## 验收
- 构造 5000 条数据的媒体库（可以临时改 limit 或用测试库），DOM 中 .card 元素数量不超过可视容量 ×3
- 快速滚动无空白、无抖动
- 缩略图请求数明显下降（可在 Rust 侧打日志或在 devtools Network/IPC 里观察）
- pnpm build、pnpm test 通过
- 说明行高如何推导、离屏卡片如何取消缩略图排队

建议 commit：perf(frontend): 媒体网格改用固定行高虚拟滚动
```

---

### S5｜备份深度校验（可选 xxh3）

**目标**：在"文件大小校验"之外提供一个可选的、按内容比对的完整性校验，堵住静默损坏。

**为什么值得做**：备份是这个产品的核心卖点，而现在的校验只有 `metadata.len() == expected_size`。USB 传输偶发静默损坏、坏卡位翻转，大小一样但内容坏了——现在的实现检测不出来。用户把卡格式化之后才发现，损失不可逆。

**涉及文件**：`src-tauri/src/backup.rs`（复制与校验路径）、`src-tauri/src/lib.rs`（预览 DTO）、`src/api/media.ts`（类型）、`src/main.ts`（预览面板开关）

**改动要点**
1. 加 `xxhash-rust` 依赖（或复用已有依赖里的哈希能力，先查 `Cargo.lock`），流式计算，不要整文件读进内存。
2. 预览阶段新增 `deepVerify: boolean`，默认 `false`；执行阶段按开关决定是否算源/目标哈希并比对。
3. 校验失败按现有 `CopyError` 契约返回，标记为可重试。
4. UI：备份预览面板加一个开关 + 一行说明"较慢，但能发现传输损坏"。
5. 大文件（视频）性能要实测，如果成本过高，允许降级为"仅校验前 N MB + 尾部 N MB"，但必须在 UI 上说明。

**验收**
- [ ] 默认关闭时，备份速度与现在一致
- [ ] 开启时，人为篡改目标文件一个字节，能检测出来并给出可重试错误
- [ ] 新增单元测试：哈希比对成功/失败两条路径
- [ ] `cargo test` / `pnpm build` 通过

**提示词**

```text
项目：Camlib，Tauri 2 + Rust 的相机媒体库。备份模块在 src-tauri/src/backup.rs（2774 行）。

## 问题
备份的完整性校验目前只有文件大小比对（约 1439 行 "复制后文件大小校验失败" 与 1905 行 metadata.len() == expected_size）。USB 传输偶发静默损坏、存储卡位翻转时，文件大小不变但内容已经损坏，现有实现检测不出来。用户往往在格式化存储卡之后才发现，损失不可逆。

## 任务
增加一个可选的深度校验（按内容比对），默认关闭。

1. 引入流式哈希（先查 src-tauri/Cargo.lock 里是否已有可复用的依赖，没有就加 xxhash-rust）。必须流式分块读取，不允许把整个文件读进内存——这里有 4K 视频要处理。
2. 预览阶段：BackupPreviewDto 增加 deepVerify 字段（默认 false）；执行阶段按该开关决定是否计算源文件与目标文件哈希并比对。
3. 校验失败走现有 CopyError / 错误契约，标记 retryable=true，让用户能重试。
4. 前端：备份预览面板加一个开关和一行说明（"较慢，但能发现传输损坏"）。类型同步到 src/api/media.ts。
5. 性能：开启深度校验时备份速度会下降，请在实现里实测并记录（例如 1GB 文件耗时），把数据写进 commit message。

## 折中方案（如果全量哈希太慢）
允许降级为"校验头部 N MB + 尾部 N MB"，但必须：(a) 在 UI 说明这是抽样校验；(b) 在代码注释里写清为什么抽样。

## 约束
- 默认行为必须与现在完全一致（关闭深度校验时，性能与路径不变）。
- 不放宽源盘只读约束：不修改、不删除相机中的任何文件。
- 临时文件写入 + 原子提交的既有流程不能破坏。
- Schema 如需变更必须新增迁移文件。

## 验收
- 新增单元测试：哈希一致通过、哈希不一致报可重试错误
- 手动验证：人为篡改目标文件一个字节后执行校验，能检测出来
- cargo test、cargo fmt --check、pnpm build 全绿
- 给出深度校验开启前后的吞吐对比数据

建议 commit：feat(backup): 新增可选的内容哈希深度校验
```

---

### S6｜工程化清扫

**目标**：把一批确定性的小债一次清掉，让后续每次发布少踩一次坑。

**为什么可以立刻做**：全部是低风险改动，与任何功能改动零耦合。

**清单**

| 项 | 现状 | 动作 |
| --- | --- | --- |
| 版本号三处 | `package.json`、`Cargo.toml`、`tauri.conf.json` 手改 | `tauri.conf.json` 的 `version` 改为 `"../package.json"`（Tauri CLI 支持读取 package.json 的 version）；`Cargo.toml` 用 `scripts/sync-version.py` 从 package.json 写入 |
| Lint | 前端无 eslint/prettier | 加 eslint + `@typescript-eslint` + prettier，先只做 warn 级，别一次性刷屏 |
| CI | 只有 build/fmt/test/check | 加 `cargo clippy -- -D warnings`（先修存量告警再开卡口）、加 `pnpm test`、排 `pnpm lint` |
| 发布 | 手动打包 | 打 `v*` tag 时跑 `pnpm tauri build` 并上传 NSIS 到 Release |
| 死资源 | `src/assets/{tauri,vite,typescript}.svg` 全项目无引用 | 删除 |
| 忽略项 | `.workbuddy/` 处于未跟踪状态 | 写进 `.gitignore` |
| ffmpeg | 缺失时只有失败提示 | 启动探测一次，缺失时给一行安装引导（"winget install ffmpeg"），已存在则静默使用 |

**验收**
- [ ] 改完 `package.json` 版本号后，`pnpm tauri build` 产出的安装包版本自动跟随
- [ ] `cargo clippy -- -D warnings` 通过
- [ ] CI 全绿且新增步骤可见
- [ ] 仓库根目录不再有未跟踪的临时目录

**提示词**

```text
项目：Camlib，Tauri 2 + 原生 TypeScript。仓库当前 v0.5.0。做一批确定性的工程化清理，全部低风险，与功能改动零耦合。不要顺手重构业务代码。

## 清单
1. 版本号去重
   - tauri.conf.json 的 "version" 改为指向 "../package.json"（Tauri CLI 支持从 package.json 读取版本），先本地 pnpm tauri build 或 tauri info 验证能正确读到。
   - 新增 scripts/sync-version.py：读 package.json 的 version，写入 src-tauri/Cargo.toml 的 [package] version 字段。要求幂等、只替换那一行，不整文件重写。
   - 不引入额外运行时依赖。

2. 前端 lint
   - 加 eslint + @typescript-eslint + prettier 配置。
   - 第一版全部保持 warn 级（关键规则可开 error：no-unused-vars、no-explicit-any），避免一次性刷出几百条报错。
   - package.json 加 "lint": "eslint src --max-warnings 0"（若存量告警太多，先不加 max-warnings，并在 commit message 记录存量数量）。

3. CI（.github/workflows/ci.yml）
   - 在 cargo check 之后增加 cargo clippy --all-targets -- -D warnings（若存量告警阻塞，先跑 clippy 不卡口，把存量告警数量写进 commit message）。
   - 增加 pnpm test（若无测试脚本则跳过，但要说明）。
   - 增加 pnpm lint。
   - 新增 release.yml：打 v* tag 时在 windows-latest 上跑 pnpm tauri build，把 NSIS 安装包上传到 GitHub Release。

4. 清理
   - 删除 src/assets/tauri.svg、typescript.svg、vite.svg（全项目无引用，删前再 grep 确认一次）。
   - .gitignore 增加 .workbuddy/ 与 .zcode/。
   - ffmpeg 探测：在合适的启动时机（不要阻塞首屏）检查 ffmpeg 是否存在，缺失时在视频缩略图相关 UI 上给一行引导文案，包含 "winget install ffmpeg"。已存在则静默，不要每次启动都提示。

## 约束
- 不改任何业务逻辑、不改错误契约、不放宽安全配置。
- 每个子项独立可回滚；如果一个子项卡住，跳过它并说明，不要拖累其他项。
- 不新增运行时依赖（devDependency 可以）。

## 验收
- pnpm build、pnpm test、cargo test、cargo fmt --check、cargo clippy --all-targets -- -D warnings 全绿
- 修改 package.json 版本号后，构建产物版本跟随
- CI 配置语法正确（可用 act 或推送分支验证）

建议 commit（拆成多个）：
chore(release): 版本号收敛到 package.json
chore(lint): 引入 eslint 与 prettier
chore(ci): 补 clippy、前端测试与 tag 自动发布
chore: 清理未引用资源与忽略目录
```

---

### S7｜Rust 模块拆分（可选，最后做）

**目标**：`db/mod.rs`（3974 行）按实体拆，`lib.rs`（2025 行、73 个 command 集中注册）按域拆。

**为什么最后做**：纯结构调整，不产生用户可见收益，但会同时改动大量文件。**必须先有 S1/S2 的测试兜底**，否则一次拆分出问题很难定位。

**涉及文件**：`src-tauri/src/db/mod.rs`、`src-tauri/src/lib.rs`

**改动要点**
1. `db/` 拆成 `mod.rs`（连接、迁移、Repository 骨架）+ `queries/media.rs` / `tags.rs` / `backup.rs` / `ai.rs`，测试跟着各自模块走。
2. `lib.rs` 拆成 `commands/` 目录（`media.rs` / `backup.rs` / `ai.rs` / `settings.rs` / `system.rs`），`lib.rs` 只保留 `run()`、状态定义和 `generate_handler!`。
3. **纯搬移**：不改逻辑、不改签名、不改测试断言。

**验收**
- [ ] `cargo test` 数量不减（112 个），全绿
- [ ] `cargo clippy` 无新告警
- [ ] 每个文件 ≤ 800 行
- [ ] `git log --stat` 显示改动是搬移（增删行数大致相当）

**提示词**

```text
项目：Camlib，Tauri 2 + Rust。当前 src-tauri/src/db/mod.rs 有 3974 行，src-tauri/src/lib.rs 有 2025 行且集中注册了 73 个 Tauri command。本会话只做文件拆分，不改任何逻辑。

## 任务
1. db 模块拆分
   src-tauri/src/db/ 拆为：
   - mod.rs：连接管理、迁移执行、Repository 结构体骨架、公共类型导出
   - queries/media.rs、queries/tags.rs、queries/backup.rs、queries/ai.rs：按实体归置查询实现
   现有的 #[cfg(test)] mod tests 按归属拆到各自模块，不要丢掉任何一条。
2. lib.rs 拆分
   新增 src-tauri/src/commands/ 目录：media.rs、backup.rs、ai.rs、settings.rs、system.rs。
   把 #[tauri::command] 函数原样搬过去，lib.rs 只保留 run()、状态类型定义、错误转换和 generate_handler! 列表。
   注意：Tauri 的 generate_handler! 需要命令路径正确（commands::media::list_media 形式），搬完确认能编译。

## 硬约束
- 纯搬移：不改函数签名、不改逻辑、不改测试断言、不改 Command 名称。
- 每次搬移一个模块就编译一次（cargo check），不要全部搬完再编译。
- 不新增依赖、不调整 public API。
- 不放宽错误契约或安全校验。

## 验收
- cargo test 通过且测试数量不低于 112
- cargo fmt --check、cargo clippy --all-targets -- -D warnings 通过
- 拆分后单文件不超过 800 行
- 给出拆分前后的文件行数对照表

建议 commit：refactor(rust): 按实体拆分 db 与 commands 模块
```

---

## 4. 进度追踪

| 会话 | 状态 | 完成日期 | commit |
| --- | --- | --- | --- |
| S1 AI 线程模型 | ☑ 完成 | 2026-11-11 | `391f662` fix(ai): 网络命令移出命令线程并补齐超时 |
| S2 前端测试基座 | ☑ 完成 | 2026-11-11 | `442e3d2` test(frontend): 建立 vitest 基座并抽取纯函数 |
| S3a 事件委托 | ☑ 完成 | 2026-11-11 | `205568c` refactor(frontend): 卡片区与工具栏改用事件委托 |
| S3b 分区增量渲染 | ☑ 完成 | 2026-11-11 | `bcb02c8` refactor(frontend): render() 改为骨架 + 分区增量更新 |
| S4 虚拟滚动 | ☑ 完成 | 2026-11-11 | `99ab023` perf(frontend): 媒体网格改用固定行高虚拟滚动 |
| S5 备份深度校验 | ☑ 完成 | 2026-11-11 | `c9fa08c` feat(backup): 新增可选的内容哈希深度校验 |
| S6 工程化清扫 | ◐ 基本完成 | 2026-11-11 | `80195c5` `cbf6da5` `1148415` `01e821c` `010b7d4` `fb187f7` `d50ef16`（clippy 债未清完，见第 7 节） |
| S7 Rust 模块拆分 | ☑ 完成 | 2026-11-11 | `2a459cd` refactor(rust): 按实体拆分 db 与 commands 模块 |

---

## 5. 风险与回滚

| 会话 | 主要风险 | 缓解 | 回滚 |
| --- | --- | --- | --- |
| S1 | `State` 跨 `await` 导致编译失败或死锁 | 严格按"先取值再 move 进闭包"改写；`ai_chat` 是现成范本 | 单 commit revert，前端零改动 |
| S2 | 搬移时无意改变格式化输出 | 测试逐字比对输出字符串；先写测试再搬 | 单 commit revert |
| S3a | 委托遗漏某个 preventDefault 分支 | 改前列行为清单，改后逐条对照 | 保留原绑定函数空壳，可快速恢复 |
| S3b | 分区 patch 漏更新某块 UI，出现"数据变了界面没变" | 允许中间态合入；设置面板等低频区先继续全量 | 保留 `render()` 全量路径作为 fallback 开关 |
| S4 | 虚拟滚动与缩略图观察器互相干扰 | 先在 5000 条测试库验证，再接真实库 | 单 commit revert |
| S5 | 大文件哈希拖慢备份 | 默认关闭；必要时降级为抽样校验 | 开关默认 false，revert 影响面小 |
| S6 | clippy 存量告警过多阻塞 CI | 先统计存量、只记录不卡口，再分批修 | 各子项独立 commit |
| S7 | 拆分引入隐蔽的模块可见性错误 | 纯搬移 + 每模块编译一次 + 测试数不减 | 单 commit revert |

---

## 6. 明确不在本轮范围

写下来是为了防止范围蔓延，这些问题另开 Issue：

- 引入 UI 框架（Preact/Solid 重写渲染层）——先做 S3b，看增量更新是否已够用
- macOS / Linux 支持与跨平台 CI
- 代码签名与自动更新（当前 README 已声明不做）
- 云同步、RAW 编辑、移动端
- 视频打标（README 已标注为后续增强）
- `facet` / `count` 聚合的缓存优化——需要真实大库的性能数据支撑，先测再做

---

## 7. 执行复核（2026-11-12）

> 本节的 5 个遗留项已归并成第二轮 4 个会话，见 [`optimization-plan-round2.md`](optimization-plan-round2.md)。

八个会话已全部执行完毕，本地实测结果如下。

### 通过项

| 项 | 结果 |
| --- | --- |
| 前端测试 | 5 个文件 / **63 个测试全绿**（format 20、virtual 17、filters 13、selection 8、grid 5） |
| 后端测试 | **116 passed / 1 ignored**（原 112，净增 4） |
| `pnpm build` | 通过，产物 260 KB JS / 122 KB CSS（gzip 75 KB / 22 KB） |
| `pnpm lint` | 0 error / 5 warning |
| `cargo fmt --check` | 通过 |
| S1 超时 | `.timeout_connect(15s)` + `.timeout_read(60s)` + `.timeout(120s)` 三项均已落地，并在注释里说明了 ureq 的优先级语义 |
| S2 行数 | 该 commit 内 `main.ts` 净减 120 行，符合"只减不增" |
| S3b 硬指标 | `previousScrollTop` / `previousScrollLeft` / `tagPopoverScroll` **三处补偿代码已删除**；`render()` 调用点 109 → 64 |
| S4 真实度 | 按天分组复用 section + `patchCardList` 复用卡片 + 上下 spacer 撑高，非伪虚拟化；连 1/64px 轨道宽误差都做了处理 |
| S7 拆分 | `lib.rs` 2025 → **165 行**；`db/mod.rs` 3974 → **437 行**；`queries/` 按实体拆成 6 个文件，单文件均 ≤ 700 行 |
| 类型质量 | 全项目 `any` 数量仍为 **0** |

### 遗留项（建议下一轮处理，按优先级）

| # | 遗留 | 现状 | 建议 |
| --- | --- | --- | --- |
| 1 | **clippy 59 个错误未清** | `cargo clippy --all-targets -- -D warnings` 失败；CI 用 `continue-on-error: true` 兜住（S6 允许的降级路径） | 大头是 18 个 `useless vec!`（多在测试里）+ 14 个 `too many arguments`。前者 `cargo clippy --fix --all-targets` 可批量自动修；后者集中在 `library_merge.rs`(15) 与 `backup.rs`(15) 两个存量文件，建议引入 `#[allow(clippy::too_many_arguments)]` 显式豁免而非硬拆参数（拆了反而伤可读性）。清完删掉 `continue-on-error` 即变硬卡口 |
| 2 | **版本号仍是 0.5.0** | 本轮含 2 个 `feat`（深度校验、ffmpeg 探测）+ 1 个 `perf` + 新增 migration 0008（schema 8） | 按仓库自己的 SemVer 约定应走 **MINOR → 0.6.0**；`package.json` 一处改动即可（`tauri.conf.json` 已指向它） |
| 3 | **CHANGELOG 未记全** | `[Unreleased]` 只有备份深度校验一条 | 补记：虚拟滚动、事件委托 + 分区增量渲染、ffmpeg 启动探测、Rust 模块拆分 |
| 4 | **`main.ts` 仍 8441 行**（原 7482） | 不是违规（S2 单 commit 净减），但 S3b/S4 的新实现又堆回单文件 | 下一轮把 `renderShell` / `patch*` / 虚拟滚动（约 1400 行）移到 `src/render/`，`main.ts` 只留状态与装配 |
| 5 | **3 处 `no-unsafe-finally`** | `main.ts` 的批量收藏/标签/评分三个函数在 `finally` 里 `return` | 非确定 bug（函数返回 void），但 ESLint 明确禁止该模式；改为"置标志位 → finally 外分支"更稳 |
