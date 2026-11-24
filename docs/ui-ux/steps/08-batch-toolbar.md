# 步骤 08 · 批量工具栏收敛 + 键盘选择模型

| 项           | 内容                                                                                                                                                                 |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 阶段         | P1                                                                                                                                                                   |
| 覆盖诊断编号 | 5.1 / 5.4 / 5.6 / 13.2                                                                                                                                               |
| 依赖         | `01 反馈三通道`（批量结果要有可见反馈）、`05 弹窗焦点`（键盘模型与焦点管理共用一套规则）                                                                             |
| 预估         | 1–2 个会话                                                                                                                                                           |
| 主要文件     | `src/render/toolbar.ts`、`src/render/grid.ts`、`src/render/events.ts`、`src/app/bindings/toolbar.ts`、`src/app/bindings/global.ts`、`src/state.ts`、`src/styles.css` |

---

## 1. 目标

1. **工具栏从 10 个按钮 + 2 个下拉，收敛为 4 + 1**：`已选 N 项` + `收藏` / `标签` / `AI 打标` / `更多 ▾`，破坏性动作 `移入回收站` 单独放在最右、与高频动作之间留出分隔。
2. **批量标签/评分一次完成**：不再「选下拉 → 点打标 → 再选评分 → 点应用」，改为一个「标签与评分」弹层，选完点一次确认。
3. **键盘可用**：`Space` 切换选中、`Ctrl+A` 全选当前结果、`Shift+点击/方向键` 范围选择、`Enter` 打开预览、`Esc` 清空选择；每张卡不再是一个 Tab 停靠点（roving tabindex）。
4. **按天批量**：`.day-heading` 上提供「选择这天」。

---

## 2. 现状与证据（v0.6.0 已核实）

- `src/render/toolbar.ts:380` `renderSelectionToolbar()` 一行里渲染：全选/取消全选、已选摘要、清除选择、AI 打标、批量收藏、取消收藏、标签下拉 + 打标 + 移除、评分下拉 + 应用、合并视频、移入回收站——**10 个按钮 + 2 个 select**，全部同级同色（仅删除用 `.danger-button`）。
- `src/render/grid.ts:40` `renderCard()`：`<article class="media-card" ... tabindex="0">`，卡内还有 `toggle-select` 与 `toggle-favorite` 两个 `<button>`。100 张卡 = 300 个 Tab 停靠点。
- `src/app/bindings/toolbar.ts:203` 已有 `Shift` 范围选择（`collectRangeIds` + `state.lastSelectIndex`），但只支持点击触发，没有键盘路径。
- `src/app/bindings/global.ts` 全局 `keydown` 目前只处理 `Esc`、`Enter`（删除确认）、`/`，**没有 `Ctrl+A`、`Space`、方向键**。
- `src/render/grid.ts:68` `createDayGroup()` 的 `.day-heading` 只有 `<h2>` 与计数 `<span>`，没有操作。
- `src/app/bindings/toolbar.ts` 里批量标签/评分走 `batch-tag-attach` / `batch-rating-apply` 两个独立按钮。

---

## 3. 改动清单

| #   | 文件                                                  | 位置                             | 改什么                                                                                                                                                                                                               |
| --- | ----------------------------------------------------- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `src/render/toolbar.ts`                               | `renderSelectionToolbar`         | 重写结构：`已选 N 项` · 收藏/取消收藏（合为一个切换按钮，按当前选择状态决定文案）· 标签 · AI 打标 · `更多 ▾` · 分隔 · 移入回收站（最右，danger）                                                                     |
| 2   | 同上                                                  | 新增 `renderSelectionMoreMenu()` | 「更多」弹层：标签多选（可搜索）+ 评分星级 + 「合并视频」（仅当所选全为视频时出现）；底部一次「应用」                                                                                                                |
| 3   | `src/app/bindings/toolbar.ts`                         | 批量命令                         | 合并 `batch-favorite` / `batch-unfavorite` 为 `toggle-favorite-selected`；`batch-tag-attach/detach/rating-apply` 收敛为 `apply-batch-meta`（一次调用，内部串行调用现有 API）                                         |
| 4   | `src/render/grid.ts`                                  | `renderCard` / `patchCardNode`   | 卡内两个按钮改为「仅在卡片获得焦点或 hover 时进入 Tab 序列」：`tabindex="-1"`，卡片本身参与 roving；卡内按钮仍可点击/读屏访问（`aria-hidden` 不能用，否则读屏丢失）                                                  |
| 5   | `src/state.ts`                                        | —                                | 新增 `focusIndex: number \| null`（roving 焦点所在卡片序号）                                                                                                                                                         |
| 6   | `src/render/events.ts` + `src/app/bindings/global.ts` | 键盘                             | `.media-card` 的 `keydown`：`Space` 切换选中、`Enter` 打开、`Shift+Arrow` 范围扩展、`Arrow` 移动焦点（用 `focusIndex` 计算下一张并 `scrollIntoView({block:"nearest"})`）；全局 `Ctrl+A` 仅在没有输入框聚焦时触发全选 |
| 7   | `src/render/grid.ts`                                  | `createDayGroup`                 | `.day-heading` 加「选择这天」按钮（`data-action="select-day"`），点击把该分组所有 id 加入选择                                                                                                                        |
| 8   | `src/app/bindings/toolbar.ts`                         | `select-current-results`         | 全选后若 `state.page.items.length < state.page.total`，toast 提示「已选当前 N 项（共 M 项，可继续滚动加载后再全选）」——避免"全选"语义含糊                                                                            |
| 9   | `src/styles.css`                                      | 追加                             | `.selection-toolbar` 分组布局（主组 / 分隔线 / 危险组）；`.selection-more` 弹层；`.day-heading .select-day`（hover 显现）；焦点态下卡片内按钮可见                                                                    |
| 10  | `src/app/media-ops.ts`                                | 批量结果                         | 成功后统一 `showToast("已收藏 N 项", {action:{label:"撤销", run:…}})`（撤销模型见 `01` 第 4.5 条，本步先接收藏与评分）                                                                                               |

---

## 4. 实现要点

1. **"收藏"合并为一个切换按钮**：一批里只要有一张未收藏，按钮就是「收藏」；全部已收藏时是「取消收藏」。比两个并排按钮省一半空间，也减少误点。
2. **危险动作的隔离方式**：不要靠颜色区分（同色系 danger 已存在），要靠**分组与间距**。移入回收站放在工具栏最右，前面加 `border-left: 1px solid var(--line)` + 16px padding，且在窄窗口下换行时也要保持独立。
3. **「更多」里的合并条件**：`mergeUnavailable` 的现有判断逻辑保留（选中 < 2、包含非视频、媒体库不可用），只是把按钮移进弹层；不可用时给 disabled + 原因 title，不要隐藏（隐藏会让用户以为功能没了）。
4. **roving tabindex 的正确实现**：
   - 只有 `state.focusIndex` 对应的卡片 `tabindex="0"`，其余 `-1`；
   - 首次进入网格（Tab 到网格）时，`focusIndex` 为空则取第一张可见卡；
   - 方向键按「视觉顺序」移动（`state.page.items` 顺序足够，虚拟滚动下用 id 定位再 `querySelector` 找 DOM）；
   - 卡片内按钮 `tabindex="-1"`，但在卡片聚焦时通过 CSS 显示，用户按 `Tab` 会从卡片直接跳到工具栏——**这是有意的**，否则 100 张卡仍是 300 个停靠点。
5. **`Ctrl+A` 的边界**：只在 `previewIndex === null`、无弹窗、焦点不在 input/textarea 时触发；触发后 `preventDefault`，避免选中页面文本。
6. **`Space` 与滚动冲突**：`Space` 在网格内默认会滚动页面，必须 `preventDefault()`。
7. **批量标签/评分的执行顺序**：先标签后评分（标签失败不应阻止评分），任一失败都汇总到一条 toast，不逐条弹。
8. **撤销**：收藏/评分/标签都是可逆写操作，但撤销需要记录原值。只做「收藏」一条（记录本批原本是否收藏），标签与评分标记为「不可撤销，操作前可在弹层确认影响数量」。不要承诺做不到的撤销。

---

## 5. 验收标准

- [x] 选中后工具栏一行内不再溢出（1366×768 下不换行）；按钮数 ≤ 5 + 危险 1。
- [x] 「移入回收站」与收藏/标签/AI 之间有明显分隔，不与高频动作相邻。
- [x] 「更多」弹层：标签多选 + 评分 + 合并（仅全视频时出现），一次「应用」完成两件事。
- [x] 键盘：`Space` 选中/取消、`Ctrl+A` 全选、方向键移动焦点、`Shift+方向键` 扩展范围、`Enter` 打开、`Esc` 清空选择。
- [x] Tab 键从工具栏进入网格只需 1 次停靠；100 张卡不会产生 300 个 Tab 停靠点。
- [x] 卡片获得焦点时，卡内「选择/收藏」按钮可见且可点。
- [x] `.day-heading` 有「选择这天」，点击后该天全部选中且计数正确。
- [x] 批量收藏成功后有 toast + 可撤销。
- [x] `pnpm test` / `pnpm lint` / `pnpm build` 全绿；补 `collectRangeIds` 与 roving 移动的纯函数测试。

---


### 实现备注（v0.6.x）

- **全选只覆盖已加载页**：`selectCurrentResults()` 不再一进来就逐页拉 id，先同步选中当前页；
  若 `items.length < total`，toast 写「已选当前 N 项（共 M 项）」并带「选中全部」动作，
  跨页全选仍是原来那条分页查询（`selectEveryResult`）。
- **「选择这天」`tabindex="-1"`**：按钮仍在 DOM、hover/鼠标聚焦可见可点，但不进 Tab 序列——
  否则每个天分组一个停靠点，「Tab 进网格只有 1 个」直接失效。键盘侧按天扩选走 `Shift+方向键`。
- **标签可反向**：弹层顶部有「移除所选标签」原生复选框，保留原 `batch-tag-detach` 的能力，
  仍然只走一次「应用」。

## 6. 自包含提示词

```text
你是 Camlib 项目的前端工程师。项目在 D:\code-collect\camlib：
Tauri 2 + Vite + 原生 TypeScript（strict，禁止 any）+ Rust + SQLite，Windows 优先的本地相机媒体库。
网格是虚拟滚动 + 卡片节点池（src/render/virtual.ts、src/render/grid.ts），事件是 data-action 委托（src/render/events.ts）。

## 任务
1）把批量工具栏从 10 个按钮 + 2 个下拉收敛为 4 个主操作 + 「更多」，并把危险动作隔离。
2）给网格加一套可用的键盘选择模型（roving tabindex、Space/Ctrl+A/方向键/Shift 范围）。
3）批量标签与评分合并为一次确认。

## 已核实的现状
1. src/render/toolbar.ts 的 renderSelectionToolbar()（约 380 行）一行里渲染：全选/取消全选、已选摘要、清除选择、AI 打标、批量收藏、取消收藏、标签下拉+打标+移除、评分下拉+应用、合并视频、移入回收站。共 10 个按钮 + 2 个 select，同色同级。
2. src/render/grid.ts 的 renderCard()（约 40 行）：<article class="media-card" tabindex="0">，内部还有 data-action="toggle-select" 与 "toggle-favorite" 两个 button，所以每张卡 3 个 Tab 停靠点。
3. src/app/bindings/toolbar.ts 约 203 行已有 Shift 范围选择（collectRangeIds + state.lastSelectIndex），但只有鼠标路径。
4. src/app/bindings/global.ts 的全局 keydown 只处理 Esc / Enter（删除确认）/ "/"，没有 Ctrl+A、Space、方向键。
5. src/render/grid.ts 的 createDayGroup()（约 68 行）里 .day-heading 只有 h2 与计数，没有操作按钮。
6. 批量标签/评分当前由 #batch-tag-attach、#batch-tag-detach、#batch-rating-apply 三个按钮分别触发。

## 要做的事
1. renderSelectionToolbar 重写为：`已选 N 项` | 收藏（切换：有未收藏项时显示「收藏」，全已收藏时显示「取消收藏」）| 标签 | AI 打标 | 更多 ▾ || 移入回收站（最右，danger，前面加分隔线与 16px 间距）。
2. 新增「更多」弹层（fixed 定位、点击外关闭）：标签多选（可搜索）+ 评分星级 + 「合并视频」（仅当所选全为视频时出现，不可用时 disabled 并给原因 title）+ 底部「应用」。
3. 绑定收敛：batch-favorite / batch-unfavorite 合并为 toggle-favorite-selected；标签与评分的三个命令收敛为 apply-batch-meta（先标签后评分，任一失败汇总到一条 toast）。
4. 键盘模型：
   - src/state.ts 增加 focusIndex: number | null；
   - 卡片 roving tabindex：只有 focusIndex 对应卡片 tabindex="0"，其余 -1；卡内两个按钮 tabindex="-1"（保留可点、读屏可访问），卡片聚焦或 hover 时用 CSS 显示；
   - 卡片 keydown：Space 切换选中（preventDefault 防滚动）、Enter 打开预览、方向键移动焦点（scrollIntoView block:"nearest"）、Shift+方向键扩展范围；
   - 全局 Ctrl+A：仅在无弹窗、previewIndex === null、焦点不在 input/textarea/contenteditable 时全选当前结果，并 preventDefault；
   - Esc 清空选择（与现有 Esc 分派顺序协调，不要抢弹窗的 Esc）。
5. .day-heading 加「选择这天」按钮（data-action="select-day"，hover 显现），点击把该分组所有 id 加入选择。
6. 全选若只覆盖已加载页（state.page.items.length < state.page.total），用 toast 提示「已选当前 N 项（共 M 项）」。
7. 批量收藏成功后 showToast + 撤销（若步骤 01 的 toast 能力已存在，接 action；否则先只 toast）。标签与评分明确为不可撤销，在弹层内显示影响数量。
8. src/styles.css：.selection-toolbar 分组布局、.selection-more 弹层、.day-heading .select-day、卡片聚焦时按钮可见的样式。

## 约束
- 不碰虚拟滚动算法（virtual.ts）与缩略图队列；只在网格层加焦点管理。
- 不引入依赖；不自造多选组件（用原生 checkbox + 按钮）。
- 保留现有批量 API 调用，不新增 Rust command。
- TS strict，禁止 any；文案中文；危险动作不得与高频动作相邻。

## 验收
- 工具栏 1366×768 下不溢出，按钮数 ≤ 5 + 危险 1。
- 键盘：Space / Ctrl+A / 方向键 / Shift+方向键 / Enter / Esc 全部可用。
- Tab 进入网格只 1 个停靠点；100 张卡不会产生 300 个停靠点。
- 「选择这天」计数正确；全选提示包含已加载/总数。
- pnpm test / pnpm lint / pnpm build 全绿，补 collectRangeIds 与焦点移动的纯函数测试。

## 交付方式
先给改动清单（文件 + 函数 + 被合并/删除的 action），再改代码；最后报告三绿结果与键盘手动验证步骤。
```

---

## 7. 风险与回滚

| 风险                                        | 表现                           | 处理                                                                                                      |
| ------------------------------------------- | ------------------------------ | --------------------------------------------------------------------------------------------------------- |
| 键盘模型与预览器方向键冲突                  | 预览打开时方向键切换了网格焦点 | 键盘处理只挂在 `.media-card` 上，预览打开时卡片不在焦点链；预览的方向键走自己的监听                       |
| 卡片内按钮 `tabindex="-1"` 导致读屏无法发现 | 无障碍回归                     | 保留 `aria-label`，卡片 `aria-describedby` 或读屏通过组内导航仍可到达；若担心，改为「卡片聚焦时动态设 0」 |
| 「更多」弹层被虚拟滚动裁切                  | 弹层显示不全                   | 挂 `#overlay-host` 的独立槽位（fixed），不放在 toolbar 内                                                 |
| 批量合并后按钮状态错乱                      | 合并完成仍显示「合并中」       | 走现有 `mergeBusy/mergeJobId` 状态，不要新建标记                                                          |
| 回滚                                        | 中                             | 拆三个 commit：工具栏结构 / 键盘模型 / 批量弹层                                                           |
