# Camlib 样式与体验打磨计划

> 状态：计划稿（未实施）  
> 范围依据：用户确认的 8 项改动 + 明确不做项  
> 关联文档：`docs/usability-dev-sessions.md`（原则与延后项）、`docs/requirements.md`、`docs/development-notes.md`（设置/command 合约）

## 1. 目标

在**不改动业务安全语义、不重写扫描/备份核心**的前提下，提升日常浏览与整理的观感与手感。每项可独立验收，按阶段提交，避免一次大改。

## 2. 明确不做（本轮）

| 项 | 原因 |
| --- | --- |
| **预览舞台样式** | 用户确认当前预览（浅玻璃壳 + 媒体舞台）没问题，**不改布局、不改深色舞台** |
| 暗色模式以外的主题体系 | 不做多套自定义主题，只做 light / dark |
| 虚拟列表（完整窗口化） | 本轮先做无限滚动；虚拟列表列为可选增强，不阻塞主线 |
| 减弱透明度 / 性能模式 | 不在本轮范围 |
| 备份/扫描业务逻辑 | 不碰 |

## 3. 设计原则

1. **浅色为默认**，深色为可切换主题；切换不重建索引、不丢筛选。
2. **强调色统一为金色**（收藏、高分评分、少量 active 态）；其余保持中性灰阶 + 玻璃材质。
3. **反馈分层**：成功类 toast 自动消失；错误/警告/断盘类常驻直到处理。
4. **文案一套真相**：设置分区名以 `SETTINGS_SECTIONS` 为准，头图副标题不得另起一套叫法。
5. **Rust 仍是偏好边界**：主题等 UI 偏好走 `app_settings` / `set_ui_prefs`，禁止 `localStorage`。

## 4. 范围总览

| ID | 主题 | 类型 | 依赖 |
| --- | --- | --- | --- |
| P1 | 缩略图骨架屏 | 前端 CSS/TS | 无 |
| P2 | 无限滚动（加载更多） | 前端 | 无 |
| P3 | 工具栏收敛一档 | 前端 | 无 |
| P4 | 成功提示自动消失 | 前端 | 无 |
| P5 | 视频卡片时长 | 前端（字段已有） | 无 |
| P6 | 评分 SVG + 金色强调 | 前端 CSS/TS | 无 |
| P7 | 设置分区文案一致 | 前端文案 | 无 |
| P8 | 深色模式 + 双入口切换 | 前端 + Rust 设置 | 建议在 P6 token 抽取后 |

推荐实施顺序：**P7 → P4 → P1 → P5 → P6 → P3 → P2 → P8**  
（先零风险文案与反馈，再视觉，再布局与数据加载，最后主题。）

---

## 5. 分项说明

### P7 — 设置分区文案一致（最优先，纯文案）

**现状**

- 导航：`媒体库 / 扫描与索引 / 缩略图 / 备份默认 / 系统 / 关于`（`SETTINGS_SECTIONS`）
- 设置头图副标题：`库状态 · 索引 · 缩略图 · 备份 · 查看与系统 · 关于`（另一套叫法）

**目标**

头图副标题与导航标签**逐词一致**，只展示导航用名。

**改动**

| 文件 | 内容 |
| --- | --- |
| `src/main.ts` `renderSettingsPanel` | 副标题改为由 `SETTINGS_SECTIONS.map(s => s.label).join(" · ")` 生成，禁止手写字符串 |
| `src/main.ts` `renderSettingsSystemSection` | 卡片标题「查看偏好」可保留；若出现与导航冲突的别名，统一为「系统」下的子标题 |

**验收**

- 打开设置：头图副标题 = 左侧导航六项顺序与用词完全相同。
- 无其它界面再出现「查看与系统」等别名（可全文检索）。

---

### P4 — 成功提示自动消失；错误类常驻

**现状**

- `showTransientNotice` 插入 `#batch-notice`，需手动点「关闭」。
- 错误横幅（`notice-banner.is-error` / `state.error`）与成功共用较重样式，用户难区分「看完即可」与「必须处理」。

**目标**

| 类型 | 行为 |
| --- | --- |
| 成功 / 批量结果 | 自动消失，默认 **3000ms**（区间 2.5–3.5s）；保留手动关闭 |
| 信息（如「正在查看新导入」） | 可自动消失 **4000ms**，或保持当前常驻——建议本轮成功类才自动关 |
| 错误 / 警告 / 断盘 / 删除失败 | **不自动消失**；提供明确关闭或操作按钮 |

**改动**

| 文件 | 内容 |
| --- | --- |
| `src/main.ts` `showTransientNotice` | 增加 `kind: "success" \| "error"`（默认 success）；success 时 `setTimeout` 移除，清理 timer，避免连续提示叠多个 timer |
| `src/styles.css` | toast 可加轻量入场动画；错误类保持现有 warning/error 视觉 |
| 调用点 | 批量收藏/标签/评分成功走 auto-dismiss；`state.error` 渲染路径不要挂自动消失 |

**实现要点**

- 同一时间只保留一条成功 toast：插入前移除旧节点并 `clearTimeout`。
- 定时器 id 存在模块变量，不依赖 DOM。
- `prefers-reduced-motion` 下跳过动画，计时仍生效。

**验收**

- 批量收藏成功 → 约 3s 后横幅消失，无需点击。
- 人为触发错误（如库断开时删除）→ 横幅常驻。
- 连续两次批量操作 → 只显示后一条，无残留节点。

---

### P1 — 缩略图骨架屏

**现状**

- 卡片 `card-preview` 在未出图时渲染 `<span class="preview-loading">加载预览</span>`。
- 失败重试路径也会重新插入 `preview-loading` 文字。
- 视频未加载时为 play 占位，可保留。

**目标**

未出图时显示**与最终缩略图同比例的 shimmer 骨架**，不再用一屏文字。

**改动**

| 文件 | 内容 |
| --- | --- |
| `src/styles.css` | 新增 `.preview-skeleton`（`aspect-ratio` 与 `.card-preview` 一致或铺满）+ `@keyframes skeleton-shimmer`；浅/深主题下使用 token |
| `src/main.ts` `renderCard` | 照片/实况默认骨架；视频仍可用 play 占位（或骨架 + 半透明 play） |
| `src/main.ts` 缩略图成功路径 | 出图后移除骨架节点（现有逻辑已 remove `.preview-loading`，同步扩展选择器） |
| 失败重试插入逻辑（约 3549 行附近） | 改为插入骨架或「预览不可用 + 重试」按钮，**禁止**再写「加载预览」文案 |

**视觉规格（浅色默认）**

- 底色：`rgba(0,0,0,.06)` 级中性灰（沿用现卡片预览底）。
- 高光：线性渐变缓慢横扫，时长约 `1.2s` 循环。
- 圆角与 `.card-preview` 一致（桌面约 18px/12px）。
- 无文案；不抢 hover 上的操作按钮层。

**验收**

- 冷启动或清缩略图缓存后，网格为骨架而非「加载预览」文字。
- 缩略图就绪后淡入或直接替换，无布局跳动。
- 缩略图失败：可见失败态与可点击重试，不永久卡在骨架。

---

### P5 — 视频卡片时长角标 / meta

**现状**

- `MediaItemDto.durationMs` 已存在，列表查询已带出。
- `renderCard` 的 `card-meta` 仅显示日期、大小、评分星，**未显示时长**。
- 预览元数据面板已用 `formatDuration`。

**目标**

视频（及带时长的实况）在网格卡片上可读时长。

**展示方案（二选一，实现取 A）**

| 方案 | 说明 |
| --- | --- |
| **A（推荐）预览区角标** | 右下角玻璃小胶囊 `mm:ss`，与左侧 kind-badge 对称；暗底白字，不挡操作按钮 |
| B meta 行 | 在 `card-meta` 增加时长 span，信息层更挤，大库扫读弱 |

**改动**

| 文件 | 内容 |
| --- | --- |
| `src/main.ts` | 抽出/复用 `formatDuration`；`renderCard` 在 `durationMs > 0` 时输出 `.duration-badge` |
| `src/styles.css` | `.duration-badge` 定位在 `card-preview` 右下；与 `.card-actions` 层级协调（角标 z-index 低于操作按钮） |
| 深色模式 | 角标 token 随主题，对比度达标 |

**格式**

- `< 10min`：`m:ss` 或 `mm:ss`（统一 `mm:ss`，例如 `0:45`、`3:07`）
- `≥ 10min`：`mm:ss` 即可；不强制小时，除非 `durationMs ≥ 3600000` 时用 `h:mm:ss`

**验收**

- 视频卡可见时长；照片卡无角标。
- 预览切换、收藏刷新后角标仍在。
- 小密度（density=1）下角标不溢出圆角。

---

### P6 — 评分视觉：统一 SVG + 金色强调色

**现状**

- 卡片评分：文本 `"★".repeat(rating)` + `.card-rating { color:#c9a227 }`
- 预览/批量：部分仍是字符 ★（`renderStars`、批量评分 `<option>★</option>` 可暂留 option 文本）
- 收藏按钮：白描边/填充，**未**使用金色强调
- 界面整体无单一 accent token

**目标**

1. 所有**可见星标控件/展示**使用与收藏同一套 SVG path（与 `.icon-star-*` 一致）。
2. 定义 **`--accent`（金色）**，贯穿：
   - 已收藏（卡片与预览工具）
   - 卡片已评分星
   - 预览内星级选中态
   - 筛选中「收藏」chip、评分相关 active 的轻量点缀（勿整屏金色）
3. 中性交互（hover 白玻璃、选中黑环）保持不变，避免与 accent 抢视线。

**建议 token（浅色）**

```css
:root {
  --accent: #c9a227;
  --accent-soft: rgba(201, 162, 39, .16);
  --accent-ink: #8a6d12; /* 金色文字在浅底上的可读变体 */
}
```

深色模式下调整为更亮的金，保证对比度。

**改动**

| 文件 | 内容 |
| --- | --- |
| `src/main.ts` | 新增 `starsHtml(rating, { interactive?, mediaId? })` 输出 SVG；卡片 `card-rating`、`renderStars` 共用；收藏按钮在 `is-favorite` 时使用 accent 填充/描边 |
| `src/styles.css` | `--accent` 等变量；`.card-rating` / `.star-button.is-filled` / `.card-favorite.is-favorite` / `.filter-chip#favorite-filter.is-active` 等改用 accent；删除重复的硬编码金色 |
| 批量评分 select | option 可继续用文字星，不影响展示层统一 |

**验收**

- 网格星、预览星形状一致（同一 SVG）。
- 收藏与高分呈现同一金色语言。
- 黑白/灰阶的主操作（删除确认等）不被染成金色。
- 全文检索无残留的第二套星色。

---

### P3 — 工具栏再收一档

**现状**

`sticky-controls` 常驻：类型 chip（全部/照片/视频/实况/收藏/连拍）+ 标签 chip（最多 12 + 管理）+ 日期区间 + 预设 + 评分 select + 排序 + 密度滑条 +（选中时）批量条。

标签一多时 sticky 区变高，遮挡网格。

**目标**

默认工具栏**一行为主**的「主筛选 + 筛选入口」；次级筛选折叠，有生效项时露出摘要。

**信息架构**

```
[全部|照片|视频|实况|收藏|连拍]  [筛选 (n)]  ······  [排序 ▾] [密度]
         └ 展开后第二行/浮层：
            标签 chips · 日期从到 · 预设 · 评分 · 清除全部
```

| 状态 | 显示 |
| --- | --- |
| 折叠且无次级条件 | 仅主 chip + 「筛选」按钮 |
| 折叠但有次级条件 | 「筛选 (n)」或「筛选 · 标签×2 日期」+ 醒目「清除」 |
| 展开 | 显示标签、日期区间、评分；主 chip 仍在 |

**改动**

| 文件 | 内容 |
| --- | --- |
| `src/main.ts` state | 增加 `filtersExpanded: boolean`（默认 false）；不必持久化（可选后续进 ui prefs） |
| `renderKindFilters` / 工具栏渲染 | 拆 `renderPrimaryFilters` 与 `renderAdvancedFilters`；增加 `#toggle-advanced-filters` |
| 摘要 | `hasAnyFilter` 时折叠态显示已生效条件计数；`#clear-all-filters` 逻辑复用 |
| `src/styles.css` | 展开区动画/布局；折叠时 toolbar 高度收敛；sticky 总高度有上限（必要时次级区内部滚动） |

**交互细节**

- 点「筛选」切换展开；展开时按钮 `aria-expanded=true`。
- 展开不影响已选标签/日期/评分的查询结果。
- 窄屏（≤720px）：默认仍折叠；展开可改为纵向排布。
- 批量选择条：仍为独立一行，不塞进「筛选」折叠。

**验收**

- 无次级条件时，sticky 明显变矮，网格可视区增大。
- 设标签筛选后折叠，摘要仍能看出「筛选已生效」，一键清除可恢复全库。
- 切换类型主 chip 行为与现状一致（仍替换收藏/连拍等互斥规则）。

---

### P2 — 「加载更多」→ 无限滚动

**现状**

- 分页 `limit: 120`，底部按钮 `#load-more`。
- 切换筛选会 `refreshMedia` 重置页；已有 `mediaQueryToken` 防串页。
- 缩略图用 IntersectionObserver；列表分页无自动加载。

**目标**

滚动接近内容区底部时自动加载下一页；保留明确的加载中 / 无更多 / 失败重试状态。  
**不做**完整虚拟列表（见可选增强）。

**改动**

| 文件 | 内容 |
| --- | --- |
| `src/main.ts` | 增加 `loadMoreInFlight` / `loadMoreError`；`loadMore` 幂等（在飞或无下一页则 return） |
| `render()` 媒体区 | 移除或降级为视觉哨兵的按钮；改为 `.load-more-sentinel`（空节点或「正在加载更多…」） |
| 观察器 | 对 sentinel 使用 IntersectionObserver（`root: .content`, `rootMargin: 200px`），触发 `loadMore` |
| 无更多 | `items.length >= total` 时隐藏 sentinel，可选显示淡色「已显示全部 N 项」 |
| 失败 | sentinel 区显示错误 + 「重试」按钮；错误常驻 |
| 滚动位置 | 保持现有 `render()` 恢复 scrollTop；追加页应 **append** 而非整页替换时的闪烁——若当前 `loadMore` 已 append DOM 则只接好观察器；若整树重建，需保证骨架/已加载图尽量不闪 |

**注意**

- 筛选变更时必须重置 observer 与 in-flight，防止旧查询页尾追加进新结果（已有 token，observer 回调里校验 token）。
- 设置/预览打开时，content 可能仍滚动：回调里若 modal 打开可忽略或仍允许（预览在上层无妨）。
- 保留键盘可达：sentinel 内若保留隐藏按钮，`Tab` 应能聚焦「加载更多」作为后备。

**验收**

- 结果 >120 时，滚到底自动加载下一页，无需点击。
- 切换日期筛选中途自动加载不会把旧页数据混进来。
- 加载失败可重试；成功后可继续滚动。
- 加载完全部后不再发 query。

**可选增强（不阻塞本轮）**

- 简单虚拟列表 / 窗口化：仅当日分组 + 卡片高度相对稳定时评估；先测 5k+ 项滚动性能。
- 若虚拟化成本高，可改为「只保留最近 X 页 DOM」的回收策略作为折中。

---

### P8 — 深色模式 + 双入口切换

**现状**

- 样式全局浅色：`#f4f4f4` / 白玻璃 / `--ink: #111`。
- 部分颜色已变量，大量仍硬编码。
- UI 偏好：`ui_density` / `ui_sort` / `ui_preview_mode` 已走 Rust `set_ui_prefs`。
- **无** theme 字段；约束禁止 `localStorage`。

**目标**

1. 支持 **light（默认）/ dark**。
2. **主界面一键切换**（侧栏品牌区或 footer 的主题按钮）。
3. **设置页「系统」分区**可切换（下拉或分段控件），与主界面状态同步。
4. 重启后恢复上次选择；与密度/排序同一持久化通道。

**主题策略**

| 模式 | 表现 |
| --- | --- |
| `light` | 维持当前浅玻璃观感（允许仅变量替换，视觉等价） |
| `dark` | 深灰底 + 深色半透明玻璃 + 提高边框/文字对比；缩略图区域底色更深以衬照片 |
| `system` | **本轮可不做**；若做，跟随 `prefers-color-scheme`，按钮显示当前实际生效主题 |

**建议实施步骤**

1. **Token 抽取（CSS）**  
   将背景、墨色、muted、玻璃、边框、阴影、accent、danger 等收敛到 `:root` 与 `[data-theme="dark"]`。  
   预览 modal / 沉浸模式：保持既有媒体舞台逻辑，仅让 chrome（caption、按钮、meta 面板）适配 dark；**不按早期意见改舞台为深色——舞台策略仍以当前用户确认为准**，dark 主题下 chrome 变深即可。

2. **Rust：`ui_theme`**  
   - `AppSettings` / `DiskSettings` 增加 `ui_theme: UiTheme`（`Light` | `Dark`，默认 `Light`）。  
   - `set_ui_prefs` 增加 `ui_theme: Option<String>`，校验非法值。  
   - 兼容：旧 settings JSON 缺字段时默认 light，不报错。  
   - 更新 `infrastructure` 单测。

3. **前端 API**  
   - `UiTheme` 类型；`AppSettings.ui_theme`；`setUiPrefs({ uiTheme })`。  
   - bootstrap 时读 `getInfrastructureState` → `document.documentElement.dataset.theme = ...`。  
   - 切换：写 Rust → 立即改 `data-theme` → 可选轻量 `render()` 或只换 CSS（优先只换 CSS + 需要时 `syncLiquidGlass`）。

4. **UI 双入口**  
   | 入口 | 位置 | 形式 |
   | --- | --- | --- |
   | 主界面 | 侧栏 `.sidebar-footer` 或品牌区 | 图标按钮：浅色显示月亮/太阳语义，`title`/`aria-label` 如「切换到深色模式」 |
   | 设置 | `renderSettingsSystemSection`「查看偏好」 | `select` 或分段「浅色 / 深色」+ 与预览模式类似的保存或即时保存（建议**即时保存**，减少一步） |

5. **组件级 dark 适配清单（验收用）**  
   侧栏、顶栏、搜索框、sticky 工具栏、媒体卡、选择条、通知/扫描横幅、备份面板、删除确认、标签管理、设置面板、预览 chrome、骨架屏、空状态、titlebar 按钮 hover。

**验收**

- 默认首次安装为浅色，与当前观感一致（回归）。
- 侧栏按钮切换后全 UI 立即变暗/变亮，无大面积白块残留。
- 设置页切换与侧栏切换状态一致。
- 重启应用主题保持。
- 浅/深下：正文对比度可读、危险操作仍可辨、金色 accent 仍可见、骨架 shimmer 可见。
- `pnpm build` + `cargo test`（含 settings 持久化）通过。

---

## 6. 设计 Token 草案（P6/P8 共用）

```css
:root {
  /* surfaces */
  --bg: #f4f4f4;
  --surface: rgba(255,255,255,.46);
  --surface-strong: rgba(255,255,255,.72);
  --border: rgba(255,255,255,.78);
  --ink: #111111;
  --muted: #6b6b6b;
  --faint: #9a9a9a;
  /* accent */
  --accent: #c9a227;
  --accent-soft: rgba(201,162,39,.16);
  /* semantic */
  --danger: #6b1515;
  --success: #1f6b3a;
  --warning: #8a5a12;
  --shadow: 0 20px 50px rgba(0,0,0,.08);
}

[data-theme="dark"] {
  --bg: #121212;
  --surface: rgba(28,28,30,.72);
  --surface-strong: rgba(40,40,42,.88);
  --border: rgba(255,255,255,.12);
  --ink: #f2f2f2;
  --muted: #a0a0a0;
  --faint: #6e6e6e;
  --accent: #e0b84a;
  --accent-soft: rgba(224,184,74,.2);
  --danger: #f0a0a0;
  --success: #7dcea0;
  --warning: #e0c07a;
  --shadow: 0 20px 50px rgba(0,0,0,.45);
}
```

说明：P8 落地时把现有硬编码值迁入 token；允许分 PR 迁移，但**新增组件禁止再写死颜色**。

---

## 7. 建议提交与验收节奏

| 阶段 | 内容 | 验收门禁 |
| --- | --- | --- |
| S-A | P7 文案 + P4 toast | 手动；build 通过 |
| S-B | P1 骨架 + P5 时长 | 手动冷缓存；build |
| S-C | P6 SVG/金色 | 手动视觉；build |
| S-D | P3 工具栏收敛 | 手动筛选组合；build |
| S-E | P2 无限滚动 | 手动大页/切筛选；build + 相关逻辑检查 |
| S-F | P8 深色模式 | 手动双入口+重启；`pnpm build` + `cargo test` |

每阶段：

1. 只改本阶段文件清单内内容，不顺手重构。
2. 手动验收清单打钩后再进入下一阶段。
3. 中文提交信息简述「为什么」。

## 8. 风险与缓解

| 风险 | 缓解 |
| --- | --- |
| 无限滚动与 `render()` 全量重建冲突导致闪烁/重复加载 | token 校验；in-flight 锁；优先局部 append |
| 工具栏折叠导致用户「找不到筛选」 | 生效时强制显示计数摘要；筛选按钮常驻可见 |
| 深色模式下玻璃/阴影发脏 | 单独 dark token，不要简单 `filter: invert` |
| 液体玻璃在 dark 下性能/伪影 | dark 适当降低 blur/saturate 或沿用 CSS backdrop，SVG filter 可对 dark 关闭 |
| 视频时长字段偶发 null | 仅 `>0` 时显示，缺省不显示占位「--」以免噪声 |
| 设置序列化兼容 | `ui_theme` 缺省 Light；读写与单测覆盖 |

## 9. 手动验收总清单（全部阶段完成后）

- [ ] 设置头图与导航文案一致  
- [ ] 批量成功 toast ~3s 自动消失；错误常驻  
- [ ] 网格加载无「加载预览」字样，骨架 → 图  
- [ ] 视频卡有时长，照片卡无  
- [ ] 星与收藏为 SVG + 统一金色  
- [ ] 默认工具栏紧凑，筛选可展开且有摘要  
- [ ] 滚动自动加载更多；到底停止；失败可重试  
- [ ] 侧栏与设置均可切换深色；重启保持  
- [ ] **预览舞台样式与改前一致（本项无改动）**  
- [ ] `pnpm build` 通过；涉及 Rust 设置时 `cargo test` 通过  

## 10. 非目标回顾（再次强调）

- 不修改用户确认过的预览舞台设计。  
- 不引入 `localStorage` 持久化业务/UI 偏好。  
- 不在本轮实现完整虚拟列表、多主题商店、系统主题跟随（可后续单开计划）。
