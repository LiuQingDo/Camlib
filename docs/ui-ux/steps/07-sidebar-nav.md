# 步骤 07 · 侧栏导航重构 + 回收站 + 首启引导

| 项           | 内容                                                                                                                                                                                    |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 阶段         | P1（信息架构）                                                                                                                                                                          |
| 覆盖诊断编号 | 1.5 / 1.6 / 1.7 / 1.8 / 1.9                                                                                                                                                             |
| 依赖         | `03 备份出主区`（侧栏「导入」入口在那里落地）                                                                                                                                           |
| 预估         | 2 个半场（A：侧栏与日期树；B：回收站，含一条新 command）                                                                                                                                |
| 主要文件     | `src/render/shell.ts`、`src/app/bindings/shell.ts`、`src/state.ts`、`src/views/settings.ts`（入口收敛）、`src-tauri/src/lib.rs`、`src-tauri/src/db/queries/deletion.rs`、`src/api/*.ts` |

> 本步拆成两个半场，**分别开两个会话**。A 是纯前端且收益立竿见影；B 要动 Rust，单独做便于回滚。

---

## 1. 目标

### A 半场（前端）

侧栏从「5 类内容混在一起」收敛为**一条导航 + 一块日期浏览 + 一条页脚**：

| 区域     | 内容                                                       |
| -------- | ---------------------------------------------------------- |
| 品牌行   | Camlib + 设置（**唯一**入口）                              |
| 主导航   | 全部媒体 / 最近导入 / 收藏 / 已删除 / 标签 / **导入照片…** |
| 日期浏览 | 年 → 月两级；整行点击 = 选中并展开；箭头只作状态指示       |
| AI       | 一条「AI 助手」入口（统计数字可在其右侧小字，不再占三行）  |
| 页脚     | 库状态 + 启动扫描开关 + 扫描 + 主题                        |

同时补三件事：未配置时「添加媒体库」卡片真的能点、首启三步引导、空态说明数据在哪。

### B 半场（含后端）

侧栏「已删除」给出只读列表：最近删除的媒体、删除时间、原始路径，动作「在资源管理器中打开」。

> **明确不做的**：应用内「还原」。还原需要「从回收站还原文件 + 复原索引状态」，当前后端没有这个能力，做一个假的"撤销"按钮比没有更糟。列表 + 说明 + 系统回收站入口，已经解决"我删了哪些、心里没底"。

---

## 2. 现状与证据（v0.6.0 已核实）

- `src/render/shell.ts:82` `SHELL_HTML` 的侧栏结构：`brand`（含 `#settings-button-top`）→ `sidebar-library` → `date-section` → `sidebar-ai` → `sidebar-footer`（含 `#settings-button`、`#theme-toggle`、`#scan-button`、启动扫描开关）。
- 设置入口 2 个（`#settings-button-top`、`#settings-button`）；AI 入口 3 处在侧栏（`renderAiSidebarSection`）+ 1 处在设置。
- `src/render/shell.ts:10` `renderDateNavigation()`：年/月各有一个 `tree-toggle` 按钮 + 一个 `date-link` 按钮，两个独立热点；第三级 `day-link` 存在。
- `src/render/shell.ts:80` 未配置分支：`<div class="library-entry is-empty">...添加媒体库...</div>`——**没有 id、没有点击绑定**，样式像按钮但不可点。
- 空态：`src/views/dialogs.ts:452` 只给「点击右上角"扫描媒体库"开始建立索引」，不解释数据存哪、扫描大概多久。
- 后端：`deletion_logs` 表存在（`0003`），字段 `media_item_id / media_file_id / relative_path / action / status / created_at`；`record_deletion_log` 写入；**没有 list 命令**，前端 `src/api/` 也没有对应封装。
- `media_items.scan_state` 只有 `present / missing / ambiguous / error`，**没有 deleted 标记**——所以「已删除」只能从 `deletion_logs` 推导。

---

## 3. 改动清单

### A 半场

| #   | 文件                        | 位置                      | 改什么                                                                                                                                                              |
| --- | --------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `src/render/shell.ts`       | `SHELL_HTML`              | 侧栏改为「brand / nav / dates / ai / footer」五段；brand 只留一个设置按钮；footer 删除设置按钮                                                                      |
| 2   | 同上                        | 新增 `renderSidebarNav()` | 6 个导航项，`data-nav="all\|recent\|favorites\|deleted\|tags\|import"`；当前项 `aria-current="page"`                                                                |
| 3   | 同上                        | `renderDateNavigation`    | 去掉 `tree-toggle` 按钮：整行 `<button class="date-row">` 点击 = 选中 + 展开；`▸/▾` 改为行内 `<span aria-hidden>` 状态图标；删除日级 `day-link`                     |
| 4   | `src/app/bindings/shell.ts` | `bindSidebarEvents`       | `[data-nav]` 统一分派：all→`clearAllFilters`；recent→`firstSeenFrom`；favorites→`favoriteOnly`；deleted→打开回收站视图；tags→打开标签管理；import→`openBackupPanel` |
| 5   | `src/render/shell.ts`       | `sidebarLibraryHtml`      | 未配置时整卡可点：加 `id="choose-folder-button"` 或 `data-nav="import"`；与空态主按钮共用同一处理函数                                                               |
| 6   | `src/render/shell.ts`       | `sidebarFooterHtml`       | 删除 `#settings-button`；保留状态、启动扫描、扫描、主题；设置只在 brand                                                                                             |
| 7   | `src/views/ai-chat.ts`      | `renderAiSidebarSection`  | 收敛为一行「AI 助手」入口 + 右侧未处理计数；删除三行入口列表                                                                                                        |
| 8   | `src/views/dialogs.ts`      | 空态                      | 未配置时渲染三步引导卡：① 选择文件夹 ② 开始扫描（可跳过后手动） ③ 完成后看新增/更新/缺失；附一句「索引存在 SSD，原始照片始终留在你的媒体盘」                        |
| 9   | `src/styles.css`            | 追加                      | `.sidebar-nav`（行高 34、图标 + 文案 + 计数）、`.date-row`（整行 hover、箭头 12px）、`.first-run` 三步卡                                                            |

### B 半场

| #   | 文件                                               | 位置                 | 改什么                                                                                                                                                                                                                                              |
| --- | -------------------------------------------------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 10  | `src-tauri/src/db/queries/deletion.rs`             | 新增                 | `list_deleted_items(library_id, limit, offset)`：从 `deletion_logs` 取每个 `media_item_id` 最新一条 `action='recycle' AND status='completed'`，join `media_items` 拿名称/类型/拍摄日期，join `media_files` 拿 `relative_path`；按 `created_at DESC` |
| 11  | `src-tauri/src/lib.rs`                             | `invoke_handler`     | 注册 `list_deleted_items`，返回 `{ items, total }` DTO（字段与 `MediaItemDto` 保持同名风格）                                                                                                                                                        |
| 12  | `src/api/media.ts`（或新建 `src/api/deletion.ts`） | —                    | 前端封装 + 类型 `DeletedItemDto { id, displayName, kind, captureDate, relativePath, deletedAt }`                                                                                                                                                    |
| 13  | `src/views/dialogs.ts` 或新 `src/views/deleted.ts` | —                    | 只读列表视图：表格式行（缩略图、名称、删除时间、路径）+ 「在资源管理器中打开」（复用现有 opener）+ 顶部说明「文件在 Windows 回收站，可随时从系统还原」                                                                                              |
| 14  | `src/app/bindings/shell.ts`                        | `data-nav="deleted"` | 打开该视图（用 overlay 或内容区切换，建议 overlay，避免污染浏览状态）                                                                                                                                                                               |

---

## 4. 实现要点

1. **一次只改一层。** A 半场不要动 B 的视图；B 半场不要重排侧栏。两边共用 `data-nav`，先由 A 定义好 key。
2. **日期树的"整行点击"要保住选中态。** 现在"选中"与"展开"是两个独立热点，合并后：点击行 = 若未选中则选中并展开；若已选中则仅切换展开。这样不会出现"点了一下反而取消筛选"。
3. **日级入口删除后要能到达。** 网格已有 `.day-heading` 按日分组，用户在内容区可按日定位；侧栏不再需要第三级。
4. **导航项与筛选状态的关系**：导航项本质是"预设筛选"（收藏 = `favoriteOnly`；最近导入 = `firstSeenFrom`）。点击时应**清掉其他筛选**，避免"点了收藏却仍带着标签"的歧义。这一点与 `02` 的"可叠加"不矛盾：叠加发生在 chip 之间，导航是重置入口。
5. **回收站排序与分页**：先做最近 100 条，不分页；列表底部一句「只显示最近 100 条删除记录」。个人库场景足够，别一上来做虚拟滚动。
6. **回收站命令的 SQL 注意**：`deletion_logs` 一个媒体可能有多次删除（删除→重扫→再删除），用 `ROW_NUMBER() OVER (PARTITION BY media_item_id ORDER BY created_at DESC)` 取最新（SQLite 3.35+ 支持窗口函数，项目已用 3.35+）。`total` 用同条件的 `COUNT(DISTINCT media_item_id)`。
7. **不改删除本身的行为**：不新增"永久删除"，不加"一键清空回收站"（那是系统的事）。
8. **首启引导不要做成遮罩教程**：就用空态里的一张卡，三步各一行 + 一个主按钮，做完即消失。避免新手引导的"下一步"疲劳。

---

## 5. 验收标准

### A

- [ ] 侧栏从上到下：品牌（1 个设置入口）→ 6 个导航项 → 日期（年/月两级）→ AI 助手（1 行）→ 页脚（状态/扫描/主题）。
- [ ] 全应用只有 1 个设置入口、1 个 AI 入口。
- [ ] 日期树点整行：选中并展开；再点：仅折叠；箭头不再单独响应点击。
- [ ] 日期树只剩年/月两级，日级入口消失，且不影响按日筛选（网格 `.day-heading` 仍在）。
- [ ] 未配置媒体库时，侧栏「添加媒体库」卡片可点击，与空态主按钮行为一致。
- [ ] 首启空态显示三步引导与"数据在哪"说明。
- [ ] `≤900px` 时侧栏不挤压内容区（允许收为图标栏，或与 `12` 一并处理）。

### B

- [ ] 侧栏「已删除」打开只读列表，按删除时间倒序，显示名称/类型/时间/路径。
- [ ] 每行「在资源管理器中打开」可用（文件已不存在时给出明确提示，不静默失败）。
- [ ] 列表顶部说明「文件在 Windows 回收站，可从系统回收站还原」。
- [ ] `cargo test` / `cargo clippy` / `pnpm test` / `pnpm lint` / `pnpm build` 全绿。
- [ ] 新增 Rust 测试：同一条目多次删除只出现一次、只统计 `completed` + `recycle`。

---

## 6. 自包含提示词

### 提示词 A（侧栏导航 + 日期树 + 首启引导，纯前端）

```text
你是 Camlib 项目的前端工程师。项目在 D:\code-collect\camlib：
Tauri 2 + Vite + 原生 TypeScript（strict，禁止 any）+ Rust + SQLite，Windows 优先的本地相机媒体库。
侧栏骨架在 src/render/shell.ts 的 SHELL_HTML，patch 由 patchSidebar() 做增量替换。

## 任务
把侧栏从「品牌+库卡+日期树+AI 统计+页脚五类混排」收敛为一条导航，日期树降为两级并整行可点，补首启引导。

## 已核实的现状
1. src/render/shell.ts 的 SHELL_HTML 侧栏结构：brand（含 #settings-button-top）→ [data-region="sidebar-library"] → .date-section → [data-region="sidebar-ai"] → .sidebar-footer（含 #settings-button、#scan-button、#theme-toggle、启动扫描开关）。
2. 设置入口 2 个（#settings-button-top、#settings-button）；AI 入口 3 处在 renderAiSidebarSection（src/views/ai-chat.ts）+ 设置里 1 处。
3. renderDateNavigation()（约 10 行）年/月各有两个独立热点：.tree-toggle（▸/▾）+ .date-link；还有第三级 day-link。
4. 未配置分支 sidebarLibraryHtml()（约 80 行）渲染 <div class="library-entry is-empty">…添加媒体库…</div>，没有 id、没有点击绑定。
5. 空态在 src/views/dialogs.ts 约 452 行，只说「点击右上角"扫描媒体库"开始建立索引」。

## 要做的事
1. 重排侧栏为五段：brand（只留一个设置按钮）/ 新增 [data-region="sidebar-nav"] / 日期 / AI / 页脚。
2. 新增 renderSidebarNav()：全部媒体、最近导入、收藏、已删除、标签、导入照片…，带 data-nav="all|recent|favorites|deleted|tags|import"，当前项 aria-current="page"；每项可带右侧计数（收藏数/已删除数可先留空）。
3. 日期树：去掉 .tree-toggle 按钮，整行改为一个 <button class="date-row">，点击 = 未选中则选中并展开、已选中则仅切换展开；▸/▾ 改为行内 aria-hidden 的状态图标；删除第三级 day-link（年/月两级）。
4. bindSidebarEvents（src/app/bindings/shell.ts）里统一处理 [data-nav]：all→clearAllFilters；recent→state.firstSeenFrom 设为最近 7 天并刷新；favorites→favoriteOnly=true 并清其他筛选；deleted→暂留 TODO（由后续半场实现，本步可先禁用并加 tooltip「即将支持」）；tags→打开标签管理；import→openBackupPanel。
5. sidebarLibraryHtml 未配置分支：给整卡加 id="choose-folder-button" 或 data-nav="import"，与空态主按钮共用同一处理函数。
6. sidebarFooterHtml：删除 #settings-button，只保留状态、启动扫描、扫描、主题。
7. src/views/ai-chat.ts 的 renderAiSidebarSection 收敛为一行「AI 助手」+ 未处理计数，删除三行入口列表。
8. 首启空态（src/views/dialogs.ts）：渲染三步引导卡（① 选择文件夹 ② 开始扫描，可跳过后手动 ③ 完成后看新增/更新/缺失），并加一句「索引存在 SSD，原始照片始终留在媒体盘」。
9. src/styles.css 增加 .sidebar-nav / .date-row / .first-run 样式，沿用现有 token；行高与字阶和其它侧栏项一致。

## 约束
- 不改 Rust；不改备份、扫描、删除的业务逻辑。
- 导航项本质是预设筛选：点击时重置其它筛选（与筛选 chip 的叠加语义不冲突）。
- 不碰虚拟滚动、卡片节点池、缩略图队列；不改 toolbar 结构。
- 不引入依赖；TS strict，禁止 any；文案中文。

## 验收
- 侧栏结构与入口数量符合要求（设置 1 个、AI 1 个）。
- 日期树整行可点，选中/展开行为符合描述，只剩两级。
- 未配置时库卡可点；首启有三步引导。
- 各导航项切换后筛选状态正确、无叠加残留。
- pnpm test / pnpm lint / pnpm build 全绿。

## 交付方式
先给改动清单（文件 + 函数），再改代码；最后报告三绿结果与逐项手动验证步骤。
```

### 提示词 B（回收站只读列表，含一条新 command）

```text
你是 Camlib 项目的全栈工程师。项目在 D:\code-collect\camlib：
Tauri 2 + Vite + 原生 TypeScript（strict，禁止 any）+ Rust + SQLite。Command 注册在 src-tauri/src/lib.rs 的 invoke_handler，
前端封装在 src/api/，错误契约是 { code, message, retryable, details }（src-tauri/src/errors.rs / src/api/errors.ts）。

## 任务
给侧栏「已删除」提供一个只读列表：最近从 Camlib 删除的媒体、删除时间、原始相对路径，可「在资源管理器中打开」。

## 已核实的现状
1. 表 deletion_logs（src-tauri/src/db/migrations/0003_deletion_logs.sql）：id / media_item_id / media_file_id / relative_path / action('recycle'|'already_missing'|'rejected') / status('completed'|'failed'|'skipped') / error_message / created_at；索引 idx_deletion_logs_item_created(media_item_id, created_at DESC)。
2. 写入在 src-tauri/src/db/queries/deletion.rs 的 record_deletion_log()；只有写入，没有读取列表的命令。
3. media_items 没有 deleted 标记，scan_state 只有 present/missing/ambiguous/error，所以「已删除」只能从 deletion_logs 推导。
4. 前端 src/api/ 里没有删除记录相关的封装。
5. 侧栏导航项 data-nav="deleted" 已在步骤 07A 预留。

## 要做的事
1. src-tauri/src/db/queries/deletion.rs 新增 list_deleted_items(library_id, limit, offset)：
   - 用窗口函数 ROW_NUMBER() OVER (PARTITION BY media_item_id ORDER BY created_at DESC) 取每个媒体最新一条；
   - 只保留 action='recycle' AND status='completed'；
   - join media_items 取 display_name / kind / capture_date，join media_files 取 relative_path；
   - 按 created_at DESC 排序，limit 默认 100；
   - 返回 items + total（total = COUNT(DISTINCT media_item_id)，同过滤条件）。
2. src-tauri/src/lib.rs 注册 command list_deleted_items，DTO 字段 camelCase，风格与现有 MediaItemDto 一致。
3. src/api/ 新增封装与类型 DeletedItemDto { id, displayName, kind, captureDate, relativePath, deletedAt }。
4. 新增只读列表视图（建议 overlay：src/views/deleted.ts + #overlay-host 新槽位）：表格式行含缩略图占位、名称、删除时间、相对路径；每行「在资源管理器中打开」（复用现有 opener 能力，文件不存在时给出明确提示，不静默失败）；顶部说明「文件在 Windows 回收站，可从系统回收站还原」；底部「只显示最近 100 条删除记录」。
5. 侧栏 data-nav="deleted" 打开该视图；关闭走现有 overlay 退场动画；接入步骤 05 的焦点陷阱（若已有）。

## 约束
- 不实现「应用内还原」：没有对应后端能力，不要伪造撤销按钮。
- 不新增删除相关行为（不加速永久删除、不做清空回收站）。
- 不改现有 record_deletion_log 写入逻辑。
- SQL 参数化；不改 schema，不加迁移。
- Rust 需通过 cargo fmt / clippy / test；前端 TS strict、禁止 any；文案中文。

## 验收
- 同一媒体多次删除只出现一行（取最新）。
- 只统计 completed + recycle；failed / already_missing 不出现。
- 排序为删除时间倒序；列表为空时给友好空态。
- 「在资源管理器中打开」对已不存在的文件给出明确提示。
- cargo test / cargo clippy / pnpm test / pnpm lint / pnpm build 全绿，并补一条 Rust 测试覆盖「多次删除去重 + 过滤条件」。

## 交付方式
先给改动清单（Rust command + SQL + 前端文件），再改代码；最后报告测试结果与手动验证步骤。
```

---

## 7. 风险与回滚

| 风险                                 | 表现                   | 处理                                                                                                              |
| ------------------------------------ | ---------------------- | ----------------------------------------------------------------------------------------------------------------- |
| 日期树去掉日级后用户找不到某天       | 抱怨"以前能点日"       | 内容区 `.day-heading` 保留按日分组；搜索/筛选仍可定位到日；若真需要，后续在月展开里加"日"折叠而不是恢复侧栏第三级 |
| 导航项重置筛选出乎意料               | 用户以为会叠加         | 导航项点击后主行 chips 立即反映"只剩这一个条件"，视觉上自解释                                                     |
| 回收站命令与删除状态不一致           | 列表有记录但文件已不在 | 这是真实状态，如实显示「文件已不在原位置」而不是隐藏                                                              |
| 两个半场并行改动 `bindSidebarEvents` | 冲突                   | B 半场只加一个分支；建议 A 先合                                                                                   |
| 回滚                                 | 低                     | A 纯前端可整体回滚；B 的新 command 独立，删注册即可                                                               |
