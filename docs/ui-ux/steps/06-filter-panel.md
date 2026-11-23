# 步骤 06 · 筛选面板化

| 项           | 内容                                                                                                                  |
| ------------ | --------------------------------------------------------------------------------------------------------------------- |
| 阶段         | P1（结构改造）                                                                                                        |
| 覆盖诊断编号 | 4.2 / 4.3 / 4.4 / 4.5 / 4.6 / 2.6                                                                                     |
| 依赖         | `02 筛选可叠加`（本步直接消费「筛选即 AND 集合」的语义）                                                              |
| 预估         | 1–2 个会话（建议拆：先主行与条件 chips，再面板内容）                                                                  |
| 主要文件     | `src/render/toolbar.ts`、`src/app/bindings/toolbar.ts`、`src/render/shell.ts`、`src/styles.css`、`src/lib/filters.ts` |

---

## 1. 目标

把「Tab 式主行 + 折叠面板 + 浮层」三种范式叠在 132px 吸顶区里的筛选区，改成两层：

```
[ 全部 照片 视频 实况 ] [收藏] [连拍] [筛选 (3) ▾]   视频 · 收藏 · 标签×2 · ≥4★   [清除]
```

- **主行**只做「高频一键筛选」：类型、收藏、连拍、`筛选 (n)`、当前条件 chips（每个带 `×`）、`清除`。
- **面板**（点 `筛选 (n)` 弹出）承载所有需要输入的条件：标签（可搜索列表 + 计数）、评分（≥N 星级 + 未评分）、日期（预设 + 区间）、AI 检索开关。
- 面板**不再嵌套滚动**，也不再需要「挂到 `.sticky-controls` 才不被裁切」这种几何补丁。

---

## 2. 现状与证据（v0.6.0 已核实）

- `src/render/shell.ts` 的 `.sticky-controls` 内含：`.toolbar > .filter-column > .filter-row + .advanced-filters#advanced-filters`，其中 `.advanced-filters` 默认 `hidden`。
- `src/styles.css` `.advanced-filters` 有 `max-height: 132px; overflow: auto`——吸顶区内的第二层滚动条，展开时遮住约 1/6 屏。
- `src/render/toolbar.ts:166` `tagPopoverHtml()` + `:210` `mountTagPopover()`：标签浮层必须挂到 `.sticky-controls`（`render/toolbar.ts:207-224` 的注释写明是为了不被裁切）。**需要给祖先做特殊处理，说明布局已经在和 CSS 打架。**
- `render/toolbar.ts:123` `renderPrimaryFilters()` 里的 `filter-summary`：`<span class="filter-summary">`（`max-width: 220px` 截断）+ 一个「清除」。
- `render/toolbar.ts:268` `renderRatingFilter()`：原生 `<select>`，10 个选项（5/4/3/2/1/未评分/3+/4+/5+），其中「5 星」与「5 星以上」重复。
- `render/toolbar.ts:287` `renderDateRangeControls()`：两个原生 `<input type="date">`。
- 「清除筛选」出现 3 处：标题区、折叠摘要旁（`.clear-summary-filters`）、高级筛选末尾。
- `src/app/media-query.ts:90` 筛选变化后无条件 `scrollToContentTop()`。

---

## 3. 改动清单

| #   | 文件                          | 位置                                                       | 改什么                                                                                                                                                                           |
| --- | ----------------------------- | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `src/render/shell.ts`         | `.sticky-controls`                                         | 只留 `.toolbar`（一行）；删除 `.advanced-filters` 容器；新增 `[data-region="filter-chips"]`（条件 chips 行，紧跟主行，高度自适应）                                               |
| 2   | `src/render/toolbar.ts`       | `renderPrimaryFilters`                                     | 重写为「类型 chips + 收藏 + 连拍 + `筛选 (n)` 按钮」；删除 `filter-summary` 与折叠箭头                                                                                           |
| 3   | 同上                          | 新增 `renderFilterChips()`                                 | 输出可移除的条件 chips：类型、收藏、连拍、每个标签、日期、评分、AI 检索；每个 chip 带 `data-remove-filter`                                                                       |
| 4   | 同上                          | 新增 `renderFilterPanel()`                                 | 独立面板（非模态），从 `#overlay-host` 的 `[data-overlay="filters"]` 渲染：分四组「标签 / 评分 / 日期 / 检索」，底部固定「重置全部」+「完成」                                    |
| 5   | `src/app/orchestrate.ts`      | overlay 编排                                               | 增加 `"filters"` 槽位（无 backdrop、无焦点陷阱）；点击面板外或 `Esc` 关闭                                                                                                        |
| 6   | `src/render/toolbar.ts`       | `tagPopoverHtml / mountTagPopover / closeTagFilterPopover` | 删除这套浮层（标签选择并入面板）；`tagPopoverOpen` 状态与相关绑定一并移除                                                                                                        |
| 7   | 同上                          | `renderRatingFilter`                                       | 改为星级点击器：`≥ ★1…★5` + 「未评分」开关；移除 10 项下拉                                                                                                                       |
| 8   | 同上                          | `renderDateRangeControls`                                  | 保留两个原生 date 输入（不自造日历），上方加预设：本周 / 本月 / 上月 / 今年 / 清除；与「年/月前缀」互斥（前缀选中时区间控件禁用并说明原因）                                      |
| 9   | `src/app/bindings/toolbar.ts` | 绑定                                                       | `#toggle-advanced-filters` → `#toggle-filter-panel`；`[data-remove-filter]` 统一处理单项移除；删除 `clear-summary-filters` 与高级筛选末尾的清除按钮                              |
| 10  | `src/app/media-query.ts`      | `refreshMedia`                                             | 单项 chip 移除 / 面板内改条件时**保留滚动位置**（沿用 `04` 的 `resetScroll` 参数），只有「重置全部」才回顶部                                                                     |
| 11  | `src/styles.css`              | 删除/新增                                                  | 删除 `.advanced-filters` 的 `max-height/overflow`；新增 `.filter-panel`（fixed 定位，宽 380，`max-height: calc(100vh - 120px)`，仅标签列表内部滚动）、`.filter-chips`、`.chip-x` |
| 12  | `src/lib/filters.ts`          | `secondaryFilterParts`                                     | 改为返回结构化 `{ key, label, value }[]`，供 chips 渲染与逐个移除复用（当前返回 `string[]`）                                                                                     |

---

## 4. 实现要点

1. **面板不吸顶、不进文档流。** 用 fixed 定位挂在 overlay 槽位，位置由 `#toggle-filter-panel` 的 `getBoundingClientRect()` 计算（左对齐按钮、上边距按钮底部 + 6px）。窗口 resize/滚动时关闭面板，不做跟随——跟随会带来一堆边界 bug，收益很小。
2. **只允许一处滚动。** 面板整体 `max-height` 受视口约束，内部只有标签列表滚动（标签可能上百个）；其余分组不滚动。
3. **条件 chips 是唯一真相的可视化。** 点 chip 的 `×` 直接移除该条件，不打开面板；chips 顺序固定（类型 → 收藏 → 连拍 → 标签 → 日期 → 评分 → AI），避免每次刷新跳动。
4. **评分控件语义**：`ratingEq`（精确）与 `ratingMin`（下限）当前并存。面板里只暴露「≥ N」与「未评分」两个入口，内部映射：未评分 → `ratingEq = 0`；≥N → `ratingMin = N` 且 `ratingEq = null`。
5. **日期不要自造日历。** 原生 `<input type="date">` 在 Windows/Chromium 下有可用的弹出日历，自造一个月历组件成本高、键盘支持差。预设按钮解决 80% 的场景。
6. **`筛选 (n)` 的 n 只数面板内条件**（标签/日期/评分/AI），不含类型/收藏/连拍——后三者已在主行有自己的 chip，重复计数会让数字不可解释。
7. **窄窗口**：面板宽度 `min(380px, calc(100vw - 32px))`；`≤720px` 时改为底部抽屉（`inset: auto 0 0 0; border-radius: 16px 16px 0 0`）。
8. **删除的东西要删干净**：`filter-summary`、`.clear-summary-filters`、`.advanced-filters`、`tagPopoverHtml`、`mountTagPopover`、`tagPopoverOpen` 及相关 CSS。留着会变成下一轮的死代码。

---

## 5. 验收标准

- [ ] 主行始终只有一行，高度不随筛选条件数量变化；展开/收起面板时内容区不位移。
- [ ] 点 `筛选 (3)` 弹出面板，位置贴着按钮，不被任何容器裁切。
- [ ] 面板内可见：标签可搜索列表（含计数、复选）、评分 ≥N + 未评分、日期预设 + 区间、AI 检索开关。
- [ ] 每个已选条件在主行显示为独立 chip，点 `×` 立即移除并刷新。
- [ ] 条件多于 5 个时 chips 换行或横向滚动，不截断成省略号。
- [ ] 移除单个条件不回到顶部；「重置全部」回顶部。
- [ ] 标签数量 100+ 时，面板只有标签列表滚动，其余分组固定。
- [ ] 「5 星」与「5 星以上」不再同时存在。
- [ ] 全仓搜 `advanced-filters` / `tagPopover` / `filter-summary` 无残留。
- [ ] `pnpm test` / `pnpm lint` / `pnpm build` 全绿。

---

## 6. 自包含提示词

```text
你是 Camlib 项目的前端工程师。项目在 D:\code-collect\camlib：
Tauri 2 + Vite + 原生 TypeScript（strict，禁止 any）+ Rust + SQLite，Windows 优先的本地相机媒体库。
渲染是「骨架 + data-region 增量 patch」，状态在 src/state.ts，筛选摘要工具在 src/lib/filters.ts。

## 任务
把筛选区从「主行 + 吸顶内滚动折叠层 + 标签浮层」三套范式，改成「主行 + 独立筛选面板 + 条件 chips」。

## 已核实的现状
1. src/render/shell.ts 的 .sticky-controls 内含 .toolbar > .filter-column > .filter-row + .advanced-filters#advanced-filters（默认 hidden）。
2. src/styles.css 的 .advanced-filters 有 max-height:132px; overflow:auto，展开后遮住约 1/6 屏，且形成内外两层滚动。
3. src/render/toolbar.ts 的 tagPopoverHtml()（约 166 行）/ mountTagPopover()（约 210 行）把标签浮层挂到 .sticky-controls 才能不被裁切（注释里写了原因）。
4. src/render/toolbar.ts 的 renderPrimaryFilters()（约 123 行）里有 filter-summary（max-width:220px 截断）和「清除」按钮。
5. renderRatingFilter()（约 268 行）是 10 项原生 select，含重复的「5 星 / 5 星以上」。
6. renderDateRangeControls()（约 287 行）是两个原生 input[type=date]。
7. 「清除筛选」出现在三处：标题区、filter-summary 旁（.clear-summary-filters）、高级筛选末尾。
8. src/app/media-query.ts 的 refreshMedia() 在 finally 里无条件 scrollToContentTop()（步骤 04 可能已加 { resetScroll?: boolean } 参数，先确认）。

## 要做的事
1. src/render/shell.ts：.sticky-controls 只保留一行 .toolbar；删除 .advanced-filters 容器；新增 [data-region="filter-chips"] 放条件 chips。
2. renderPrimaryFilters 重写为：类型 chips（全部/照片/视频/实况）+ 收藏 + 连拍 + 「筛选 (n) ▾」按钮；删除 filter-summary 与折叠箭头。
3. 新增 renderFilterChips()：按固定顺序（类型 → 收藏 → 连拍 → 标签 → 日期 → 评分 → AI）输出可移除 chips，每个带 data-remove-filter="<key>:<value>"。
4. 新增 renderFilterPanel()：非模态浮层，挂到 #overlay-host 新增的 [data-overlay="filters"] 槽位，分四组：
   - 标签：可搜索列表 + 数量计数 + 复选框（替代原 tagPopover）；
   - 评分：≥1..≥5 星级点击器 + 「未评分」开关（移除 10 项下拉）；
   - 日期：本周/本月/上月/今年/清除 预设 + 两个原生 date 输入（不要自造日历）；当年/月前缀选中时禁用区间并说明原因；
   - 检索：AI 检索开关（复用现有 semantic 逻辑）。
   顶部显示「已选 n 项」，底部固定「重置全部」「完成」。
5. panel 位置：由 #toggle-filter-panel 的 getBoundingClientRect() 计算，左对齐按钮、top = 按钮底部 + 6px；width min(380px, calc(100vw - 32px))；max-height calc(100vh - 120px)；只有标签列表内部滚动。点击面板外或 Esc 关闭；窗口 resize / .content 滚动时直接关闭。
6. 删除 tagPopoverHtml / mountTagPopover / closeTagFilterPopover / toggleToolbarTagPopover 与 tagPopoverOpen 状态，以及对应的 .tag-popover CSS（先 grep 调用点，确认没有别的地方依赖）。
7. renderDateRangeControls 加预设；renderRatingFilter 换成星级控件。
8. 绑定：主行 #toggle-filter-panel 开关面板；[data-remove-filter] 统一处理单项移除（保留滚动位置）；面板内控件变更即时刷新（resetScroll: false）；只保留「重置全部」一个清除入口。
9. src/lib/filters.ts 的 secondaryFilterParts 改为返回结构化数组 { key, label, value }[]，供 chips 与逐项移除复用；同步更新 filters.test.ts。
10. src/styles.css：删除 .advanced-filters 的 max-height/overflow 与 .tag-popover；新增 .filter-panel / .filter-chips / .chip-x；≤720px 时面板改底部抽屉。

## 约束
- 不改后端查询参数与 SQL，不改 MediaQueryInput 字段。
- 不自造日历组件；不自造下拉组件（用原生 input/checkbox/button）。
- 不引入 UI 框架或依赖。
- 不碰虚拟滚动、卡片节点池、缩略图队列。
- 面板内只允许标签列表一处滚动，禁止嵌套滚动。
- TS strict，禁止 any；文案中文。

## 验收
- 主行永远一行；开关面板时内容区不位移。
- 面板贴着按钮出现、不被裁切；标签 100+ 时只有标签列表滚动。
- 每个条件都是独立 chip，点 × 立即移除且不跳回顶部；「重置全部」才回顶部。
- 评分只剩「≥N」与「未评分」；日期有预设。
- 全仓搜不到 advanced-filters / tagPopover / filter-summary 的残留。
- pnpm test / pnpm lint / pnpm build 全绿。

## 交付方式
先给改动清单（文件 + 函数 + 被删除的旧件），再改代码；最后报告三绿结果、手动验证步骤与任何取舍（例如日期为何不自造日历）。
```

---

## 7. 风险与回滚

| 风险                 | 表现                           | 处理                                                             |
| -------------------- | ------------------------------ | ---------------------------------------------------------------- |
| 面板定位漂移         | 滚动后浮在错误位置             | 滚动即关闭；不做跟随                                             |
| 标签选择效率下降     | 原浮层一键多选变成面板两步     | 面板内标签列表默认聚焦搜索框，支持键盘上下 + 空格勾选            |
| 与 `07` 侧栏改造冲突 | 都在改 `.sticky-controls` 周边 | 07 只动侧栏，不动 toolbar；若同时进行，先合 06                   |
| 旧代码删不干净       | 死代码、样式互相污染           | 验收项明确要求全仓搜索无残留                                     |
| 回滚                 | 中                             | 建议拆两个 commit：① 主行 + chips，② 面板 + 删除浮层；可分别回滚 |
