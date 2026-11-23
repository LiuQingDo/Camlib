# 步骤 02 · 筛选可叠加、高亮如实

| 项           | 内容                                                                                                            |
| ------------ | --------------------------------------------------------------------------------------------------------------- |
| 阶段         | P0（产品级 bug）                                                                                                |
| 覆盖诊断编号 | 4.1（并顺带解掉 4.5 的一半：摘要能反映真实条件）                                                                |
| 依赖         | 无。`06 筛选面板化` 依赖本步定下的「筛选即 AND 集合」模型                                                       |
| 预估         | 半个会话（改动量很小，但要想清楚边界）                                                                          |
| 主要文件     | `src/app/bindings/toolbar.ts`、`src/render/toolbar.ts`、`src/lib/filters.ts`（可选）、`src/lib/filters.test.ts` |

---

## 1. 目标

**筛选项是一个可叠加的 AND 集合；chip 的高亮严格等于查询条件。**

- 「只看收藏的视频」＝ 类型=视频 且 收藏=是，可以表达。
- 界面不再撒谎：`state.kind` 参与查询时，类型 chip 必须高亮；反之不高亮。
- 唯一允许的互斥只有一处：`datePrefix`（年/月前缀）与 `dateFrom/dateTo`（区间），因为二者叠加会让标题歧义。

---

## 2. 现状与证据（v0.6.0 已核实）

1. `src/app/bindings/toolbar.ts:51` `setKindFilter()` 里有两行副作用：

   ```ts
   state.kind = (kind || undefined) as MediaKind | undefined;
   state.favoriteOnly = false; // ← 切类型时清掉收藏
   state.burstOnly = false; // ← 切类型时清掉连拍
   ```

   注释写的是「Type tabs replace the whole filter set rather than stacking」——这是有意为之，但它让最自然的组合查询无法表达。

2. `toggleFavoriteOnlyFilter()` / `toggleBurstOnlyFilter()` 互相清空（收藏与连拍互斥），且都**不清 `state.kind`**。于是先点「视频」再点「收藏」：查询条件是 `kind=video AND favoriteOnly=true`，但…

3. `src/render/toolbar.ts:126` 的高亮条件：

   ```ts
   const secondaryActive = state.favoriteOnly || state.burstOnly;
   // 类型 chip：state.kind === filter.value && !secondaryActive
   ```

   `!secondaryActive` 让类型 chip 在收藏/连拍激活时**熄灭**——查询里明明带着 `kind`，界面却装作没带。这就是「界面在撒谎」。

4. 查询侧没有障碍：`currentQueryFields()`（`render/toolbar.ts:34`）同时输出 `kind`、`favoriteOnly`、`burstOnly`，后端 `MediaQueryInput` 支持组合。

5. `clearAllFilters()`（`bindings/toolbar.ts:25`）会清空全部字段，行为正确，不需要改。

---

## 3. 改动清单

| #   | 文件                          | 位置                                                 | 改什么                                                                                                           |
| --- | ----------------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| 1   | `src/app/bindings/toolbar.ts` | `setKindFilter`                                      | 删除 `favoriteOnly = false` / `burstOnly = false` 两行；保留 `state.kind` 赋值与 `refreshMedia()`                |
| 2   | 同上                          | `toggleFavoriteOnlyFilter` / `toggleBurstOnlyFilter` | 取消二者互斥：各自只切换自己。若产品上仍希望「连拍 ⊂ 照片」，交给后端语义，不要在前端互斥                        |
| 3   | `src/render/toolbar.ts`       | `renderPrimaryFilters`                               | 删除 `secondaryActive` 及其对类型 chip 高亮的影响；高亮条件改为 `state.kind === filter.value`                    |
| 4   | `src/lib/filters.ts`          | `secondaryFilterParts`                               | 把 `收藏`/`连拍` 纳入摘要（当前只统计 AI/标签/日期/新导入/评分，导致「筛选 (n)」计数漏项）                       |
| 5   | `src/lib/filters.test.ts`     | 新增用例                                             | 覆盖：`kind+favoriteOnly` 同时为真、`secondaryFilterParts` 能列出收藏与连拍                                      |
| 6   | `src/app/bindings/toolbar.ts` | `selectPrefix` / 日期相关                            | 确认设置 `datePrefix` 时清掉 `dateFrom/dateTo`（保留现状即可，这是唯一合法互斥），并补一行注释说明为什么它是例外 |

---

## 4. 实现要点

1. **不要顺手改查询语义。** 本步只动「前端愿不愿意让你组合」和「高亮是否如实」，`queryMedia` 的参数与后端 SQL 不动。
2. **空结果的解释责任交给后续步骤。** 允许用户组合出 `kind=live AND burstOnly=true` 这种必然为空的筛选；`04` 的空态会说明「是筛选太窄」。本步不做「禁用不可能组合」的猜测逻辑。
3. **摘要要能读出组合。** 例如「视频 · 收藏 · 标签×2」，让用户一眼看出叠加了什么，而不是只显示「筛选 (2)」。
4. **命名对齐。** 收藏/连拍从「secondary tabs」变成「普通 chip」，注释里那句 "exclusive secondary tabs" 要改掉，避免下一个人再把它改回去。
5. **测试优先。** 先补 `filters.test.ts` 的断言，再改实现，防止回归时无从判断。

---

## 5. 验收标准

- [ ] 点「视频」→ 点「收藏」：两者同时高亮，网格只剩收藏的视频，标题计数与结果一致。
- [ ] 先点「收藏」→ 再点「视频」：结果与上一条完全相同（顺序无关）。
- [ ] 点「收藏」再点「收藏」：只取消收藏，类型仍保持「视频」。
- [ ] 「筛选 (n)」的 n 包含收藏/连拍，摘要文案能读出组合。
- [ ] 日期：选年/月前缀后再选区间，前缀被清掉（行为不变，只是明确为唯一例外）。
- [ ] `pnpm test` / `pnpm lint` / `pnpm build` 全绿。
- [ ] 新增测试覆盖组合筛选与摘要计数。

---

## 6. 自包含提示词

```text
你是 Camlib 项目的前端工程师。项目在 D:\code-collect\camlib：
Tauri 2 + Vite + 原生 TypeScript（strict，禁止 any）+ Rust + SQLite，Windows 优先的本地相机媒体库。
渲染是「骨架 + data-region 增量 patch」，筛选状态集中在 src/state.ts 的 state 里。

## 任务
让所有筛选项可叠加（AND），并让 chip 高亮严格等于查询条件。当前存在产品级 bug：界面显示的筛选态与真实查询不一致。

## 已核实的现状
1. src/app/bindings/toolbar.ts 的 setKindFilter()（约 51 行）在设置 state.kind 后，强制 favoriteOnly = false、burstOnly = false，导致「只看收藏的视频」无法表达。
2. 同文件 toggleFavoriteOnlyFilter() / toggleBurstOnlyFilter() 互相清空（收藏与连拍互斥），但都不会清 state.kind。所以先点「视频」再点「收藏」时，查询条件是 kind=video AND favoriteOnly=true。
3. src/render/toolbar.ts 的 renderPrimaryFilters()（约 123 行）用 const secondaryActive = state.favoriteOnly || state.burstOnly，并把类型 chip 的高亮写成 state.kind === filter.value && !secondaryActive —— 于是收藏激活时类型 chip 熄灭，但查询仍带 kind，界面在撒谎。
4. 查询侧没有障碍：currentQueryFields()（src/render/toolbar.ts:34）同时输出 kind / favoriteOnly / burstOnly，后端支持组合。
5. src/lib/filters.ts 的 secondaryFilterParts() 目前只统计 AI 搜索 / 标签 / 日期 / 新导入 / 评分，不含收藏与连拍，导致「筛选 (n)」计数漏项。
6. clearAllFilters()（src/app/bindings/toolbar.ts:25）行为正确，不要改。

## 要做的事
1. setKindFilter：删除对 favoriteOnly / burstOnly 的重置，只保留 state.kind 赋值与 refreshMedia()。
2. toggleFavoriteOnlyFilter / toggleBurstOnlyFilter：取消二者互斥，各自只切换自己。
3. renderPrimaryFilters：删除 secondaryActive 对类型 chip 高亮的影响，高亮条件改为 state.kind === filter.value；同步修改误导性注释（原文说 type tabs 与收藏/连拍互斥）。
4. secondaryFilterParts：把「收藏」「连拍」纳入摘要，使「筛选 (n)」与条件摘要如实反映组合。
5. src/lib/filters.test.ts 补用例：kind+favoriteOnly 同时为真、secondaryFilterParts 能列出收藏与连拍、计数正确。
6. 日期筛选保持唯一例外：设置 datePrefix 时清掉 dateFrom/dateTo（保持现状），加注释说明为什么只有这一对互斥。

## 约束
- 不改后端查询语义，不改 MediaQueryInput 字段，不改 queryMedia。
- 不做「禁用不可能组合」的猜测：允许用户组合出空结果，空态解释交给后续步骤。
- 不碰虚拟滚动与卡片渲染。
- TS strict，禁止 any；文案中文。

## 验收
- 视频 + 收藏 可同时生效且同时高亮；两个点击顺序结果一致。
- 再次点收藏只取消收藏，类型保持。
- 「筛选 (n)」与摘要包含收藏/连拍。
- pnpm test / pnpm lint / pnpm build 全绿。

## 交付方式
先给改动清单（文件 + 函数），再改代码（先补测试再改实现），最后报告测试结果与手动验证步骤。
```

---

## 7. 风险与回滚

| 风险                                       | 表现                     | 处理                                                     |
| ------------------------------------------ | ------------------------ | -------------------------------------------------------- |
| 与 `06 筛选面板化` 冲突                    | 06 会重写主行结构        | 本步只改「逻辑」，不改 DOM 结构，06 直接复用这套状态语义 |
| 用户组合出空结果                           | 抱怨「点了收藏怎么没了」 | 由 `04` 的可解释空态接管；本步不引入新提示               |
| 后端对 `kind + burstOnly` 的处理与预期不同 | 结果数量异常             | 只用现有参数组合验证一次真机查询，不改 SQL               |
| 回滚                                       | 极小                     | 单 commit，回滚后筛选回到互斥行为                        |
