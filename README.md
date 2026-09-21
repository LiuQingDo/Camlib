# Camlib

**个人相机媒体库** —— Windows 优先的本地桌面应用。

中文 | [English](README.en.md)

从相机存储卡备份照片与视频，在本机建立可浏览、可筛选、可管理的媒体索引；原始文件始终留在你自己选择的目录里，应用默认只读、删除进回收站。

- 后端：Rust（文件系统、SQLite 索引、缩略图、相机备份）
- 前端：Vanilla TypeScript + Vite（仅展示与交互，不拼接物理路径）
- 桌面框架：Tauri 2

## 为什么是 Camlib

相机拍完的照片往往散落在 DCIM 卡片和外接盘里：整理靠手动复制，查找靠资源管理器，删错了还难恢复。

Camlib 把这件事收成一个本地闭环：

1. **备份**：发现可移动盘 → 预览待导入项 → 复制并校验 → 失败可重试 / 可取消  
2. **索引**：增量扫描照片 / 视频 / 实况照片，SQLite 持久化，断盘不丢用户状态  
3. **浏览与管理**：按日期浏览、筛选搜索、收藏 / 标签 / 评分、回收站删除  

不上传云端，不替代你的媒体盘；索引与缩略图可随时重建，损坏不影响原始媒体。

## 功能

| 模块 | 能力 |
| --- | --- |
| 媒体库 | 注册本地根目录；记录卷身份；断盘后禁用危险写操作 |
| 扫描 | 增量入库；实况照片配对；连拍标记；相对路径索引 |
| 浏览 | 日期侧栏、缩略图网格、大图 / 视频预览、流式播放（Range） |
| 筛选 | 文件名、类型、日期、收藏、标签、评分、连拍 |
| 管理 | 收藏、标签、评分；回收站删除（预检 + 执行，按媒体项 ID） |
| 相机备份 | 发现 DCIM → 预览冲突与空间 → 复制校验 → 进度 / 重试；默认可忽略扩展名 |
| 系统集成 | 单实例、托盘、关闭行为、系统通知、设置 / 关于页 |

明确不做（当前版本）：云同步、RAW 编辑、AI 分类、移动端、自动更新。

## 相机备份（USB）

### 已验证设备

| 设备 | 状态 | 说明 |
| --- | --- | --- |
| 影石 Insta360 Ace Pro 2 | 已验证 | 开发者自用设备；USB 存储模式下 DCIM 可被发现与备份 |
| 其他品牌 / 型号 | 未系统验证 | 只要以 **USB 大容量存储** 挂载且根下有 `DCIM` 目录，原理上可被识别；能否完整读取取决于该机型的导出布局 |

本项目不针对某一品牌做协议层适配，备份逻辑基于「电脑能当 U 盘读到的 DCIM 文件树」。若你的相机只能走 MTP / 专用 App 传图，Camlib 可能看不到文件——这是当前设计边界，不是已实现的机型支持列表。

### 典型流程（以 Ace Pro 2 为例）

1. 相机开机，用 USB 连接电脑  
2. 在相机上选择 **USB 存储 / 磁盘模式**（不要停留在仅充电或专用传输协议）  
3. 电脑出现可移动磁盘，其中应能看到 `DCIM` 目录  
4. 打开 Camlib → 备份面板 → 刷新，选中该源盘与目标媒体库  
5. 预览：待导入数量、总大小、重复 / 冲突项、目标盘剩余空间  
6. 执行复制：临时文件写入 + **文件大小校验** 后提交；源盘只读，不改动、不删除相机内文件  
7. 失败项可重试；任务可取消；备份结束后自动刷新索引  

### 默认忽略的扩展名

备份**默认跳过**下列扩展名（可在 **设置 → 默认忽略扩展名**，或备份面板单次覆盖）：

| 扩展名 | 常见含义 | 默认行为 |
| --- | --- | --- |
| `.dng` | RAW / DNG（Ace Pro 等运动相机会附带） | **忽略，不导入** |
| `.lrv` | 低分辨率预览视频（Low Resolution Video） | **忽略，不导入** |

- 写法：逗号分隔，如 `.dng, .lrv`；大小写不敏感，会规范为小写 `.ext`  
- 设为空会回退到上述默认值  
- 预览里会单独统计「忽略」数量，不会静默丢弃而不提示  
- 当前会导入的主要类型示例：照片 `.jpg` `.jpeg` `.png` `.heic` `.heif` 以及部分 RAW；视频 `.mp4` `.mov` `.avi` `.m4v` `.mts` `.m2ts` `.3gp`  

若你还需要带入 `.dng` / `.lrv`，在设置里删掉对应扩展名再执行备份即可。

### 源盘识别与安全

- 只把**可移动卷**且含直接 `DCIM` 子目录的卷当作备份源候选  
- 库路径记录卷身份（不只看盘符）；断盘后危险写操作会被拒绝  
- 备份不修改、不删除相机中的任何文件；冲突策略可在预览前选择  

## 快速开始

### 环境

| 依赖 | 要求 |
| --- | --- |
| 操作系统 | Windows 10 / 11 |
| Node.js | 20+，包管理器 [pnpm](https://pnpm.io/) |
| Rust | stable（[rustup](https://rustup.rs/)） |
| ffmpeg（可选） | 视频缩略图；本机 PATH 或 `CAMLIB_FFMPEG_PATH` |

### 从源码运行

```powershell
# HTTPS
git clone https://github.com/LiuQingDo/Camlib.git
# 或 SSH
# git clone git@github.com:LiuQingDo/Camlib.git
cd Camlib
pnpm install
pnpm tauri dev
```

首次启动时选择媒体库根目录（例如外接盘上的 DCIM 本地备份目录）。

### 测试与检查

```powershell
pnpm build

cd src-tauri
cargo test
cargo fmt --check
cargo check
```

推送到 GitHub 后，CI（Windows）会自动跑同一套基线，见 [`.github/workflows/ci.yml`](.github/workflows/ci.yml)。

### 构建安装包

```powershell
pnpm tauri build
```

Windows NSIS 安装包默认输出：

```text
src-tauri\target\release\bundle\nsis\
```

发布前请对照 [`docs/release-checklist.md`](docs/release-checklist.md)。

## ffmpeg（视频缩略图）

视频首帧缩略图依赖 ffmpeg；查找顺序：

1. 环境变量 `CAMLIB_FFMPEG_PATH`
2. 打包资源 `src-tauri/resources/ffmpeg/ffmpeg[.exe]`
3. 开发机 PATH / WinGet 常见安装位置

发布构建前，将对应平台的可执行文件放入 `src-tauri/resources/ffmpeg/`：

```text
Windows:  src-tauri/resources/ffmpeg/ffmpeg.exe
macOS:    src-tauri/resources/ffmpeg/ffmpeg
Linux:    src-tauri/resources/ffmpeg/ffmpeg
```

**仓库不内置第三方二进制**（见该目录 `README.txt`），`.gitignore` 已忽略本地放置的 `ffmpeg.exe`。

没有 ffmpeg 时应用仍可启动、浏览、筛选与备份，仅视频缩略图失败并提示。

## 数据在哪

| 内容 | 默认位置 | 删除后 |
| --- | --- | --- |
| SQLite 索引、设置 | `%APPDATA%\com.camera.media-library\` | 索引与设置丢失；**原始媒体不受影响** |
| 缩略图缓存 | `%LOCALAPPDATA%\com.camera.media-library\`（可改为 SSD 自定义路径） | 可重建 |
| 原始媒体 | 你选择的媒体库根目录 | 应用默认只读；删除仅进 Windows 回收站 |

路径与 ffmpeg 检测结果可在应用内 **设置 → 关于** 查看。

卸载应用**不会**删除媒体库目录。

## 安全设计（摘要）

Camlib 把文件系统能力收在 Rust 侧，前端只拿 DTO 与 ID：

- **CSP**：`default-src 'self'`；脚本仅 `'self'`；`object-src 'none'`；`withGlobalTauri: false`
- **Capabilities**：主窗口仅保留必要权限（core、文件夹对话框、打开路径 / 在资源管理器中显示）
- **路径**：前端提交 `libraryId` / `mediaItemId`；后端解析并校验，拒绝 `..`、绝对路径、UNC、设备前缀越界
- **删除**：预检后进回收站，可部分成功；断盘时写操作被拒绝
- **备份**：源盘只读；临时文件写入 + 大小校验后原子提交；源卷变化立即失败
- **错误契约**：command 返回 `{ code, message, retryable, details? }`，码表见 `src-tauri/src/errors.rs` 与 `src/api/errors.ts`

## 项目结构

```text
Camlib/
├─ src/                    # 前端：界面、筛选、invoke 封装
├─ src-tauri/
│  ├─ src/
│  │  ├─ lib.rs            # Tauri commands、应用状态
│  │  ├─ scanner.rs        # 增量扫描
│  │  ├─ media.rs          # 缩略图、ffmpeg、流协议
│  │  ├─ backup.rs         # 相机备份
│  │  ├─ deletion.rs       # 回收站删除
│  │  └─ db/               # SQLite 迁移与查询
│  └─ resources/ffmpeg/    # 本地放置 ffmpeg（不进 Git）
├─ docs/                   # 需求、架构、数据模型、开发笔记
└─ package.json
```

## 文档

| 文档 | 内容 |
| --- | --- |
| [`docs/requirements.md`](docs/requirements.md) | 产品需求与验收标准 |
| [`docs/architecture.md`](docs/architecture.md) | 当前架构与模块边界 |
| [`docs/data-model.md`](docs/data-model.md) | SQLite 数据模型（以 migrations 为准） |
| [`docs/development-notes.md`](docs/development-notes.md) | Command API、错误契约、路径安全、测试 |
| [`docs/release-checklist.md`](docs/release-checklist.md) | 发布前检查清单 |
| [`docs/usability-dev-sessions.md`](docs/usability-dev-sessions.md) | 可用性打磨记录与延后项 |
| [`docs/ux-style-plan.md`](docs/ux-style-plan.md) | 样式与体验计划（草稿） |
| [`CHANGELOG.md`](CHANGELOG.md) | 版本变更记录 |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | 贡献指南（环境、检查项、硬性约束） |
| [`SECURITY.md`](SECURITY.md) | 漏洞报告渠道与安全边界 |

数据表结构的真相来源是 `src-tauri/src/db/migrations/`，文档与代码不一致时以迁移文件为准。

## 贡献

项目处于早期（v0.1.x），欢迎 Issue 与 PR。完整说明见 [CONTRIBUTING.md](CONTRIBUTING.md)。摘要：

1. 大改动先开 Issue 对齐意图，避免方向跑偏
2. 涉及文件系统 / 删除 / 备份的改动请补充或更新测试
3. Schema 变更必须新增迁移文件，并同步更新 `docs/data-model.md`
4. 提交前跑通：`pnpm build`、`cargo test`、`cargo fmt --check`

安全问题请勿公开开 Issue，见 [SECURITY.md](SECURITY.md)。

## 版本历史

见 [CHANGELOG.md](CHANGELOG.md)；安装包见 [GitHub Releases](https://github.com/LiuQingDo/Camlib/releases)。

## 许可证

[MIT](LICENSE) © 2026 LiuQingDo

第三方组件（如 FFmpeg）各自遵循其许可证；本仓库不分发 FFmpeg 二进制。

## 致谢

- [Tauri](https://tauri.app/) —— 桌面应用框架  
- [SQLite](https://sqlite.org/) / [rusqlite](https://github.com/rusqlite/rusqlite) —— 本地索引  
- [FFmpeg](https://ffmpeg.org/) —— 视频首帧缩略图（二进制不随仓库分发）
