# 步骤 11 · 视觉语言地基：图标 / 字阶 / 对比度 / 圆角

| 项           | 内容                                                                                 |
| ------------ | ------------------------------------------------------------------------------------ |
| 阶段         | P1（品质感，也是后续所有新组件的基准）                                               |
| 覆盖诊断编号 | 11.2 / 11.3 / 11.4 / 11.5                                                            |
| 依赖         | 无。建议在 `12 主题 token` 之前做，12 会复用本步的字阶与图标基线                     |
| 预估         | 1–2 个会话（图标替换机械但量大，建议拆两个 commit）                                  |
| 主要文件     | `src/render/icons.ts`（新建）、`src/render/*.ts`、`src/views/*.ts`、`src/styles.css` |

---

## 1. 目标

这一层不改任何交互，只解决「看起来不精致」的三个根因：

1. **图标从 Unicode 字形换成自绘 SVG。** 现在 `⚙ ⇄ ↻ ⟳ ▦ ☾ ☀ ⌂ ◎ ✦ ✬ ⤢ ‹ › × ✓ ⠿ ▣ ＋ ↓` 混用，不同字体下粗细、基线、视觉重量全不一致——这是 Windows 上最容易被感知为"业余"的一项。
2. **字阶从 10 档杂牌收成 5 档，字重从 8 档收成 4 档。** 现状：`9/10/10.5/11/11.5/12/13/15/16/17/25px`，字重 `520/600/650/720/750/760/800`。`750/760` 这种中间字重在雅黑上会糊成一片；`10px` 在 125% 缩放下不可读。
3. **对比度达标。** `--faint: #9a9a9a` 在 `#f4f4f4` 上约 2.8:1，10px 小字更差，低于 WCAG AA 4.5:1。次级文字下限提到 `#6b6b6b`。

顺带把圆角从 10 档以上收成 4 档 token，为 `12` 的 token 治理铺路。

---

## 2. 现状与证据（v0.6.0 已核实）

- `src/styles.css:4` 字体栈：`Inter, "SF Pro Display", "SF Pro Text", "PingFang SC", "Microsoft YaHei", sans-serif`。
- `:28-30`：`--muted: #6b6b6b`（尚可）、`--faint: #9a9a9a`（不达标）、`--blue: #111111`（等于没有强调色）。
- 字阶实测计数：`11px × 93`、`10px × 57`、`12px × 51`、`13px × 16`、`9px × 6`、`16px × 5`、`11.5px × 5`、`10.5px × 4`、`17px × 3`、`14px × 3`、`25px × 2`、`15px × 2`。
- 字重实测：`700 × 33`、`650 × 27`、`750 × 10`、`600 × 8`、`800 × 5`、`760 × 5`、`720 × 1`、`520 × 1`。
- 圆角实测：`12px × 24`、`10px × 22`、`9px × 20`、`999 × 12`、`8px × 12`、`14px × 11`、`11px × 11`、`17px × 9`、`13px × 6`、`7px × 4`、`6px × 4`、`18px × 4`，另有 `21/27px` 等大值。
- 图标：`src/render/shell.ts`（`⚙ ⇄ ↻ ⟳ ☾ ☀ ▣ ＋`）、`src/render/toolbar.ts`（`▦ ✦ ✬ ⟳`）、`src/views/preview.ts`（`⤢`）、`src/views/ai-chat.ts`、`src/views/editor.ts` 等；星标已有统一范式 `STAR_PATH`（`src/render/grid.ts:12`），可作为图标模块的样板。

---

## 3. 改动清单

### 3.1 图标

| #   | 文件                                                                                                                     | 改什么                                                                                                                                                                                                                                                              |
| --- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `src/render/icons.ts`（新建）                                                                                            | `export function icon(name: IconName, size = 16): string`，内部 `Record<IconName, string>` 存 `path`；统一 `viewBox="0 0 24 24"`、`fill="none"`、`stroke="currentColor"`、`stroke-width="1.5"`、`stroke-linecap="round"`、`aria-hidden="true"`、`focusable="false"` |
| 2   | 同上                                                                                                                     | 首批 20 个：`settings, swap, refresh, scan, grid-density, moon, sun, folder-plus, folder, play, star, star-fill, sparkle, ai-tag, expand, chevron-left, chevron-right, close, check, check-square, drag, disk, plus, arrow-down`                                    |
| 3   | `src/render/shell.ts` / `toolbar.ts` / `views/preview.ts` / `views/ai-chat.ts` / `views/editor.ts` / `views/settings.ts` | 逐个替换 Unicode 图标；按钮内 16px、独立图标按钮 18–20px；纯装饰的 `·`/`—` 保留                                                                                                                                                                                     |
| 4   | `src/styles.css`                                                                                                         | `.icon-button svg` 统一 `width/height` 与 `display:block`；删除靠 `font-size` 控制图标大小的规则                                                                                                                                                                    |

> 替换原则：**不要用图标字体，不要引入 lucide/feather 依赖**。20 条 path 手写可控，且能保证 1.5px 描边在 16px 下不糊。

### 3.2 字阶与字重

| #   | 位置                  | 改什么                                                                                                                                                                                   |
| --- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 5   | `src/styles.css:root` | 新增 `--text-xs: 11px; --text-sm: 12px; --text-base: 14px; --text-lg: 18px; --text-xl: 24px;`；`--weight-regular: 400; --weight-medium: 500; --weight-semibold: 600; --weight-bold: 700` |
| 6   | 全局                  | `9/10/10.5px → 11px`；`11/11.5px → 11px 或 12px`（正文用 12）；`13px → 14px`；`15/16px → 14px 或 18px`；`17px → 18px`；`25px → 24px`                                                     |
| 7   | 全局                  | 字重映射：`520 → 500`、`650 → 600`、`720/750/760 → 700`、`800 → 700`                                                                                                                     |
| 8   | `src/styles.css:4`    | 字体栈去掉 `Inter`（未随应用分发，回退行为因机器而异），改为 `"Segoe UI Variable Text", "Segoe UI", "PingFang SC", "Microsoft YaHei UI", "Microsoft YaHei", sans-serif`                  |
| 9   | `.section-label`      | `10px / 750 / uppercase` → `12px / 600 / 正常大小写`（中文没有大小写，`uppercase` 只影响混排的英文，却让字距异常）                                                                       |

### 3.3 对比度

| #   | 位置                | 改什么                                                                            |
| --- | ------------------- | --------------------------------------------------------------------------------- |
| 10  | `:root`             | `--faint: #9a9a9a → #6f6f6f`（白底约 5.0:1）；深色主题对应值不低于 `#a0a0a0`      |
| 11  | 全仓                | 裸色值 `#8a8a8a` / `#9a9a9a` / `#777` 一律替换为 `var(--faint)` 或 `var(--muted)` |
| 12  | `.day-heading span` | `10px #777` → `11px var(--muted)`                                                 |

### 3.4 圆角

| #   | 位置       | 改什么                                                                                                                                            |
| --- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| 13  | `:root`    | `--radius-shell: 20px; --radius-surface: 14px; --radius-control: 9px; --radius-chip: 999px;`                                                      |
| 14  | 选择器清单 | 面板/卡片/抽屉 → `--radius-surface`；按钮/输入框/下拉 → `--radius-control`；chip/徽标/开关 → `--radius-chip`；主窗口外壳与侧栏 → `--radius-shell` |
| 15  | 同上       | 12/11/10/9/8/7/6 这些中间值逐个并入三档；不再新增自定义圆角                                                                                       |

---

## 4. 实现要点

1. **一次只改一类。** 建议 commit 拆分：① 图标模块 + 替换；② 字阶/字重；③ 对比度 + 圆角。混在一起 review 不动，出问题也不好回滚。
2. **图标尺寸两档就够**：16（按钮内）、20（独立图标按钮）。不要出现 14/17/18/22 混排。
3. **不要给 SVG 加 `width/height` 属性**，用 CSS 控制，便于 `currentColor` 与主题联动。
4. **字阶上移会让部分布局溢出。** 10px→11px、13px→14px 会让固定高度的 chip/按钮变挤；改完必须逐屏检查：侧栏行高、工具栏 chips、卡片 meta、预览底部工具、设置分区标题。
5. **对比度不要只看浅色。** `--faint` 在深色主题下也要 ≥ 4.5:1（深色背景 `#111` 上 `#a0a0a0` 约 6.4:1）。
6. **圆角收敛会让部分面板"变方"**，这是有意的：一致性优先于单点观感。玻璃层的高光（`--glass-specular`）要跟着圆角走，别出现高光溢出。
7. **别顺手改颜色语义**（`--accent` 金色与 `--blue: #111` 的问题留给 `14`），本步只管明度与字号。

---

## 5. 验收标准

- [ ] 全仓搜不到 Unicode 图标字符（`⚙ ⇄ ↻ ⟳ ▦ ☾ ☀ ⌂ ◎ ✦ ✬ ⤢ ‹ › ✓ ⠿ ▣ ＋ ↓`），只剩文案里的中文标点。
- [ ] `src/render/icons.ts` 覆盖所有在用图标，新增图标只改这一个文件。
- [ ] CSS 里不再出现 `9/10/10.5/11.5/13/15/17/25px`；字重只剩 400/500/600/700。
- [ ] `--faint` 在浅色与深色下与背景对比度均 ≥ 4.5:1（用浏览器取色器实测 2 处）。
- [ ] 圆角只剩 4 档 token；`border-radius: 6/7/8/10/11/12/13/17/18px` 不再出现。
- [ ] 逐屏检查无溢出/挤压：侧栏、工具栏、卡片、预览、设置、备份抽屉、AI 面板。
- [ ] `pnpm test` / `pnpm lint` / `pnpm build` 全绿。

---

## 6. 自包含提示词

```text
你是 Camlib 项目的前端工程师。项目在 D:\code-collect\camlib：
Tauri 2 + Vite + 原生 TypeScript（strict，禁止 any）+ Rust + SQLite，Windows 优先的本地相机媒体库。
样式集中在 src/styles.css（约 8800 行），渲染代码在 src/render/ 与 src/views/。

## 任务
统一视觉语言地基：Unicode 图标换自绘 SVG、字阶与字重收敛、对比度达标、圆角收敛为 4 档 token。
本步不改交互与布局结构，只改表现层。

## 已核实的现状
1. 字体栈（styles.css 第 4 行）：Inter, "SF Pro Display", "SF Pro Text", "PingFang SC", "Microsoft YaHei", sans-serif。
2. 颜色变量（约 28-30 行）：--muted: #6b6b6b；--faint: #9a9a9a；--blue: #111111。
3. 字阶实测：11px×93、10px×57、12px×51、13px×16、9px×6、16px×5、11.5px×5、17px×3、14px×3、25px×2、15px×2、10.5px×4。
4. 字重实测：700×33、650×27、750×10、600×8、800×5、760×5、720×1、520×1。
5. 圆角实测：12px×24、10px×22、9px×20、999×12、8px×12、14px×11、11px×11、17px×9、13px×6、7px×4、6px×4、18px×4，另有 21/27px。
6. Unicode 图标散落在 src/render/shell.ts（⚙ ⇄ ↻ ⟳ ☾ ☀ ▣ ＋）、src/render/toolbar.ts（▦ ✦ ✬）、src/views/preview.ts（⤢）、src/views/ai-chat.ts、src/views/editor.ts、src/views/settings.ts 等。
7. 已有统一 SVG 范式：src/render/grid.ts:12 的 STAR_PATH（viewBox 0 0 24 24，stroke 1.7）。

## 要做的事
A. 图标
1. 新建 src/render/icons.ts：icon(name, size = 16) 返回 <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">…</svg>；path 存 Record<IconName, string>。
2. 首批 20+ 个：settings / swap / refresh / scan / grid-density / moon / sun / folder-plus / folder / play / star / star-fill / sparkle / ai-tag / expand / chevron-left / chevron-right / close / check / check-square / drag / disk / plus / arrow-down。
3. 替换所有 Unicode 图标：按钮内 16px，独立图标按钮 20px；不要用图标字体，不要引入第三方图标库。纯装饰符号（·、—）保留。
4. src/styles.css 统一 .icon-button svg 的尺寸与 display，删除用 font-size 控制图标大小的规则。

B. 字阶与字重
5. :root 增加 --text-xs:11px / --text-sm:12px / --text-base:14px / --text-lg:18px / --text-xl:24px；--weight-regular:400 / medium:500 / semibold:600 / bold:700。
6. 全局映射：9/10/10.5px→11px；11/11.5px→11 或 12（正文用 12）；13px→14px；15/16px→14 或 18；17px→18px；25px→24px。
7. 字重：520→500、650→600、720/750/760→700、800→700。
8. 字体栈去掉 Inter，改为 "Segoe UI Variable Text", "Segoe UI", "PingFang SC", "Microsoft YaHei UI", "Microsoft YaHei", sans-serif。
9. .section-label 从 10px/750/uppercase 改为 12px/600/正常大小写。

C. 对比度
10. --faint 从 #9a9a9a 改为 #6f6f6f；深色主题对应值不低于 #a0a0a0。
11. 裸色值 #8a8a8a / #9a9a9a / #777 全部替换为 var(--faint) 或 var(--muted)；.day-heading span 从 10px #777 改为 11px var(--muted)。

D. 圆角
12. :root 增加 --radius-shell:20px / --radius-surface:14px / --radius-control:9px / --radius-chip:999px。
13. 按角色替换：面板/卡片/抽屉 → surface；按钮/输入框/下拉 → control；chip/徽标/开关 → chip；外壳/侧栏 → shell。中间值 6/7/8/10/11/12/13/17/18px 全部并入四档，不再新增自定义圆角。

## 约束
- 不改任何交互逻辑、DOM 结构、布局尺寸（除字号上移带来的必要微调）。
- 不改颜色语义（--accent / --blue 留给后续步骤）。
- 不引入依赖；不整体重写 styles.css，按规则增量替换。
- 图标不写死 width/height 属性，用 CSS 控制。
- TS strict，禁止 any。

## 验收
- 全仓搜不到上述 Unicode 图标字符。
- CSS 不再出现 9/10/10.5/11.5/13/15/17/25px 与 520/650/720/750/760/800 字重。
- --faint 在浅色与深色下对比度均 ≥ 4.5:1（实测 2 处）。
- 圆角只剩 4 档 token。
- 逐屏无溢出：侧栏、工具栏、卡片、预览、设置、备份抽屉、AI 面板。
- pnpm test / pnpm lint / pnpm build 全绿。

## 交付方式
先给改动清单（新文件 + 替换范围 + 映射表），建议按 A/B/C/D 四块分别提交；最后报告三绿结果与逐屏检查记录。
```

---

## 7. 风险与回滚

| 风险                   | 表现                    | 处理                                                                                |
| ---------------------- | ----------------------- | ----------------------------------------------------------------------------------- |
| 字号上移导致布局溢出   | chip 换行、按钮文字截断 | 逐屏检查清单固定为 7 处；必要时只调 `padding`，不回退字号                           |
| 图标手绘不一致         | 粗细/圆角风格不齐       | 统一 24 网格、1.5 描边、圆头端点；先画 5 个核心图标定调，再批量                     |
| 字体栈改动导致宽度变化 | 文案换行位置全变        | 优先 `Segoe UI Variable`（Win11）→ `Segoe UI`（Win10）；在两种系统各看一屏          |
| 圆角收敛让面板变"硬"   | 观感退化                | 只动 token 映射，不改阴影；若某容器确实需要更大圆角，用 `--radius-shell` 而不是新值 |
| 回滚                   | 低                      | 四块独立 commit，可按块回滚                                                         |
