# Camlib

个人相机媒体库桌面应用（Windows 优先）。用 Rust 负责文件系统、SQLite 索引、缩略图缓存与相机备份；前端只负责展示与交互，不拼接物理路径。

## 功能

- 注册本地媒体库目录，记录卷身份；断盘后禁用危险写操作
- 增量扫描：照片 / 视频 / 实况照片配对、连拍标记、相对路径索引
- 分页查询：日期侧栏、类型、收藏、连拍、文件名、标签、评分筛选
- 缩略图缓存（SSD）与受控 `camlib://` / `http://camlib.localhost` 预览（视频支持 Range）
- 收藏、标签、评分、回收站删除（预览 + 执行，按媒体项 ID）
- 相机备份：发现可移动盘 DCIM → 预览 → 复制校验 → 失败重试 / 取消
- 单实例、托盘、关闭行为、系统通知、设置页

## 快速开始

### 环境

- Windows 10/11
- [Node.js](https://nodejs.org/) 20+ 与 pnpm
- Rust stable（`rustup`）
- 开发时可选：本机 `ffmpeg` 在 PATH，或设置 `CAMLIB_FFMPEG_PATH`

### 开发

```powershell
pnpm install
pnpm tauri dev
```

### 测试与检查

```powershell
pnpm build
cd src-tauri
cargo test
cargo fmt --check
cargo check
```

## 数据目录

| 内容 | 位置 | 可删除？ |
| --- | --- | --- |
| SQLite 索引、设置 JSON | 应用数据目录（`%APPDATA%/com.camera.media-library`） | 删除会丢失索引与设置；原始媒体不受影响 |
| 缩略图缓存 | 应用缓存目录 / 设置中自定义 SSD 路径 | 可随时重建 |
| 原始媒体 | 用户选择的媒体库根目录 | 应用默认只读；删除仅进 Windows 回收站 |

设置 → 关于 可查看实际路径与 ffmpeg 检测结果。

## ffmpeg（视频缩略图）

查找顺序：

1. 环境变量 `CAMLIB_FFMPEG_PATH`
2. 打包资源 `src-tauri/resources/ffmpeg/ffmpeg[.exe]`
3. 开发机 PATH / WinGet 常见安装位置

发布构建前请把对应平台的 `ffmpeg.exe` 放入 `src-tauri/resources/ffmpeg/`。**仓库不内置第三方二进制**（见该目录 `README.txt`）。没有 ffmpeg 时应用仍可浏览与备份，仅视频首帧缩略图失败。

## 安全语义

- **CSP**：`default-src 'self'`，脚本仅 `'self'`；`img-src`/`media-src` 允许 `camlib:` 与 Tauri asset；`object-src 'none'`
- **Capabilities**：主窗口仅 `core:default`、文件夹对话框、opener 的 open-path / reveal-item；通知与托盘只在 Rust 侧使用
- **路径**：前端只提交 `libraryId` / `mediaItemId`；相对路径拒绝 `..`、绝对路径、UNC、设备前缀；containment 使用 component-aware `starts_with`
- **删除**：预检后进回收站，可部分成功并记录；断盘时扫描 / 删除 / 缩略图重建被拒绝
- **备份**：源盘只读；临时文件写入 + 大小校验后原子提交；源卷变化立即失败

错误契约（command → 前端）：

```json
{ "code": "LIBRARY_OFFLINE", "message": "…", "retryable": true, "details": {} }
```

码表见 `src-tauri/src/errors.rs` 与 `src/api/errors.ts`。

## 文档

- `docs/requirements.md` — 产品需求
- `docs/architecture.md` — 当前架构与历史审计
- `docs/development-notes.md` — API / 进度 / 路径安全合约
- `docs/usability-dev-sessions.md` — 开发会话路线（S1–S9）
- `docs/release-checklist.md` — 发布前检查

## 安装包

```powershell
pnpm tauri build
```

产物与注意事项见 `docs/release-checklist.md`。
