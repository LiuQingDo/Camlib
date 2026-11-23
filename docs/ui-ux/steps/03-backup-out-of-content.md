# 步骤 03 · 备份移出浏览区

| 项           | 内容                                                                                                                                                                 |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 阶段         | P0（结构位移）                                                                                                                                                       |
| 覆盖诊断编号 | 1.1 / 1.2 / 8.4                                                                                                                                                      |
| 依赖         | `01 反馈三通道`（完成态需要一个 toast 动作入口；未做 01 时先用现有横幅兜底）                                                                                         |
| 预估         | 1 个会话                                                                                                                                                             |
| 主要文件     | `src/render/toolbar.ts`、`src/views/backup.ts`、`src/render/shell.ts`、`src/app/library.ts`、`src/app/bindings/shell.ts`、`src/app/orchestrate.ts`、`src/styles.css` |

---

## 1. 目标

备份从「浏览页状态区里的内联面板」变成**独立浮层（右侧全高抽屉）**：

- 打开备份不再把图库推到屏幕外，网格仍在原位，背景可感知（遮罩半透明）。
- 入口从内容区移到侧栏一级项「导入」，文案从「相机备份预览」改为「导入照片…」——不再用"预览"这个词骗人。
- 备份进行中可以关掉抽屉（任务继续），进度由顶栏任务胶囊接管；完成后 toast 给「查看新增 N 张」。
- 关掉抽屉后不会"永远丢掉入口"：`最近导入` 常驻侧栏（本步先加一个侧栏入口，列表留到 `07`）。

---

## 2. 现状与证据（v0.6.0 已核实）

- `src/render/toolbar.ts:376` `renderStatusBanner()`：

  ```ts
  return `${renderStatusBannerBase()}${state.backupOpen ? "" : `...备份入口按钮...`}${renderBackupPanel()}`;
  ```

  备份面板与状态横幅**在同一个渲染函数里**，挂在 `.sticky-controls` 上方的 `[data-region="status"]`——一个随内容滚动的区域。

- `src/views/backup.ts:5` `renderBackupPanel()` 返回整段 `<section class="backup-panel">`，包含三步表单、摘要、进度、历史（234 行）。
- `src/app/library.ts:135` `openBackupPanel()` 设置 `state.backupOpen = true` 后调用 `patchToolbar()`；`:294` 完成时置回 `false`。
- `src/app/bindings/shell.ts:153` 在 `#backup-open-button` 上绑点击；`:154` 在 `#close-backup` 上只改 `state.backupOpen = false`（没有焦点返还）。
- `src/render/shell.ts:65` `#overlay-host` 已有 7 个槽位：`preview / confirm / tag-manager / editor / merge / settings / ai-chat`，没有 backup。
- `src/app/orchestrate.ts:65` `patchOverlay(id, signature, produce)` 已经是成熟的「一弹窗一容器」机制，退场动画、签名去重都做好了。

---

## 3. 改动清单

| #   | 文件                        | 位置                            | 改什么                                                                                                                                                                                                                    |
| --- | --------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `src/render/shell.ts`       | `SHELL_HTML` 的 `#overlay-host` | 增加 `<div data-overlay="backup"></div>`                                                                                                                                                                                  |
| 2   | `src/app/orchestrate.ts`    | `OverlayId` 类型 + 渲染编排     | 加入 `"backup"`；新增 `patchBackupOverlay()`：`state.backupOpen` 为真时渲染 `<div class="modal-backdrop backup-backdrop" data-backdrop="backup">` 包裹 `renderBackupPanel()`                                              |
| 3   | `src/views/backup.ts`       | `renderBackupPanel`             | 外层从 `<section class="backup-panel">` 改为 `<aside class="backup-drawer" role="dialog" aria-modal="true" aria-label="导入照片">`；关闭按钮保留 `#close-backup`；步骤区改为可滚动主体（`overflow:auto`），底部动作条固定 |
| 4   | `src/render/toolbar.ts`     | `renderStatusBanner`            | 只保留 `renderStatusBannerBase()` + 语义搜索条；**删除**备份入口按钮与 `renderBackupPanel()` 调用                                                                                                                         |
| 5   | `src/app/library.ts`        | `openBackupPanel`               | 不再调用 `patchToolbar()`，改调用 `patchBackupOverlay()`（或 `render()` 对应的 patch 入口）；`closeBackupPanel()` 抽成函数，统一处理重置与焦点返还                                                                        |
| 6   | `src/app/bindings/shell.ts` | `#close-backup`                 | 改为调用 `closeBackupPanel()`；`#backup-open-button` 的绑定迁到侧栏「导入」入口（`[data-nav="import"]`）                                                                                                                  |
| 7   | `src/render/shell.ts`       | 侧栏                            | 日期树上方加导航项「导入照片…」；页脚上方加「最近导入」入口（先用 `state.firstSeenFrom` 触发现有"新导入"筛选，不新建页面）                                                                                                |
| 8   | `src/styles.css`            | 追加                            | `.backup-backdrop`（`position:fixed; inset:0; background: color-mix(...)`）、`.backup-drawer`（右侧 480px，`height:100%`，`translateX` 入场）；抽屉在 `≤900px` 时改为 100% 宽                                             |
| 9   | 备份完成回调                | `src/app/library.ts`            | 完成后：`showToast(\`新增 ${n} 张\`, {action:{label:"查看", run: viewNewImports}})`；若未做 `01`，暂用 `showTransientNotice`                                                                                              |

---

## 4. 实现要点

1. **不动备份的业务逻辑。** `discoverBackupSources / startConfirmedBackup / retry` 等一行不改，本步只改"它挂在哪、怎么进出"。
2. **抽屉 vs 弹窗。** 选抽屉而不是居中弹窗：三步表单是纵向流程，全高布局能同时显示步骤指示与底部动作条，不需要滚动就能看到「开始备份」。
3. **关闭不等于取消。** 备份运行中关抽屉 → 任务继续，顶栏胶囊显示进度；重新打开抽屉要恢复当前步骤（读 `state.backupProgress` 决定渲染哪一步，这个逻辑 `renderBackupPanel` 已有）。
4. **遮罩点击策略。** 未开始/已结束时点击遮罩 = 关闭；正在复制时点击遮罩 = 不关闭（避免误以为任务被取消），可提示「备份在后台继续」。
5. **焦点。** 打开后焦点进抽屉第一个控件；关闭后返还到「导入」入口。本步先用 `element.focus()` 兜底，`05` 会把统一的 `trapDialogFocus` 接上。
6. **`Esc`**：仅在未运行时关闭。

---

## 5. 验收标准

- [ ] 点侧栏「导入照片…」：抽屉从右侧滑入，**网格没有位移**，背景变暗但仍可见。
- [ ] 抽屉内三步表单完整可用，底部「开始备份」在 768px 高窗口内无需滚动即可见。
- [ ] 备份进行中关闭抽屉：内容区可正常浏览、滚动、筛选；顶栏胶囊仍显示进度。
- [ ] 备份完成：toast 显示「新增 N 张 · 查看」，点「查看」落到新导入结果。
- [ ] 关闭抽屉后，侧栏「最近导入」仍可再次进入结果。
- [ ] 关闭后焦点回到触发入口（可用键盘 Tab 验证）。
- [ ] `≤900px` 窗口下抽屉不溢出、不横向滚动。
- [ ] `pnpm test` / `pnpm lint` / `pnpm build` 全绿。

---

## 6. 自包含提示词

```text
你是 Camlib 项目的前端工程师。项目在 D:\code-collect\camlib：
Tauri 2 + Vite + 原生 TypeScript（strict，禁止 any）+ Rust + SQLite，Windows 优先的本地相机媒体库。
渲染是「骨架 + data-region 增量 patch」，overlay 机制在 src/app/orchestrate.ts 的 patchOverlay(id, signature, produce)。

## 任务
把「相机备份」从浏览页的内联面板，改成独立浮层（右侧全高抽屉），入口迁到侧栏，并让备份进度与完成后入口不再依赖内容流。

## 已核实的现状
1. src/render/toolbar.ts 的 renderStatusBanner()（约 376 行）把三样东西拼在一起返回：renderStatusBannerBase() + 备份入口按钮（id="backup-open-button"，文案「相机备份预览」）+ renderBackupPanel()。它挂在 [data-region="status"]，位于 .topbar 与 .sticky-controls 之间，随内容滚动。
2. src/views/backup.ts 的 renderBackupPanel()（第 5 行起，内部含 !state.backupOpen 时返回空串的守卫）返回整段 <section class="backup-panel">，含三步表单、摘要、进度、历史，共 234 行。
3. src/app/library.ts:135 的 openBackupPanel() 设置 state.backupOpen = true 后调用 patchToolbar()；约 294 行完成时置回 false。
4. src/app/bindings/shell.ts:153 绑定 #backup-open-button；154 绑定 #close-backup（只改 state.backupOpen = false）。
5. src/render/shell.ts:65 的 #overlay-host 有 preview / confirm / tag-manager / editor / merge / settings / ai-chat 七个槽位，没有 backup。
6. src/views/backup.ts 里已有 backup-start-button / backup-preview-button / backup-view-new / backup-view-new-later 等 id，绑定在 src/app/bindings 中；请先 grep 确认再动。

## 要做的事
1. src/render/shell.ts：#overlay-host 增加 <div data-overlay="backup"></div>。
2. src/app/orchestrate.ts：OverlayId 增加 "backup"；新增 patchBackupOverlay()，state.backupOpen 为真时把 <div class="modal-backdrop backup-backdrop"> 包裹的 renderBackupPanel() 渲染进该槽位；为假时输出空串走退场动画。
3. src/views/backup.ts：renderBackupPanel 外层改为 <aside class="backup-drawer" role="dialog" aria-modal="true" aria-label="导入照片">，主体可滚动、底部动作条固定；删除原来的 backupOpen 守卫（是否渲染由 overlay 决定）。
4. src/render/toolbar.ts：renderStatusBanner 只保留 renderStatusBannerBase()（以及现有语义搜索条），删除备份入口按钮与 renderBackupPanel() 调用。
5. src/app/library.ts：openBackupPanel 改为触发 backup overlay（不再 patchToolbar）；抽出 closeBackupPanel()，内部重置 state.backupOpen 并返还焦点到触发元素；完成时若已有 toast 能力（src/app/toast.ts 的 showToast）则用 toast 提供「查看」动作，否则用现有 showTransientNotice 兜底。
6. src/app/bindings/shell.ts：把 #backup-open-button 的绑定迁到侧栏「导入照片…」入口（新增 data-nav="import"），#close-backup 改调 closeBackupPanel。
7. src/render/shell.ts 侧栏：日期树上方加「导入照片…」导航项；页脚上方加「最近导入」入口（点击设置 state.firstSeenFrom 并 refreshMedia，复用现有「新导入」筛选，不新建页面）。
8. src/styles.css：新增 .backup-backdrop / .backup-drawer。抽屉右侧 480px、100% 高、translateX 入场，≤900px 时 100% 宽；遮罩用现有 modal-backdrop 的视觉语言。prefers-reduced-motion 下取消位移。

## 约束
- 备份的业务逻辑（发现源盘、预览、拷贝、校验、重试、历史）一行不改，只改挂载位置与进出方式。
- 备份运行中关闭抽屉 = 后台继续，不得取消任务；重新打开要恢复到当前步骤。
- 运行中点击遮罩不关闭；未开始/已完成时点击遮罩关闭。
- 不改 Rust；不碰虚拟滚动与缩略图队列；不新增依赖。
- TS strict，禁止 any；文案中文。

## 验收
- 打开抽屉时网格不位移；768px 高窗口内无需滚动即可看到「开始备份」。
- 备份中关闭抽屉，内容区仍可正常筛选滚动，顶栏任务胶囊显示进度（若步骤 01 已完成）。
- 完成后 toast 有「查看」，点击落到新导入结果；侧栏「最近导入」可再次进入。
- 关闭后焦点回到触发入口；≤900px 无横向滚动。
- pnpm test / pnpm lint / pnpm build 全绿。

## 交付方式
先给改动清单（文件 + 函数 + 迁移的 DOM 片段），再改代码；最后报告三绿结果、手动验证步骤，以及任何与「已核实现状」不符的地方。
```

---

## 7. 风险与回滚

| 风险                                                 | 表现                      | 处理                                                                                  |
| ---------------------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------- |
| 备份表单的事件绑定依赖 `.sticky-controls` 内的选择器 | 抽屉打开后按钮无响应      | 绑定统一用 `app.querySelector`，不限定祖先；`bindings/shell.ts` 的 `bind()` 已支持    |
| 抽屉与预览/编辑器同时打开                            | 两个 overlay 竞争 z-index | 抽屉层级低于 `confirm`、高于 `preview` 不允许同时出现；打开抽屉时若预览打开则先关预览 |
| 进度在抽屉关闭后丢失                                 | 重开显示第 1 步           | `renderBackupPanel` 的步骤推导依赖 `state.backupProgress`，确认它没被 `close` 重置    |
| 回滚                                                 | 中                        | 本步 9 处改动彼此耦合低，可只回滚 `renderStatusBanner` 一处恢复旧入口                 |
