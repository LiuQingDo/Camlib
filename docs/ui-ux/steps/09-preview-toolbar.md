# 步骤 09 · 预览器工具与手势收敛

| 项           | 内容                                                                                                  |
| ------------ | ----------------------------------------------------------------------------------------------------- |
| 阶段         | P1                                                                                                    |
| 覆盖诊断编号 | 6.1 / 6.2 / 6.3 / 6.4 / 6.5 / 6.6 / 6.7                                                               |
| 依赖         | `01`（完成/失败提示）、`05`（焦点与 Esc 统一）                                                        |
| 预估         | 1–2 个会话（建议拆：① 工具栏与信息面板；② 手势与计数）                                                |
| 主要文件     | `src/views/preview.ts`、`src/app/bindings/preview.ts`、`src/app/bindings/global.ts`、`src/styles.css` |

---

## 1. 目标

预览器是这套产品能力最强、也最"概念重复"的一块。本步只做**收敛**，不加新能力：

| 现在                                                        | 改成                                                                              |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `信息 / 全屏 / 沉浸 / 打开文件夹` + 头部 `⤢`                | `信息 / 专注视图 / 编辑 / 在文件夹中显示`（`⤢` 移入信息面板）                     |
| 「全屏」与「沉浸」两套放大模式                              | 一个「专注视图」：隐藏左右栏与顶栏，`Esc`/再点退出                                |
| 信息面板默认关闭，开关叫「信息」                            | ≥1200px 默认展开；窄屏改为底部抽屉；首次打开有一次"面板可收起"提示                |
| 滚轮 = 缩放（无条件）                                       | 滚轮 = 上一张/下一张；`Ctrl+滚轮` = 缩放；双击 = 1:1 ↔ 适配；当前比例以 chip 显示 |
| 计数用 `state.page.items.length`，标题用 `page.total`       | 统一用 `total`；接近页尾自动预取下一页，`→` 不回到第一张                          |
| 底部提示 6 条、窄于 900px 直接 `display:none`、两处文案矛盾 | 只留 2 条（`← →` 切换、`Esc` 关闭）+ 一个 `?` 入口；文案单一来源                  |
| 实况照片要"点 / 按 L / 长按"                                | 首帧叠 `LIVE` 角标，点击即播，保留长按                                            |

编辑器从"叠加的第二个弹窗"改为预览内的模式切换，工作量明显大于其余项——列为**可选子任务**，做不完留到 `14`。

---

## 2. 现状与证据（v0.6.0 已核实）

- `src/views/preview.ts:348-351` 底部工具：`#preview-info-toggle`（信息）、`#preview-fullscreen`（全屏）、`#preview-immersive`（沉浸）、`#preview-open-folder`（打开文件夹）。
- 同文件 `:338` 头部还有 `#preview-fit`（`⤢`，"按媒体尺寸自适应弹窗"）。
- `:353` 提示一行 6 条：「← → 切换 · 拖动平移 · Ctrl+滚轮缩放 · F 全屏 · I 信息 · L 实况」；`:453` 与 `:565` 又分别写「滚轮缩放 · 拖动平移 · 双击放大 · F 全屏」与「Ctrl+滚轮缩放」——**同一功能三种说法**。
- `:79` `handlePhotoWheel(event)` 被无条件绑定（`:162` `stage.addEventListener("wheel", handlePhotoWheel, { passive: false })`），滚轮即缩放。
- `:312` 位置计数 `index + 1 / ${state.page.items.length}`；`:338` 的 `position` 同源；而标题区 `page.total` 是真实总数。两者不一致。
- `:341` 信息面板 `.modal-meta`，`aria-hidden` 由 `previewInfoOpen` 控制，默认关闭。
- `:608` 翻页 `(index + delta + items.length) % items.length`——到末页会回到第一页，且不触发加载更多。

---

## 3. 改动清单

| #   | 文件                                                 | 位置               | 改什么                                                                                                                                                                                                                               |
| --- | ---------------------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | `src/views/preview.ts`                               | 底部工具条         | 删除 `#preview-fullscreen` 与 `#preview-immersive`，合为 `#preview-focus`（专注视图，`aria-pressed` 绑定 `state.previewImmersive`）；顺序：信息 / 专注 / 编辑 / 在文件夹中显示                                                       |
| 2   | 同上                                                 | 头部               | `#preview-fit` 从头部移除，改放入信息面板底部（作为"调整窗口到图片尺寸"）                                                                                                                                                            |
| 3   | `src/app/bindings/preview.ts`                        | 全屏/沉浸绑定      | 合并为一个 `toggleFocusMode()`：进入时隐藏 `.modal-header`、`.modal-meta`、底部工具（保留一个浮动退出按钮或 `Esc`）；`F` 键同效                                                                                                      |
| 4   | `src/views/preview.ts`                               | `.modal-meta`      | 初始 `previewInfoOpen` 由窗口宽度决定：`≥1200` 为 true；`<1200` 时面板改为底部抽屉（样式类 `is-drawer`），仍可手动开关                                                                                                               |
| 5   | 同上                                                 | 位置计数           | `:312` 与 `:338` 改用 `state.page.total`；`position` 文案改为 `3 / 120`（total）并在底部工具条显示 `已加载 40 / 120`（仅在未加载完时出现）                                                                                           |
| 6   | `src/views/preview.ts:608`                           | 翻页               | 到达已加载末尾且 `items.length < total` 时先触发一次 `loadMore()`（复用 `media-query` 的加载入口），成功后再移动；失败时 toast 提示，不静默卡住                                                                                      |
| 7   | `src/views/preview.ts:79`                            | `handlePhotoWheel` | 无 `ctrlKey`：`deltaY > 0` → 下一张，`< 0` → 上一张（累计阈值 40 防触控板抖动）；`ctrlKey/metaKey`：走原有缩放逻辑                                                                                                                   |
| 8   | 同上                                                 | 缩放显示           | 缩放后右下角显示比例 chip（`120%`），1.2s 后淡出；`1:1` 时显示 `100%` 并保持常亮直到离开该状态                                                                                                                                       |
| 9   | 同上                                                 | 双击               | 双击在「适配 ↔ 1:1」间切换（现在只有放大），并保持点击位置为缩放中心                                                                                                                                                                 |
| 10  | 同上                                                 | 提示文案           | 抽 `const PREVIEW_HINTS = { base: "← → 切换 · Esc 关闭", focus: "Esc 退出专注", zoom: "Ctrl+滚轮缩放 · 双击 1:1" }`，三处引用同一常量；底部只显示 1 条主提示 + `?` 按钮（`?` 打开完整列表，可先用 `title` 兜底，完整面板在 `14` 做） |
| 11  | 同上                                                 | 实况               | `.card-preview` 与预览舞台首帧叠 `LIVE` 角标（点击即播）；长按保留                                                                                                                                                                   |
| 12  | `src/styles.css`                                     | 追加/删除          | 新增 `.modal-meta.is-drawer`、`.zoom-chip`、`.live-badge`、`.focus-exit`；删除 `#preview-fullscreen` 相关样式                                                                                                                        |
| 13  | （可选）`src/views/editor.ts` + `bindings/editor.ts` | 编辑模式           | 编辑器由独立 overlay 改为预览内 `viewMode: "view" \| "edit"` 切换，工具栏随模式变化；保存后就地替换当前图并 toast。**改动大，若本步时间不够，保留现状并在文档记 TODO**                                                               |

---

## 4. 实现要点

1. **专注视图不是全屏。** 不要调用浏览器 Fullscreen API（Tauri 窗口下体验不一致，且退出路径不可控）。只做「隐藏 chrome + 内容占满」，`Esc` 退出。
2. **滚轮语义要一次性改彻底。** 现在的代码里 `handlePhotoWheel` 只做缩放；改为翻页后，缩放只在 `ctrlKey` 下生效。触控板用户容易误触，加 40px 累计阈值与 120ms 冷却。
3. **信息面板宽度决策用容器宽度，不用 `window.innerWidth`。** 弹窗本身可缩放（`DIALOG_SPECS` 支持拖拽），窗口宽 1400 但弹窗被拖到 900 时，仍应走抽屉。用 `ResizeObserver` 观察 `.preview-modal` 宽度。
4. **计数不要出现两个"总数"。** 用户只需要知道"第几张 / 共几张"。已加载数量只在"还没加载完"时以次要小字出现，避免像第二个总数。
5. **预取不要打乱当前索引。** `loadMore()` 会 append 到 `state.page.items`，索引不变；但要确保 `bumpGridEpoch` 之类不会重建预览外壳（`patchPreviewOverlay` 已有帧签名，确认 append 不会让 `previewFrameKey` 变化导致重载图）。
6. **文案单一来源**：三处 hint 必须引用同一个常量，这是 6.3 的核心；否则下次改文案又会不一致。
7. **`?` 的兜底**：本步先用 `title` 或一个极简浮层列出全部快捷键；完整速查面板留给 `14`。
8. **别动虚拟滚动的相邻预取**：预览的下一张/上一张在已加载列表内即可，不做单独预取。

---

## 5. 验收标准

- [x] 底部工具只有 4 个：信息 / 专注 / 编辑 / 在文件夹中显示；头部不再有 `⤢`。
- [x] 「专注视图」进入后只剩图片与退出入口；`F` 与 `Esc` 行为一致；再次点击按钮可退出。
- [x] 1440px 窗口打开预览，信息面板默认展开；把弹窗拖窄到 900px，面板自动变底部抽屉。
- [x] 滚轮上下 = 上一张/下一张；`Ctrl+滚轮` = 缩放；双击在适配与 1:1 间切换，且以点击点为中心。
- [x] 缩放时出现比例 chip，1.2s 后淡出；1:1 时常亮。
- [x] 位置显示「3 / 120」与标题总数一致；加载未完成时另有「已加载 40 / 120」小字。
- [x] 翻到已加载末尾自动加载下一页并继续，不回到第一张；加载失败有提示。
- [x] 三处快捷键文案完全一致，且窄窗口下主提示仍可见（不再 `display:none`）。
- [x] 实况照片首帧有 `LIVE` 角标，点击即播。
- [x] `pnpm test` / `pnpm lint` / `pnpm build` 全绿。

### 实现备注（v0.6.0 落地）

- **默认弹窗宽度 1180 → 1280**（`DIALOG_SPECS.preview` 与 `.preview-modal` 同步）：断点是 1200，
  按旧的 1180 打开，1440px 窗口也会判成抽屉。历史 profile 里存过更窄尺寸时仍按弹窗宽度走抽屉——
  这是「按容器宽度决策」的正确结果，用户把弹窗拖宽即可恢复侧栏。
- **比例 chip 的百分比 = 显示倍率（相对原始像素）**，不是 transform 倍数：适配态通常 40–60%，
  1:1 才是 100%。`photoZoom.scale` 的 1 仍是 fit-contain，双击时用 `naturalWidth / clientWidth`
  换算出 1:1 所需的倍数，所以「100% 常亮」与「1:1」是同一个状态。
- **窄弹窗首次打开默认收起面板**（展开等于用抽屉盖住主图）；拖窄时不再强改用户已做的选择。
  决策点在 `orchestrate.renderOverlays()` 里 `applyDialogSizes()` 之后调 `bindPreviewLayoutObserver()`，
  此时弹窗宽度已是最终值，不需要等下一帧。
- **滚轮冷却在换图时不重置**（只清累计量），否则触控板的惯性尾巴会在每张图后重新触发一次翻页。
- **编辑器仍在独立 overlay**：`src/app/bindings/overlay.ts` 的 `#preview-edit` 处留了 `TODO(14)`，
  按第 13 项另行处理，本次没有半成品改动。

---

## 6. 自包含提示词

```text
你是 Camlib 项目的前端工程师。项目在 D:\code-collect\camlib：
Tauri 2 + Vite + 原生 TypeScript（strict，禁止 any）+ Rust + SQLite，Windows 优先的本地相机媒体库。
预览器是 #overlay-host 的 [data-overlay="preview"] 槽位，外壳只建一次、换图原地 patch（src/app/orchestrate.ts 的 patchPreviewOverlay）。

## 任务
收敛预览器的工具与手势：合并全屏/沉浸为「专注视图」、信息面板默认展开、滚轮改为翻页、计数统一、快捷键文案统一。

## 已核实的现状
1. src/views/preview.ts 底部工具栏（约 348-351 行）有：#preview-info-toggle（信息）、#preview-fullscreen（全屏）、#preview-immersive（沉浸）、#preview-open-folder（打开文件夹）；头部（约 338 行）还有 #preview-fit（⤢ 自适应弹窗）。
2. 约 353 行的提示一行 6 条「← → 切换 · 拖动平移 · Ctrl+滚轮缩放 · F 全屏 · I 信息 · L 实况」；约 453 行与 565 行又各写一套，其中一处说「滚轮缩放」、另一处说「Ctrl+滚轮缩放」，互相矛盾。
3. handlePhotoWheel（约 79 行）在约 162 行被无条件绑定到 stage 的 wheel 事件，滚轮即缩放。
4. 位置计数在约 312 行与 338 行用 state.page.items.length；而标题区用 page.total，两者不一致。
5. 信息面板 .modal-meta（约 341 行）的 aria-hidden 由 previewInfoOpen 控制，默认关闭。
6. 翻页在约 608 行用 (index + delta + items.length) % items.length，到末尾会回到第一张，也不会触发加载更多。
7. 实况照片目前支持点击 / 按 L / 长按，但首帧没有可见提示。

## 要做的事
1. 工具条重排为 4 个：信息 / 专注（合并全屏+沉浸，绑定 state.previewImmersive，aria-pressed）/ 编辑 / 在文件夹中显示；删除 #preview-fullscreen 和 #preview-immersive；把 #preview-fit 移入信息面板底部。
2. 专注视图 toggleFocusMode()：隐藏 .modal-header、.modal-meta、底部工具，保留一个浮动退出按钮；F 与 Esc 同效；不要调用浏览器 Fullscreen API。
3. 信息面板：用 ResizeObserver 观察 .preview-modal 宽度（不要用 window.innerWidth），≥1200 默认展开；<1200 时加 .is-drawer 变底部抽屉，仍可手动开关。
4. 计数：位置显示改用 state.page.total；加载未完成时在底部工具条显示次要小字「已加载 40 / 120」。
5. 翻页：到达已加载末尾且 items.length < total 时先调用现有的加载更多入口，成功后再移动；失败给 toast，不静默卡住。
6. 滚轮：无修饰键时 deltaY 翻页（累计阈值 40px + 120ms 冷却防触控板抖动）；ctrlKey/metaKey 时走原缩放。
7. 缩放反馈：右下角 .zoom-chip 显示百分比，1.2s 后淡出；100% 时常亮。
8. 双击在「适配 ↔ 1:1」间切换，以点击位置为缩放中心。
9. 提示文案抽成单一常量（如 PREVIEW_HINTS），三处全部引用；底部只显示 1 条主提示 + ? 入口，窄窗口不再 display:none。
10. 实况照片首帧叠 LIVE 角标，点击即播，长按保留。
11. src/styles.css 增删对应样式，沿用现有 token 与动效；prefers-reduced-motion 下取消位移动画。

## 可选子任务（做不完留 TODO，不要半成品）
12. 编辑器从独立 overlay 改为预览内的 viewMode: "view" | "edit" 切换，保存后就地替换当前图并 toast。改动大，若本步时间不够，保留现状并在代码里留明确 TODO 注释。

## 约束
- 不加新能力（不做对比、不做幻灯片播放），只收敛现有。
- 不碰虚拟滚动、缩略图队列；不改 patchPreviewOverlay 的「换图不重建外壳」原则。
- 不引入依赖；TS strict，禁止 any；文案中文且单一来源。

## 验收
- 底部只剩 4 个工具；专注视图可进可出，F/Esc 一致。
- 1440px 默认展开信息面板，拖窄到 900px 自动变抽屉。
- 滚轮翻页、Ctrl+滚轮缩放、双击切换 1:1，比例 chip 正常。
- 位置计数与标题总数一致；到末尾自动加载下一页。
- 三处快捷键文案一致，窄窗口仍可见。
- pnpm test / pnpm lint / pnpm build 全绿。

## 交付方式
先给改动清单（文件 + 函数 + 删除的绑定），再改代码；最后报告三绿结果与鼠标/键盘各一遍的手动验证步骤。
```

---

## 7. 风险与回滚

| 风险                     | 表现               | 处理                                                                    |
| ------------------------ | ------------------ | ----------------------------------------------------------------------- |
| 滚轮改语义用户不适应     | 抱怨"滚一下图变了" | 首次进入预览给一行提示「滚轮切换，Ctrl+滚轮缩放」（一次性，可关闭）     |
| 信息面板默认展开挤压图片 | 小图显示变小       | 面板宽度 300px 上限，主图用 `object-fit: contain`；窄屏走抽屉           |
| 预取下一页与当前索引     | 索引错位、跳图     | 只在"用户主动向后翻"时预取；append 后校验 `previewIndex` 对应的 id 未变 |
| 编辑器改造半途           | 两套入口并存       | 明确列为可选，不做就保留原样，禁止"改一半"                              |
| 回滚                     | 中                 | 拆两个 commit：工具与面板 / 手势与计数                                  |
