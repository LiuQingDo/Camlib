# 媒体编辑弹窗 UI 面板优化

## Context

媒体编辑弹窗（`renderEditor()`，图片编辑 + 视频剪辑）是 `40b5cc7` 新增的功能，面板存在明显问题：

- **视频面板布局失衡**：`src/styles.css:2552` `.editor-workbench.is-video` 为纵向布局，但 `.editor-tools` 仍是 232px 宽窄列（`src/styles.css:2579`），视频下方左侧一条窄工具栏、右侧大片空白，空间浪费严重。
- **视频剪辑轨道信息不足**：无时间刻度、无播放头，只有一条 34px 细轨道。
- **图片面板细节粗糙**：旋转/翻转为 4 个文字按钮换行排列；滑杆显示原始倍率（1.00）且无单独还原；「输出预览」固定 240px 高导致小窗时侧栏溢出滚动。

仅改前端 UI（`src/main.ts` + `src/styles.css`），不动 `src-tauri` 后端与保存/剪辑逻辑。

## 改动

### 1. 视频剪辑 → 底部通栏控制台（`renderEditorVideoBody`，src/main.ts:4026）

视频舞台在上（flex:1），下方替换为全宽 `.editor-console`（不再使用 232px 侧栏）：

- **读数行**：入点/出点/保留/总时长 四个纵向读数（label 上、tabular-nums 值下），右侧为「剪辑方式」两张可选卡片（快速·无损秒级 / 精确·重编码任意切点），radio 隐藏、`:has(:checked)` 高亮边框。保留现有 `#trim-in/out/len-label` ID，新增 `#trim-dur-label`。
- **轨道行**：轨道加高至 ~40px，上方叠加 `.trim-ruler` 刻度条（10% 分隔 CSS 渐变），轨道内新增 `.trim-playhead` 播放头（`--trim-play` 变量定位，pointer-events:none）；手柄加宽至 16px 并加握持竖线。现有交互不变（点轨道 seek、拖手柄裁剪，`bindEditorVideoEvents` src/main.ts:4436）。
- **操作行**：设为入点/设为出点 + 入点/出点各一对 ◂ ▸ 微调按钮（±100ms，clamp 到 `EDITOR_MIN_TRIM_MS`，调整后 seek 视频到该点反馈）+ 循环复选框。删除与 footer 重复的提示文字。

### 2. 播放头同步（`bindEditorVideoEvents`）

新增 `editorSyncPlayhead()`：读 video.currentTime 写入 `--trim-play`。在 `timeupdate`（现处理器的早 return 之前）、`seeked`、`loadedmetadata` 三处调用。微调按钮与设点后同步。

### 3. 图片面板打磨（`renderEditorImageBody`，src/main.ts:3989）

- 旋转/翻转 → `.editor-tool-grid` 2×2 图标磁贴（↺ ↻ ⇋ ⇅ 图标 + 小字标签），保留现有按钮 ID。
- 滑杆 → 两行式：标签行（名称左、数值右）+ 通栏滑杆；数值行加“双击还原”，`bindEditorImageEvents` 中对 3 个滑杆加 `dblclick` 重置为 1（沿用现有 `#editor-adjust-reset` 的重置路径逻辑）。
- 裁剪组：重置按钮 + 输出尺寸读数（沿用 `#editor-crop-info`）。
- 「输出预览」→ `flex:1` 弹性占位吸收侧栏剩余空间，canvas 改为 `max-width/max-height:100%` 自适应，消除小窗滚动。

### 4. 样式（src/styles.css 2542–2619 区块）

新增 `.editor-console`、`.trim-stats`、`.trim-mode-card`、`.trim-ruler`、`.trim-playhead`、`.editor-tool-grid`、新滑杆结构样式；调整 `.trim-track/.trim-handle/.editor-output-wrap`；按现有惯例补齐 `[data-theme="dark"]` 深色覆盖（约 274 处先例）；沿用玻璃拟态语言（半透明面板、细边框、`--glass-specular`）。其余引用 `.editor-tools` 的地方（图片模式）不受影响。

## 验证

1. `pnpm build`（tsc + vite）通过类型检查与构建。
2. 视觉验证：在仓库外临时目录建独立 HTML harness（file:// 引用 `src/styles.css` + 静态编辑器标记，本地图片用 `public/camlib-icon.png`，用 ffmpeg 生成 10s 测试视频），用 browser-use 截图检查图片/视频两种面板在浅色/深色下的布局，并收窄窗口验证小尺寸表现；harness 用后即删、不入库。

不提交 git（如需提交请告知）。