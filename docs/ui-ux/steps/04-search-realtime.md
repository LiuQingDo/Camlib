# 步骤 04 · 搜索实时化、范围扩展、可解释空态

| 项           | 内容                                                                                                                                                              |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 阶段         | P0（搜索实时化）/ P1（范围与空态）                                                                                                                                |
| 覆盖诊断编号 | 3.1 / 3.2 / 3.3（3.4 语义搜索合并，视本步余量，否则并入 `06`）                                                                                                    |
| 依赖         | `01 反馈三通道`（可选，用于「搜索失败」提示）；与 `02` 无冲突                                                                                                     |
| 预估         | 1 个会话（含一次 SQL 迁移级别的改动，但不改 schema）                                                                                                              |
| 主要文件     | `src/app/bindings/shell.ts`、`src/app/media-query.ts`、`src/render/shell.ts`、`src-tauri/src/db/queries/media_query.rs`、`src/views/dialogs.ts`、`src/styles.css` |

---

## 1. 目标

1. **边打边筛**：输入 250ms 后自动查询；`Enter` 立即执行；`Esc` 清空并退出；输入框内出现 `×`。
2. **搜得到东西**：搜索范围从「只有文件名」扩到 `文件名 OR 用户标签 OR AI 标签 OR AI 描述`。相机文件名 `DSC_0123.JPG` 命中率极低，这是搜索形同虚设的根因。
3. **空态会解释**：无结果时说明「当前有多少个条件」「是搜索词没中，还是筛选太窄」，并提供「只保留搜索词」「清空全部」两条出路。
4. （可选）**一个输入框两种检索**：普通词走 SQL，自然语言走 AI，用框内 `✦` 显式切换。

---

## 2. 现状与证据（v0.6.0 已核实）

- `src/app/bindings/shell.ts:32` 搜索框只绑了两件事：`input` 时写 `searchUi.draft`、`keydown` 且 `Enter` 时才 `state.search = draft` + `refreshMedia()`。**输入过程零反馈**。
- `src/render/shell.ts` 的搜索框：`<input id="search-input" placeholder="搜索文件名">` + `<kbd>/</kbd>` + 搜索按钮，无清空按钮。
- 后端 `src-tauri/src/db/queries/media_query.rs:24`：

  ```rust
  if let Some(search) = query.search... {
      conditions.push("m.display_name LIKE ?N ESCAPE '\\'");
  }
  ```

  **只查文件名**。标签在 `media_tags`/`media_ai_tags`（关联 `tags.name`），AI 描述在 `media_ai.caption`，都没有参与搜索。

- 空态在 `src/views/dialogs.ts:452`：只有一句「没有匹配的媒体 / 试试调整搜索或筛选条件」，不区分原因。
- `src/app/media-query.ts:90` 的 `refreshMedia()` 在 `finally` 里无条件 `scrollToContentTop()`。实时搜索下这会导致每敲一个字视图跳回顶部。

---

## 3. 改动清单

| #   | 文件                                                    | 位置            | 改什么                                                                                                                                                                          |
| --- | ------------------------------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `src-tauri/src/db/queries/media_query.rs`               | 搜索条件段      | 改为四路 OR（同一参数绑定 4 次）：`m.display_name`、`media_tags→tags.name`、`media_ai_tags→tags.name`、`media_ai.caption`，全部 `LIKE ?N ESCAPE '\'`                            |
| 2   | 同上                                                    | 单元测试        | 补：标签命中、AI 描述命中、文件名命中、无命中；确认 `%`/`_` 转义仍生效                                                                                                          |
| 3   | `src/app/bindings/shell.ts`                             | `#search-input` | `input` → 清 250ms 定时器 → 到期后 `state.search = trim` + `refreshMedia({ resetScroll: false })`；`Enter` 立即执行；`Esc` 清空并刷新；`Blur` 不提交（避免误触）                |
| 4   | `src/app/media-query.ts`                                | `refreshMedia`  | 增加可选参数 `{ resetScroll?: boolean }`，默认 `true`；搜索输入路径传 `false`                                                                                                   |
| 5   | `src/render/shell.ts`                                   | 搜索框          | 加 `×` 清空按钮（`#search-clear`，仅在有值时可点）；`placeholder` 改为「搜索文件名、标签、描述」                                                                                |
| 6   | `src/app/bindings/shell.ts`                             | 清空按钮        | 点击 → 清空 `state.search`/`searchUi.draft` → 回焦输入框 → 刷新（`resetScroll: false`）                                                                                         |
| 7   | `src/views/dialogs.ts`                                  | 空态            | 分两行：第一行「没有匹配的媒体」，第二行列出当前生效条件（复用 `secondaryFilterParts` + 搜索词 + 类型）；按钮：`清除筛选，保留搜索词`（仅当有筛选且有搜索词时出现）、`清空全部` |
| 8   | `src/styles.css`                                        | 追加            | `.search-box` 内清空按钮与 `kbd` 的排布；`.empty-state` 的条件行样式                                                                                                            |
| 9   | （可选）`src/render/toolbar.ts` + `bindings/toolbar.ts` | 语义搜索        | 折叠层里的 `#semantic-search-input` 移除；搜索框加 `✦` 切换按钮，激活时走 `commitSemanticSearch`，未激活时走 `state.search`；两者互斥且有明确视觉态                             |

---

## 4. 实现要点

1. **防抖与并发。** `refreshMedia` 已有 `mediaQueryToken` 机制，天然能丢弃过期响应；防抖只需保证最后一次输入必发。输入期间不要 `bumpGridEpoch()` 之外的额外重建。
2. **实时搜索不要重置滚动。** 这是 `2.6` 的一半（另一半在 `06`）。搜索词变化时保留滚动位置更自然；但筛选条件变化仍回顶部。
3. **SQL 性能。** 四路 OR 会走 4 次子查询；当前数据量（个人库，万级）可接受。若担心，可给 `tags(name)` 加索引（`0001` 里 `name` 已是 `UNIQUE`，自带索引），`media_ai.caption` 只在 AI 处理过的行上存在，无索引也能扫。**不要引入 LIKE 前缀优化或 FTS**，本步不做架构升级。
4. **命中来源（3.2 的可选增强）。** 若想显示「命中：标签 海边」，可在 SELECT 里加一个 `CASE WHEN ... THEN 'name'|'tag'|'ai' END AS match_in`，需要重复同样的 4 个参数。**先不做**——多 4 个绑定 + DTO 字段 + 卡片渲染，收益低于成本；等 `08` 卡片改版时一起做。
5. **空态的责任划分。** 空态只解释，不猜。「搜索词没中」与「筛选太窄」通过「有搜索词 + 有筛选 + 结果 0」区分：两者都有时提示「试试只保留搜索词」。
6. **语义搜索合并的边界。** 若做 3.4：普通搜索与 AI 搜索**共用输入框但状态分离**（`state.search` vs `state.semanticSearch`），切换时清空对方，避免两套条件同时生效造成"AI 说没有、SQL 说有"。
7. **无障碍**：搜索框加 `aria-label="搜索文件名、标签或描述"`；清空按钮 `aria-label="清空搜索"`；结果数量变化由 `01` 的 `aria-live` 区域播报，别在搜索框上做 live。

---

## 5. 验收标准

- [ ] 输入「海边」后停手 250ms，网格自动更新，无需按 Enter。
- [ ] 连续快速输入（如「海」「海边」「海边的日落」）不出现旧结果闪回、不重复请求。
- [ ] 搜索「DSC」能命中文件名；搜索某个标签名能命中对应照片；搜索 AI 描述里的词能命中（库内有 AI 结果时）。
- [ ] 输入过程中视图**不跳回顶部**；改变筛选条件仍回顶部。
- [ ] 无结果时：显示当前条件摘要，有「清除筛选，保留搜索词」「清空全部」两条出路（按条件出现）。
- [ ] `Esc` 清空搜索并保持焦点；`×` 按钮同样可用。
- [ ] `cargo test`（`media_query` 相关）/ `pnpm test` / `pnpm lint` / `pnpm build` 全绿。
- [ ] 搜索 1 万条库时首屏响应 < 300ms（本地 SSD 实测，不做硬性门槛，但要观察）。

---

## 6. 自包含提示词

```text
你是 Camlib 项目的全栈工程师。项目在 D:\code-collect\camlib：
Tauri 2 + Vite + 原生 TypeScript（strict，禁止 any）+ Rust + SQLite，Windows 优先的本地相机媒体库。
前端渲染是「骨架 + data-region 增量 patch」；后端查询在 src-tauri/src/db/queries/。

## 任务
把搜索从「按 Enter 才查、只查文件名」改成「边打边筛、能搜标签与 AI 描述、空态能解释原因」。

## 已核实的现状
1. src/app/bindings/shell.ts 约 32 行：搜索框的 input 事件只写 searchUi.draft；只有 Enter 才把 draft 提交为 state.search 并 refreshMedia()。输入过程零反馈。
2. src/render/shell.ts 的搜索框是 <input id="search-input" placeholder="搜索文件名"> + <kbd>/</kbd> + #search-button，没有清空按钮。
3. src-tauri/src/db/queries/media_query.rs 约 24 行：搜索条件只有 m.display_name LIKE ?N ESCAPE '\'，即只搜文件名。
   标签关系在 media_tags / media_ai_tags（关联 tags.name），AI 描述在 media_ai.caption（见 0001、0007 迁移）。
4. 空态在 src/views/dialogs.ts 约 452 行：只有「没有匹配的媒体 / 试试调整搜索或筛选条件」，不区分原因。
5. src/app/media-query.ts 的 refreshMedia() 在 finally 里无条件 scrollToContentTop()，实时搜索会导致每输入一个字视图跳回顶部。
6. 语义搜索（AI）目前是折叠筛选层里的独立输入框 #semantic-search-input，与普通搜索两套入口、明文互斥。

## 要做的事
A. 后端（Rust）
1. 把搜索条件改成四路 OR，四个 LIKE 绑定同一个参数值：
   - m.display_name
   - EXISTS (SELECT 1 FROM media_tags mt JOIN tags t ON t.id = mt.tag_id WHERE mt.media_item_id = m.id AND t.name LIKE ?N ESCAPE '\')
   - EXISTS (SELECT 1 FROM media_ai_tags mat JOIN tags t ON t.id = mat.tag_id WHERE mat.media_item_id = m.id AND t.name LIKE ?N ESCAPE '\')
   - EXISTS (SELECT 1 FROM media_ai ai WHERE ai.media_item_id = m.id AND ai.caption LIKE ?N ESCAPE '\')
   注意参数序号要按 values 长度递增，且四处引用同一个序号；保持 escape_like 的转义语义。
2. 在 media_query 的测试里补：文件名命中、用户标签命中、AI 标签命中、AI 描述命中、无命中、% 与 _ 的转义。

B. 前端
3. src/app/bindings/shell.ts：input 事件做 250ms 防抖后提交 state.search 并刷新；Enter 立即提交；Esc 清空并刷新；失焦不提交。
4. src/app/media-query.ts：refreshMedia 增加可选参数 { resetScroll?: boolean }，默认 true；搜索输入路径传 false，避免输入时视图跳动。
5. src/render/shell.ts：搜索框加 #search-clear 清空按钮（有值才显示），placeholder 改为「搜索文件名、标签、描述」。
6. src/views/dialogs.ts 的空态改两行：说明 + 当前生效条件（搜索词、类型、收藏、标签数、日期、评分），按钮「清除筛选，保留搜索词」（仅当同时有搜索词和筛选）与「清空全部」。
7. src/styles.css 补搜索框清空按钮与空态条件行的样式，遵循现有 token。

C. 可选（有余量再做，做不完留到后续步骤）
8. 合并语义搜索入口：去掉折叠层里的 #semantic-search-input，在搜索框内加 ✦ 切换按钮；普通模式写 state.search，AI 模式走现有 commitSemanticSearch；切换时清空对方条件并给出明确的视觉态。

## 约束
- 除 A 部分的查询条件外不改 Rust；不改 MediaQuery DTO 字段（本步不做「命中来源」）。
- 不引入 FTS / 向量检索 / 新依赖。
- 不碰虚拟滚动与卡片节点池；不重置滚动位置以外的渲染行为。
- 输入防抖不要用 lodash 等库，手写 setTimeout。
- TS strict，禁止 any；Rust 保持现有错误处理与格式化。
- 文案中文。

## 验收
- 输入后 250ms 自动出结果；快速连续输入无旧结果闪回。
- 文件名 / 用户标签 / AI 标签 / AI 描述四类都能命中（有数据时）。
- 输入过程视图不跳顶；改筛选条件仍回顶部。
- 空态能说明当前条件并给出两条出路。
- cargo test / pnpm test / pnpm lint / pnpm build 全绿。

## 交付方式
先给改动清单（文件 + 函数 + SQL 片段），再改代码；最后报告测试结果、手动验证步骤，以及是否有性能顾虑。
```

---

## 7. 风险与回滚

| 风险                     | 表现                       | 处理                                                                                                                    |
| ------------------------ | -------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| 四路 OR 让查询变慢       | 大库搜索卡顿               | 先量：`EXPLAIN QUERY PLAN` 看是否全表扫；个人库万级通常无感。若超 300ms，再加 `tags(name)` 的覆盖与 `media_ai` 条件前置 |
| 防抖与 token 竞争        | 结果闪回旧数据             | 只保留最后一个定时器；`mediaQueryToken` 已能丢弃过期响应，不要另建标记                                                  |
| 实时搜索触发大量刷新     | CPU 占用、缩略图队列被打断 | 输入暂停才发；`refreshMedia` 复用现有节流，不要额外 `render()`                                                          |
| 语义搜索合并引入两套条件 | AI 说没有、SQL 说有        | 若做 3.4，切换模式必须清空对方条件                                                                                      |
| 回滚                     | 低                         | 后端一处条件、前端一处绑定，可分别回滚；DTO 未变，无兼容问题                                                            |
