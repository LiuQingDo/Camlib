# 步骤 01 · 反馈三通道

| 项           | 内容                                                                                                                        |
| ------------ | --------------------------------------------------------------------------------------------------------------------------- |
| 阶段         | P0（止血）                                                                                                                  |
| 覆盖诊断编号 | 5.2 / 10.1 / 10.2 / 10.3 / 10.5（并把 8.4 的「完成后入口」变成可能）                                                        |
| 依赖         | 无。本步是全路线地基，`03 / 04 / 05 / 08 / 09 / 10` 都会复用这里产出的 API                                                  |
| 预估         | 1 个会话                                                                                                                    |
| 主要文件     | `src/app/ui.ts`、`src/render/toolbar.ts`、`src/render/shell.ts`、`src/state.ts`、`src/styles.css`、`src/app/orchestrate.ts` |

---

## 1. 目标

把「一条 if-else 横幅槽位」拆成三条互不抢占的通道：

| 通道                     | 位置                                                | 生命周期                                                                   | 承载                                                |
| ------------------------ | --------------------------------------------------- | -------------------------------------------------------------------------- | --------------------------------------------------- |
| **错误条** `error-bar`   | 内容区顶部，`.topbar` 之下、`.sticky-controls` 之上 | 常驻，手动关闭；多条纵向堆叠（最多 3 条 + 「还有 N 条」）                  | 索引损坏、盘断开、路径无效、操作失败                |
| **任务胶囊** `task-pill` | 顶栏右侧（`.top-actions` 内），**不随内容滚动**     | 任务存在期间常驻；可展开明细、可取消、可「后台继续」                       | 扫描、备份、删除、缩略图重建、AI 批量打标、视频合并 |
| **结果 toast**           | `position: fixed` 右下角，挂 `body` 级容器          | 成功 4s 自动消失、失败常驻；最多 3 条排队，可带一个动作按钮（撤销 / 查看） | 批量收藏、标签、评分、删除结果、备份完成            |

做完之后：滚到网格第 20 屏批量收藏，提示仍在视野里；扫描进行中同时能看到「索引损坏」；删 30 张有 2 张失败时，失败清单可展开且带「重试」入口。

---

## 2. 现状与证据（v0.6.0 已核实）

- `src/render/toolbar.ts:315` `renderStatusBannerBase()` 是一条 if-else 链，优先级为：语义搜索 → 扫描中 → 断盘 → 路径无效 → `state.error` → `state.recentTaskNotice` → `state.ffmpegMissing` → `""`。**同一时刻只能返回一条**，「扫描中」会盖住 `state.error`。
- `src/render/toolbar.ts:376` `renderStatusBanner()` 还在拼接备份面板：`renderStatusBannerBase() + 备份入口 + renderBackupPanel()`。
- `src/render/toolbar.ts:431` `renderDeleteFeedback()` 同样是「进度 → 结果 → 单条通知」的互斥链，结果横幅随文档流滚动。
- `src/app/ui.ts:25` `showTransientNotice()` 把 toast 插到 `.sticky-controls` 的 `afterend`——它随内容一起上移，滚出视口就看不见；`clearTransientNotice()` 只保留**一个**计时器和一个 `#batch-notice` 节点，连续两次操作会互相顶掉。
- `src/render/shell.ts` 的 `SHELL_HTML` 中，`[data-region="status"]` 位于 `.topbar` 与 `.sticky-controls` 之间，是错误条天然的挂载点；`.top-actions` 里目前只有搜索框和扫描按钮，可放任务胶囊。
- `src/state.ts` 现有字段：`error`、`scanning`、`scanProgress`、`deleteProgress`、`deleting`、`deleteResult`、`recentTaskNotice`、`ffmpegMissing`、`semanticSearch`。

---

## 3. 改动清单

| #   | 文件                         | 位置                                            | 改什么                                                                                                                                                                                                                                                            |
| --- | ---------------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `src/app/notices.ts`（新建） | —                                               | 通知注册表：`pushNotice / dismissNotice / listNotices`，类型 `{ id, kind: "error"\|"warning"\|"info"\|"success", title, detail?, actions?, sticky? }`，最多保留 3 条 + 溢出计数                                                                                   |
| 2   | `src/app/tasks.ts`（新建）   | —                                               | 任务模型：`upsertTask({id,title,detail?,done?,total?,cancel?})`、`finishTask(id)`、`listTasks()`；只存数据，不碰 DOM                                                                                                                                              |
| 3   | `src/app/toast.ts`（新建）   | —                                               | `showToast(message, {kind, action?:{label,run}, timeout?})`；队列最多 3 条；同 key 合并（避免「已收藏」刷屏）                                                                                                                                                     |
| 4   | `src/render/shell.ts`        | `SHELL_HTML`                                    | `[data-region="status"]` 拆成 `[data-region="error-bar"]` + `[data-region="task-pill"]`（胶囊放进 `.top-actions` 最左）；body 末尾加 `<div id="toast-host" aria-live="polite"></div>`                                                                             |
| 5   | `src/render/toolbar.ts`      | `renderStatusBannerBase` / `renderStatusBanner` | 拆成三个渲染函数：`renderErrorBar()`（读 notice 注册表，只渲染 error/warning/info 类**非任务**通知）、`renderTaskPill()`（读 task 注册表）、删除旧的互斥链；`renderStatusBanner()` 只保留语义搜索的「当前检索条件」条（它是查询状态不是通知），并移除备份面板拼接 |
| 6   | `src/render/toolbar.ts`      | `renderDeleteFeedback`                          | 删除进度并入 task 注册表（id 固定 `delete`）；结果并入 toast（成功 4s，失败常驻 + 「查看 N 条失败」展开 + 「重试」动作）                                                                                                                                          |
| 7   | `src/app/ui.ts`              | `showTransientNotice`                           | 改为 `showToast` 的薄封装（保留旧签名，避免一次性改所有调用点），内部不再操作 `.sticky-controls`                                                                                                                                                                  |
| 8   | `src/styles.css`             | 追加区块                                        | `.error-bar` / `.task-pill` / `#toast-host` / `.toast` 样式；定义 z-index 阶梯变量 `--z-toast: 90`、`--z-overlay: 100`、`--z-modal: 110`，替换散落的 `z-index: 999`                                                                                               |
| 9   | `src/app/orchestrate.ts`     | `patch*` 编排                                   | 新增 `patchErrorBar()` / `patchTaskPill()`；toast 不走 patch（自己管理 DOM）                                                                                                                                                                                      |

---

## 4. 实现要点

1. **三条通道的数据源必须分离。** 错误条读「通知注册表」，胶囊读「任务注册表」，toast 读自己的队列。判断标准：任何一处新增提示时，只需要决定「这是错误 / 任务 / 结果」，不需要考虑「会不会顶掉谁」。
2. **扫描进度不要塞进 toast。** 它是长任务，进胶囊；胶囊收起时只显示 `扫描中 42%`，展开后显示当前文件、已处理/总数、取消按钮。
3. **胶囊的取消语义。** `cancel` 是可选回调；没有取消能力的任务（如缩略图后台补全）不显示取消按钮，避免假按钮。
4. **删除结果必须「贴脸」。** 失败时 toast 常驻，标题写「已删除 28 项，2 项失败」，body 折叠列出失败原因（复用现有 `result.errors`，最多 12 条 + 溢出计数），动作按钮「重试失败项」。
5. **Undo 先留接口，不急着接。** toast 的 `action` 支持 `{label, run}` 即可；`10.5` 的撤销模型在本步只做「删除」一条链路（回收站可恢复，成本最低），其余（收藏/标签/评分）留给 `08`。
6. **无障碍**：错误条 `role="alert"`，toast 容器 `aria-live="polite"`、错误 toast `role="alert"`；不要给整个 `.media-area` 加 live。
7. **`prefers-reduced-motion`**：toast 入场只做 opacity 过渡，位移用 `translateY(6px)` 且在该媒体查询下归零。

---

## 5. 验收标准

- [ ] 扫描进行中人为触发一次错误（如断开媒体库），**错误条与任务胶囊同时可见**，互不覆盖。
- [ ] 网格滚动到第 10 屏以上，点「批量收藏」，toast 出现在右下角视野内，不需要滚动。
- [ ] 连续执行 4 次操作，toast 依次排队（最多 3 条），不会互相顶掉或叠加计时器。
- [ ] 删除 3 个文件、其中 1 个失败：toast 常驻、显示失败条数、可展开明细、有「重试失败项」。
- [ ] 扫描任务可「收起为胶囊」，收起后内容区恢复可交互。
- [ ] `pnpm test` / `pnpm lint` / `pnpm build` 全绿；新增至少 2 个单测（toast 队列上限与合并、notice 溢出计数）。
- [ ] 不出现 `z-index: 9999`；层级全部走新变量。

---

## 6. 自包含提示词

```text
你是 Camlib 项目的前端工程师。项目在 D:\code-collect\camlib：
Tauri 2 + Vite + 原生 TypeScript（strict，禁止 any）+ Rust + SQLite，Windows 优先的本地相机媒体库。
渲染是「骨架 + data-region 增量 patch」，入口在 src/app/orchestrate.ts，region 工具在 src/render/paint.ts 与 src/render/context.ts。

## 任务
把现在「一条 if-else 横幅」的反馈系统，拆成三条互不抢占的通道：错误条、任务胶囊、结果 toast。

## 已核实的现状
1. src/render/toolbar.ts 的 renderStatusBannerBase()（约 315 行）是 if-else 链，优先级：语义搜索 → 扫描中 → 断盘 → 路径无效 → state.error → state.recentTaskNotice → state.ffmpegMissing。同一时刻只能显示一条，所以「扫描中」会盖住「索引损坏」。
2. 同文件 renderStatusBanner()（约 376 行）= renderStatusBannerBase() + 备份入口按钮 + renderBackupPanel()。
3. 同文件 renderDeleteFeedback()（约 431 行）也是互斥链：删除进度 → 删除结果 → 单条通知，且渲染在内容流里，滚动后不可见。
4. src/app/ui.ts 的 showTransientNotice()（约 25 行）把 toast 插到 .sticky-controls 的 afterend，随内容滚动；全局只有一个计时器和一个 #batch-notice 节点，连续操作会互相顶掉。
5. src/render/shell.ts 的 SHELL_HTML 里，[data-region="status"] 在 .topbar 与 .sticky-controls 之间；.top-actions 内目前只有搜索框与扫描按钮。
6. src/state.ts 已有：error / scanning / scanProgress / deleteProgress / deleting / deleteResult / recentTaskNotice / ffmpegMissing / semanticSearch。

## 要做的事
1. 新建 src/app/notices.ts：通知注册表。类型 { id, kind: "error"|"warning"|"info"|"success", title, detail?, actions?: {label, run}[], sticky?: boolean }；API pushNotice / dismissNotice / listNotices；最多展示 3 条，其余计数为「还有 N 条」。
2. 新建 src/app/tasks.ts：任务注册表。类型 { id, title, detail?, done?, total?, cancel?: () => void }；API upsertTask / finishTask / listTasks。纯数据，不碰 DOM。
3. 新建 src/app/toast.ts：showToast(message, {kind, action?: {label, run}, timeout?, key?})。fixed 右下角，队列上限 3 条，同 key 合并；成功 4s 自动消失，错误常驻并带关闭。
4. 改 src/render/shell.ts 的 SHELL_HTML：
   - [data-region="status"] 拆为 [data-region="error-bar"] 和 [data-region="task-pill"]，胶囊放在 .top-actions 最前；
   - body 末尾加 <div id="toast-host" aria-live="polite"></div>。
5. 改 src/render/toolbar.ts：
   - 新增 renderErrorBar()（读通知注册表，渲染常驻错误/警告条，含关闭按钮）；
   - 新增 renderTaskPill()（读任务注册表，显示「标题 42%」，点击展开明细与取消）；
   - renderStatusBanner() 只保留「AI 搜索当前条件」这一条（它是查询状态，不是通知），并删掉备份面板拼接（备份面板的去留由后续步骤处理，本步只把它从横幅里摘出去，暂时挂回原位置即可，不要删备份功能）；
   - renderDeleteFeedback() 改为：删除进度写入 tasks（id 固定 "delete"），删除结果走 showToast（失败常驻 + 「查看 N 条失败」+ 「重试失败项」动作，复用 existing state.deleteResult.errors）。
6. src/app/ui.ts 的 showTransientNotice 改为 showToast 的薄封装，保留旧签名，内部不再操作 .sticky-controls。
7. src/app/orchestrate.ts 增加 patchErrorBar() / patchTaskPill() 并接进现有 patch 编排。
8. src/styles.css 追加 .error-bar / .task-pill / #toast-host / .toast 样式；定义 --z-toast / --z-overlay / --z-modal 变量，替换新增代码里的裸 z-index；toast 入场用 opacity + 6px 位移，并在 prefers-reduced-motion 下归零位移。

## 约束
- 不改 Rust，不改错误契约 {code,message,retryable,details}。
- 不碰 src/render/virtual.ts、卡片节点池、缩略图队列；不退回全量 innerHTML 重建。
- 不新增运行时依赖。
- 文案中文；错误主文案人话，技术细节进 detail 折叠。
- 删除功能本身不要改行为，只改反馈呈现。

## 验收
- 扫描中触发错误时，错误条与胶囊同时可见。
- 滚到第 10 屏批量收藏，toast 仍在视野内。
- 连续 4 次操作，toast 排队上限 3，不互相顶掉。
- 删除部分失败时，toast 常驻、可展开明细、有重试入口。
- pnpm test / pnpm lint / pnpm build 全绿；补 2 个单测（toast 队列、notice 溢出）。

## 交付方式
先输出「改动清单」（文件 + 函数 + 一句话说明），确认无遗漏后再改代码；最后报告三绿结果、手动验证步骤与遗留问题。
```

---

## 7. 风险与回滚

| 风险               | 表现                              | 处理                                                                                                |
| ------------------ | --------------------------------- | --------------------------------------------------------------------------------------------------- |
| patch 机制冲突     | 胶囊/错误条在扫描时闪烁或丢失焦点 | 只 patch `textContent` 与 `style.width`，不重建外层节点；沿用 `updateScanProgressView()` 的增量思路 |
| 旧调用点漏改       | 某些提示仍插进 `.sticky-controls` | 全局搜 `notice-banner` 与 `#batch-notice`，确认只剩新通道在用                                       |
| toast 遮挡底部操作 | 预览器底栏按钮被压住              | `#toast-host` 预留 `bottom: 72px`，或按 overlay 状态上移                                            |
| 回滚               | 影响面大                          | 本步改动集中在 3 个新文件 + 2 个渲染函数，`git revert` 单个 commit 即可回到旧横幅                   |
