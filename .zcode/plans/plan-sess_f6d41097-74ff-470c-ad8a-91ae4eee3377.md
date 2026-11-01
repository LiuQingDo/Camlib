# 修复标签不显示 + 标签展示改版

## Context(问题与根因)

**Bug:预览窗口打的标签"第二次打开就看不见"** — 标签其实已保存到 SQLite,问题出在前端缓存:`src/main.ts` 中 `requestPreview()`(main.ts:1084)把整个 `MediaPreviewDto`(含 `meta`)作为 promise 缓存在 `previewAssetCache`(main.ts:773)。手动打标/评分/收藏/AI 打标都只写数据库和 `previewMetaCache`,**从不失效该缓存**,导致关闭预览再打开(或预览打开期间任何全量 `render()` 触发 `loadModalAsset()`)时读到旧 meta,新标签"消失"。AI 打标后 `runAiTagging` 里刷新面板的 `loadModalAsset()` 同样命中旧缓存,所以 AI 描述/标签也可能不显示。

**UI 改版需求**:接入 AI 打标后标签数量会大量增长,预览面板"平铺所有剩余标签"和工具栏"平铺前 12 个标签"都不可扩展,需要改为可搜索的收起式展示。工具栏方案已与用户确认:**热门标签 chips(≤8,按数量排序)+「更多标签 ▾」可搜索下拉面板**。

只改前端:`src/main.ts` + `src/styles.css`,后端持久化逻辑已确认正确,无需改动。

## 1. Bug 修复:预览元数据缓存失效

新增辅助函数 `invalidatePreviewMeta(ids: string[])`(从 `previewAssetCache` 删除对应条目),并在所有改变 meta 的写操作成功后调用:

| 调用点 | 位置(main.ts) | 失效对象 |
|---|---|---|
| `applyPreviewTag` | ~4509 | 当前 item.id |
| `applyPreviewRating` | ~4487 | 当前 mediaId |
| `toggleFavorite` | ~1489 | 当前 id |
| `runAiTagging`(每张处理完后) | ~4153 | 当前处理 id(使末尾 `loadModalAsset()` 拉到新 AI 结果) |
| `applyBatchTag` / `applyBatchRating` | ~1593 / ~1628 | 全部选中 ids |
| 标签管理器重命名/删除 | ~2586 / ~2631 | `previewAssetCache.clear()`(名称/归属全局变化) |

`previewMetaCache` 的就地补丁逻辑保持不变。

## 2. 预览窗口 · 媒体信息「标签」块改版(`renderMetaPanel` ~4387)

- **已附加标签**:chips 保留(带 × 移除),数量多时区块内部限高滚动(新增 CSS max-height + overflow)。
- **替换平铺的 `tag-suggest-row`**:改为单个「+ 添加标签」按钮,点击展开内联选择器:
  - 顶部搜索框 + 可滚动列表(max-height ~200px),行 = 未附加标签,按 `mediaCount` 降序,显示 名称 + 条目数;
  - **搜索用 DOM 级过滤**(输入时对行切换 `hidden`,不重渲染、不丢焦点);
  - 点击行 → 复用现有 `applyPreviewTag(..., "add")`;因面板重渲染,通过模块级状态 `previewTagPickerOpen/previewTagPickerQuery` 保持展开与查询,重渲染后恢复输入焦点;
  - 再点按钮或 Esc 收起。空态文案沿用现有两种(无标签库/已带全部标签)。
- **Escape 处理**:全局 keydown(main.ts:6511)中 `typing` 提前 return 会导致选择器内 Esc 无效——在选择器打开时先于 `typing` 检查拦截 Esc,只关选择器不关预览。
- **AI 描述块的 aiTags chips**:同样加限高滚动防护(不改动数据流)。

## 3. 工具栏标签筛选区改版(`renderAdvancedFilters` ~1799)

标签块(`.filter-group-tags`)改为:
1. **已选标签 chips** 永远内联(复用现有 `data-tag-filter` 点击切换 + `is-active` 样式);
2. 补足到 **最多 8 个**:按 `mediaCount` 降序取未选热门标签;
3. 标签总数超过内联数时显示 **「更多标签 ▾」** 按钮,点开锚定浮层 popover(绝对定位于 `.filter-group-tags`,需将其设为 `position:relative`):
   - 搜索框 + 全量标签滚动列表(名称 + 数量 + AI 徽标),选中行打 ✓ 高亮,点击行切换 `state.tagIds` 后走现有 `refreshMedia()`;
   - 列表过滤同样用 DOM 级 `hidden` 切换;
   - 关闭:点击外部(模块级单次注册的 `document` pointerdown 监听,与 main.ts:6454 的 window keydown 同模式,避免 bindEvents 重复挂载)+ Esc(加入全局 keydown);重渲染后经模块级状态 `tagPopoverOpen/tagPopoverQuery` 保持并恢复焦点;
4. 「管理」按钮保留;折叠态摘要 `标签×N`(`secondaryFilterParts` main.ts:1296)无需改动。

## 4. 样式(`src/styles.css`)

新增 `.tag-picker`(预览内联)与 `.tag-popover`(工具栏浮层)系列:搜索框、列表行、选中态、AI 徽标复用现有 `.ai-badge`/chip 变量(`--tag-chip-bg`、`--chip-hover`、`var(--faint)` 等),补充 dark 主题变体(参照现有 `[data-theme="dark"] .tag-suggest` 等写法)。

## 5. 验证

1. `pnpm build`(tsc + vite)通过;
2. `pnpm tauri dev` 手动验证:
   - 预览中用「+ 添加标签」加标签 → 关闭再打开 → 标签仍在;移除 → 重开确认已移除;
   - 评分/收藏修改后重开预览,信息面板为最新值;
   - 单张「AI 打标」完成后,预览面板立即显示新 AI 描述/标签;
   - 工具栏:热门 chips 一键筛选;「更多标签 ▾」搜索、勾选、外部点击/Esc 关闭;浅色/深色主题下浮层样式正常。