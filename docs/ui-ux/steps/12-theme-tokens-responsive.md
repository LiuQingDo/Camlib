# 步骤 12 · 主题 token 治理 + 容器查询响应式 + 去玻璃

| 项           | 内容                                                                                                                                          |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| 阶段         | P1（技术债，决定以后每次改样式的成本）                                                                                                        |
| 覆盖诊断编号 | 11.1 / 12.1 / 12.3 / 12.4                                                                                                                     |
| 依赖         | `11 视觉语言`（字阶、圆角 token、图标已就位，本步不再混着改）                                                                                 |
| 预估         | 2–3 个会话（建议拆：① 玻璃与内容区底色；② token 治理；③ 容器查询 + 侧栏折叠）                                                                 |
| 主要文件     | `src/styles.css`、`src/render/shell.ts`、`src/app/settings-ops.ts`、`src-tauri/src/lib.rs`（UI 偏好）、`scripts/check-css-tokens.mjs`（新建） |

---

## 1. 目标

| 问题               | 现状                                                                                                                                    | 目标                                                                                                                    |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| 深色主题靠补丁     | **472 条** `[data-theme="dark"]` 覆盖规则                                                                                               | 颜色全部走语义 token，dark 只做 token 重映射；补丁 ≤ 80 条（只留阴影/高光等确实无法用变量表达的部分）                   |
| 玻璃层数过多       | **58 处** `backdrop-filter`，侧栏 26px / 吸顶 22px / 搜索 18px / 遮罩 18–22px / 预览 28px，外加 `body::before/after` 两个 44vw 模糊圆斑 | 内容区（网格、预览舞台）改实色中性底；玻璃只保留「侧栏 + 浮层」两类；删除 body 模糊圆斑；`backdrop-filter` 降到 ≤ 12 处 |
| 响应式是"网页降级" | 只有 900/720 两个断点；`≤900px` 直接 `.modal-meta { display:none }`——窄窗口**失去标签/评分编辑能力**                                    | 内容区用容器查询（依 `.content` 宽度）三档；任何宽度下元信息都可编辑                                                    |
| 侧栏固定 272px     | 1366×768 上少一列                                                                                                                       | 可折叠为 64px 图标栏（`Ctrl+\`），偏好持久化                                                                            |

> 这一层的价值不在"更好看"，而在**把后续每次改样式的边际成本降下来**。472 条补丁意味着新增任何组件都要记得写两遍。

---

## 2. 现状与证据（v0.6.0 已核实）

- `src/styles.css`：`[data-theme="dark"]` 出现 **472** 次；`backdrop-filter` 出现 **58** 次。
- `:root` 里混着「原始值」与「语义」：`--bg #f4f4f4`、`--surface rgba(255,255,255,.46)`、`--glass`、`--glass-strong`、`--glass-border`、`--inset`……同一个"面板底色"有 4 个近似变量。
- 断点：`@media (max-width:900px)` 与 `(max-width:720px)` 共 7 处；`3783` 行的 900px 块里 `.modal-meta { display:none }`。
- `--sidebar-w: 272px`，`.sidebar { width: var(--sidebar-w) }`，无折叠态。
- `src/styles.css:2761` 已有 `prefers-reduced-motion` 块（只有 1 条规则，`13.5` 会扩）。

---

## 3. 改动清单

### 12-A 去玻璃（先做，收益最快）

| #   | 位置                                     | 改什么                                                                                                  |
| --- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| 1   | `body::before/after`                     | 删除两个 44vw 模糊圆斑（Windows 核显下是主要掉帧源，且污染照片色感）                                    |
| 2   | `.media-area` / `.media-grid` / 预览舞台 | 改实色中性底 `--surface-canvas`（浅色 `#f7f7f5`，深色 `#0e0e0e`），`backdrop-filter: none`              |
| 3   | `.sticky-controls`                       | 从 22px 玻璃改为「实色 + 1px 底边」，滚动时不再需要 `is-scrolling` 降级（`render/scrolling.ts` 可简化） |
| 4   | 侧栏 / 浮层                              | 保留玻璃，但降到 2 档：`--blur-panel: 18px`、`--blur-overlay: 12px`；其余 4 档删除                      |
| 5   | `src/render/scrolling.ts`                | 若"滚动时关模糊"的逻辑失去意义，删除该分支（保留滚动监听给别的用途前先确认）                            |

### 12-B token 治理

| #   | 位置                                   | 改什么                                                                                                                                                                                        |
| --- | -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 6   | `:root`                                | 定义语义层：`--surface-canvas / --surface-panel / --surface-raised / --surface-inset / --text-primary / --text-secondary / --text-tertiary / --line-soft / --line-strong`，值只引用原始调色板 |
| 7   | `[data-theme="dark"]`                  | 只重映射上述 9 个变量 + 阴影/高光；其余全部删除                                                                                                                                               |
| 8   | 组件规则                               | 把裸色值（`#555`、`#333`、`rgba(255,255,255,.7)` 等）替换为语义变量；同名近似变量合并（`--glass` / `--glass-strong` / `--surface` / `--surface-soft` 收敛）                                   |
| 9   | `scripts/check-css-tokens.mjs`（新建） | 扫描 `styles.css`：`#` 开头的色值（除 `:root` / `[data-theme]` 块）、`rgba(` 字面量出现在非变量行 → 报错并给出行号；接入 `pnpm lint`                                                          |
| 10  | `package.json`                         | `"lint:css": "node scripts/check-css-tokens.mjs"`，并入 `lint`                                                                                                                                |

### 12-C 响应式

| #   | 位置                  | 改什么                                                                                                                                                     |
| --- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 11  | `.content`            | `container-type: inline-size; container-name: content`                                                                                                     |
| 12  | 布局                  | 三档容器查询：`@container content (width < 820px)` 紧凑（侧栏收为图标栏、工具栏换行、卡片 3 列）；`820–1200` 常规；`>1200` 宽屏（信息面板常驻、卡片 5 列） |
| 13  | `.modal-meta`         | 删除 `≤900px { display:none }`；窄容器改成底部抽屉（复用 `09` 的 `.is-drawer`），保证标签/评分始终可编辑                                                   |
| 14  | `@media`              | 只保留窗口级（`.titlebar`、`.shell` 外边距）需要的 900/720；内容布局全部迁到容器查询                                                                       |
| 15  | `.sidebar`            | 增加 `.is-collapsed`（64px，仅图标 + tooltip）；`Ctrl+\` 切换；状态存 `set_ui_prefs`（Rust 已有 UI 偏好通道，不要用 localStorage）                         |
| 16  | `src/render/shell.ts` | 折叠态下隐藏品牌文字、日期树、AI 区块，保留导航图标与底部三个按钮                                                                                          |

---

## 4. 实现要点

1. **先删玻璃，再理 token。** 玻璃是"颜色不透明"的根源——很多深色补丁是为了让半透明表面在深色下也好看。去掉玻璃后，一批补丁会自然失去意义。
2. **token 分两层**：原始调色板（`--gray-900` 这类，可有可无）+ 语义（`--text-secondary`）。组件只允许用语义层。这决定了 472 条补丁能不能真的降到 80。
3. **渐进式治理**：不要一次性重写 8800 行。按「出现频次最高的 20 个选择器」优先，每轮跑脚本看剩余数量，直到达标。
4. **容器查询的陷阱**：`container-type: inline-size` 会让该元素的子元素无法再用 `vh` 做高度相关布局（不影响，但要知道）；`.content` 自身高度仍由 flex 决定。
5. **折叠侧栏不要用 `display:none`**，用宽度过渡 + `overflow:hidden`，避免布局抖动；`prefers-reduced-motion` 下取消过渡。
6. **偏好持久化走 Rust**（`set_ui_prefs` / `get_app_settings` 已有 `ui_theme`、`density`），新增 `sidebar_collapsed` 字段要同步 `development-notes.md` 的 Command 说明。
7. **验收要看帧率**：去玻璃后在 1080p 网格快速滚动，用 DevTools Performance 看是否还有 `Composite Layers` 长任务（原来是主要瓶颈）。

---

## 5. 验收标准

- [ ] `grep -c 'backdrop-filter' src/styles.css` ≤ 12。
- [ ] `grep -c '\[data-theme="dark"\]' src/styles.css` ≤ 80。
- [ ] `pnpm lint:css` 能拦住新增裸色值（故意加一行 `color:#123456` 验证会报错）。
- [ ] 网格与预览舞台在浅色/深色下都是实色底，照片色感不再被玻璃染色。
- [ ] `Ctrl+\` 折叠/展开侧栏；重启应用后状态保留。
- [ ] 窗口宽 900px 时，预览元信息面板仍可打开并编辑标签/评分（底部抽屉）。
- [ ] 内容区宽度 700 / 1000 / 1400 三档下，卡片列数与工具栏布局符合预期，不出现横向滚动。
- [ ] 1080p 快速滚动网格无持续掉帧（主观 + Performance 面板确认）。
- [ ] `pnpm test` / `pnpm lint` / `pnpm build` 全绿。

---

## 6. 自包含提示词

```text
你是 Camlib 项目的前端工程师。项目在 D:\code-collect\camlib：
Tauri 2 + Vite + 原生 TypeScript（strict，禁止 any）+ Rust + SQLite，Windows 优先的本地相机媒体库。
样式集中在 src/styles.css（约 8800 行），滚动优化在 src/render/scrolling.ts，UI 偏好通过 Rust 的 set_ui_prefs 持久化。

## 任务
治理主题 token 与响应式：去玻璃、把 472 条深色补丁收敛为 token 重映射、用容器查询替代网页式断点、侧栏可折叠。

## 已核实的现状
1. src/styles.css 中 [data-theme="dark"] 出现 472 次，backdrop-filter 出现 58 次。
2. :root 混着原始值与语义：--bg #f4f4f4、--surface rgba(255,255,255,.46)、--glass / --glass-strong / --glass-border / --inset 等，同一个"面板底色"有 4 个近似变量。
3. 断点只有 @media (max-width:900px) 与 (max-width:720px)，共 7 处；其中约 3783 行的 900px 块里有 .modal-meta { display:none }，导致窄窗口无法编辑标签/评分。
4. --sidebar-w: 272px，.sidebar 固定宽度，没有折叠态。
5. body::before/after 有两个 44vw 模糊圆斑；侧栏 26px、吸顶 22px、搜索 18px、遮罩 18-22px、预览 28px 五档玻璃。
6. prefers-reduced-motion 已有块（约 2761 行），本步不处理动画（后续步骤）。

## 分三步做，建议每步一个 commit
A. 去玻璃
1. 删除 body::before/after 模糊圆斑。
2. .media-area / .media-grid / 预览舞台改实色中性底（新增 --surface-canvas，浅色约 #f7f7f5、深色约 #0e0e0e），去掉 backdrop-filter。
3. .sticky-controls 改「实色 + 1px 底边」，不再依赖滚动时关模糊；若 src/render/scrolling.ts 的降级分支失去意义，删掉它（先确认没有别的用途）。
4. 玻璃只保留侧栏与浮层，两档：--blur-panel:18px、--blur-overlay:12px；其余档位删除。

B. token 治理
5. :root 定义语义变量：--surface-canvas / --surface-panel / --surface-raised / --surface-inset / --text-primary / --text-secondary / --text-tertiary / --line-soft / --line-strong。
6. [data-theme="dark"] 只重映射这些变量与阴影/高光，其余补丁全部删除（目标 ≤80 条）。
7. 组件规则里的裸色值（#555/#333/rgba(255,255,255,.7) 等）替换为语义变量；合并 --glass / --glass-strong / --surface / --surface-soft 等近似变量。
8. 新建 scripts/check-css-tokens.mjs：扫描 styles.css，:root 与 [data-theme] 块之外的十六进制/ rgba 字面量报错并输出行号；package.json 增加 "lint:css" 并并入 "lint"。
9. 按出现频次最高的 20 个选择器优先处理，每轮跑脚本看剩余数量。

C. 响应式与侧栏
10. .content 设置 container-type: inline-size; container-name: content。
11. 三档容器查询：<820px 紧凑（侧栏收为图标栏、工具栏换行、卡片 3 列）/ 820-1200 常规 / >1200 宽屏（信息面板常驻、5 列）。
12. 删除 .modal-meta 的 display:none，窄容器下改为底部抽屉（复用步骤 09 的 .is-drawer），保证任何宽度都能编辑标签/评分。
13. @media 只保留窗口级需要的 900/720，内容布局全部迁到容器查询。
14. .sidebar 增加 .is-collapsed（64px，图标 + tooltip），Ctrl+\ 切换，状态写入 Rust 的 UI 偏好（新增 sidebar_collapsed 字段），不要用 localStorage；同步更新 docs/development-notes.md 的偏好字段说明。

## 约束
- 不改交互逻辑与业务代码；不动 src/render/virtual.ts 的滚动算法。
- 不整体重写 styles.css，按选择器渐进替换。
- 不引入 CSS 框架 / PostCSS 插件等依赖（校验脚本用 Node 原生）。
- 折叠侧栏用宽度过渡 + overflow:hidden，不用 display:none；prefers-reduced-motion 下取消过渡。
- TS strict，禁止 any。

## 验收
- backdrop-filter ≤12 处；[data-theme="dark"] ≤80 条。
- pnpm lint:css 能拦住新增裸色值（手动加一行验证）。
- 网格与预览舞台为实色底；1080p 快速滚动无明显掉帧。
- 900px 窗口下预览元信息仍可编辑。
- Ctrl+\ 折叠侧栏且重启后保留。
- pnpm test / pnpm lint / pnpm build 全绿。

## 交付方式
先给改动清单与执行顺序（A→B→C），每完成一块报告该块的量化结果（grep 计数），最后给三绿结果与逐项验证记录。
```

---

## 7. 风险与回滚

| 风险                 | 表现                     | 处理                                                           |
| -------------------- | ------------------------ | -------------------------------------------------------------- |
| 去玻璃后"高级感"下降 | 观感变平                 | 用边框 + 阴影 + 留白补偿，不要用回玻璃；玻璃只留在导航与浮层   |
| token 替换漏改       | 深色下某些元素变白底黑字 | 逐屏在深色下过一遍；脚本只查裸色值，语义错配仍需人眼           |
| 容器查询改变列数     | 用户觉得"图变小了"       | 三档阈值按实际最小卡片宽度算（卡片 148px + gap），先量再定     |
| 侧栏折叠与日期树冲突 | 折叠后找不到日期         | 折叠态只留一级导航图标；展开恢复，不做"折叠也能点日期"的中间态 |
| 回滚                 | 低–中                    | A/B/C 三个 commit 分别可回滚；B 回滚后补丁仍在，无功能损失     |
