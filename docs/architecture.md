# Camlib 当前架构（含历史审计摘要）

> 更新日期：2026-09-12（S9 加固）
>
> 本文描述**当前代码真实状态**。H 盘原型审计结论见 §2 历史摘要；不再代表仓库仍是模板。

## 0. 当前实现摘要

仓库是 Tauri 2 + Vite + Vanilla TypeScript + Rust + SQLite 的可运行媒体库应用。

**Rust 边界**（`src-tauri/src/`）：

| 模块 | 职责 |
| --- | --- |
| `lib.rs` | Tauri commands、状态装配、`ensure_library_ready` |
| `errors.rs` | 结构化 `AppError` / `ErrorCode`，command 错误合约 |
| `infrastructure.rs` | 设置、库根、卷身份、断盘状态 |
| `db/` | SQLite 迁移、查询、收藏/标签/评分、扫描与备份 runs |
| `scanner.rs` | 增量扫描、实况配对、连拍、进度 Channel |
| `media.rs` | 缩略图、ffmpeg 适配器、`camlib` 流协议与 Range |
| `deletion.rs` | 路径解析、回收站删除预检与执行 |
| `backup.rs` | DCIM 发现、预览、复制校验、重试 |
| `system.rs` | 托盘、关闭行为、通知、卷监视 |

**安全基线（S9）**：

- CSP 非 `null`：`default-src 'self'`，script 仅 self；`img-src`/`media-src` 含 `camlib:` 与 asset
- `withGlobalTauri: false`；capabilities 最小化（无 webview 侧 notification）
- 路径：component-aware containment；拒绝 `..` / 绝对 / UNC / 设备前缀
- 错误：`{ code, message, retryable, details? }` 贯穿 Rust → 前端中文文案

## 1. 设计原则（不变）

1. Rust 是唯一文件系统、索引、缩略图与备份边界。
2. 前端只持有 DTO、媒体项 ID、任务 ID；不拼物理路径。
3. SQLite 是正式索引与用户状态唯一来源；可重建数据与原始媒体分离。
4. 原始媒体默认只读；删除进回收站；备份不改源盘。
5. 长任务可查询、可取消；断盘时写操作被拒绝。

## 2. 历史审计摘要（2026-09-06）

以下为 H 盘原型阶段的结论，保留作迁移依据；仓库实现已完成其中主要迁移项。

### 2.1 仓库（审计时）

当审计时仓库接近官方模板，无业务代码。现已实现完整浏览 / 管理 / 备份闭环与系统融入（见 §0）。

### 2.2 原型文件名差异

需求中列出的以下三个路径不存在：

| 需求路径 | 实际审计文件 |
| --- | --- |
| `H:\backup\_camera.ps1` | `H:\backup_camera.ps1` |
| `H:\media-viewer\tools\build\_manifest.py` | `H:\media-viewer\tools\build_manifest.py` |
| `H:\media-viewer\tools\media\_server.py` | `H:\media-viewer\tools\media_server.py` |

`H:\media-viewer\assets\app.js` 和 `H:\media-viewer\assets\management.js` 按需求路径存在。本文按实际存在的三个原型文件进行审计；没有创建或复制这些文件到仓库。

### 2.3 PowerShell 备份原型

`H:\backup_camera.ps1` 的主要行为：

- 默认尝试 `E:`，否则枚举可移动盘并寻找 `DCIM` 目录。
- 目标目录由脚本所在目录和 `DCIM-local` 拼接得到，不能在界面中选择媒体库。
- 通过扩展名分类；默认忽略 `.lrv` 和 `.dng`。
- 优先从文件名中的 `yyyyMMdd_HHmmss` 取日期，失败时回退到文件修改时间。
- 将媒体复制到 `年\月\日期\照片或视频`，并兼容迁移旧的 `日期\类型` 目录。
- 预扫描按目标路径和文件大小判断“已备份”；同名且大小不同的文件使用后缀避让。
- 检查目标盘剩余空间，逐文件 `Copy-Item`，复制后只校验大小，不校验哈希。
- 支持 `-DryRun`，失败项继续执行并在末尾统计；日志是追加式文本。

主要架构风险：硬编码盘符和目标位置、日期来源不可靠、复制不是临时文件加原子提交、重复判断过弱、无暂停/继续/取消、无持久化任务状态、目标目录迁移使用移动和强制覆盖、日志不可查询，且没有统一路径安全边界。

### 2.4 Python 清单生成原型

`H:\media-viewer\tools\build_manifest.py` 的主要行为：

- 硬编码 `H:/DCIM-local`、`H:/media-viewer/assets/thumbs`、`manifests` 和 `data.js`。
- 仅扫描有限的图片/视频扩展名，并从目录名 `YYYY-MM-DD` 提取日期；不符合该目录结构的文件被跳过。
- 在同一日期目录中按文件 stem 配对图片和视频，配对后创建 `live` 逻辑项。
- 图片使用 Pillow 做 EXIF 方向纠正和 JPEG 缩略图；视频调用 ffmpeg 截取首帧。
- 缩略图新鲜度只比较缩略图和源文件修改时间；视频 ffmpeg 返回码没有作为失败条件处理。

### 原型媒体预览边界（历史）

- 缩略图曾写在媒体盘；现改为应用缓存目录，缓存键包含规范化相对路径、文件大小、修改时间、规格和处理器版本。
- 原图和视频通过受控 `camlib://` / `http://camlib.localhost` URI 访问，支持 Range，单次读取限制在 2 MiB。
- ffmpeg 查找顺序：`CAMLIB_FFMPEG_PATH` → 打包资源 → PATH/WinGet。

主要架构风险（原型）：静态清单会过期；全库搜索把月份分片装进浏览器；清单暴露相对路径并依赖本地 HTTP；逻辑 ID 由日期/stem 拼接；缩略图与清单写在媒体盘。

### 2.5 前端查看器原型

`app.js` 已实现一套相对完整的静态查看流程：按月/日导航、按类型/连拍/收藏筛选、文件名搜索、最新/最早/文件名排序、分批显示、懒加载缩略图、照片/视频/实况照片预览、键盘切换、主题和密度设置。

但收藏和界面设置依赖浏览器 `localStorage`；“收藏”不是数据库状态。所有媒体数据先进入全局 `ALL`，全库查询会顺序加载全部月份。资源 URL 来自清单并由静态服务器提供，没有 Tauri 级别的媒体授权。

`management.js` 通过 `http://127.0.0.1:8765/api` 连接本地服务，把收藏同步到 `favorites.json`，允许选择清单中的项并输入精确确认短语后删除。它用事件捕获拦截卡片点击，并在服务端删除后重载页面。

### 2.6 Python 本地服务原型

`H:\media-viewer\tools\media_server.py`：

- 仅绑定 `127.0.0.1:8765`，但 `SimpleHTTPRequestHandler` 的根目录是整个 `H:`，因此同机进程可通过本服务读取 H 盘下不只是媒体库的内容。
- CORS 为 `*`，没有调用方认证或一次性令牌。
- 提供 `GET /api/status`、`GET/PUT /api/favorites`、`POST /api/delete` 和 `POST /api/shutdown`。
- `safe_media_path` 会解析路径并检查其位于 `H:\DCIM-local` 内、是文件且扩展名在白名单中；删除使用 Windows 回收站并允许撤销。
- 删除前限制 1 至 300 个逻辑项，服务端检查确认短语，并去重文件路径；删除后清理收藏并同步重建静态清单。
- 使用 Windows mutex 防止服务多开。

主要架构风险：路径根和端口硬编码；静态清单中的文件列表由客户端提交，服务端没有校验文件是否仍属于指定逻辑项；批量回收站操作可能部分成功，之后清单重建失败时状态会分裂；服务重建清单是同步阻塞操作；CORS 和整个 H 盘静态暴露扩大了本地攻击面。

## 3. 目标架构

### 3.1 分层

```text
Vanilla TypeScript UI
  ├─ 查询 SQLite DTO、分页结果、媒体资源句柄
  ├─ 发起 command，订阅 job Channel
  └─ 不拼接物理路径、不直接读写文件、不保存业务收藏到 localStorage
          │ Tauri invoke / Channel
Rust application layer
  ├─ commands：参数校验、授权边界、DTO 映射
  ├─ job manager：扫描、缩略图、备份、重建、取消和进度
  ├─ library service：卷识别、路径解析、扫描和增量同步
  ├─ media service：分页查询、资源流、元数据和回收站
  ├─ backup service：发现、预览、复制、校验、重试
  ├─ thumbnail service：SSD 缓存和可替换的 ffmpeg 适配器
  └─ repository：SQLite 迁移、事务和查询
          │
  App data / cache on SSD       User-selected media root on external disk
  SQLite + logs + thumbnails    Original files; normally read-only
```

### 3.2 关键决策

1. SQLite 是正式索引和用户状态的唯一来源；静态清单只可作为一次性迁移参考，不能参与运行时一致性判断。
2. 前端按查询条件分页请求媒体项，不把全库装入内存；按日期的导航数据直接由 SQL 聚合返回。
3. 后端不接受前端提交的任意物理文件列表来执行删除；前端只提交 `mediaItemId`，后端从数据库和当前文件系统状态重新解析所有关联文件。
4. 不再启动 Python HTTP 服务。图片、视频和缩略图通过 Tauri 受控 command/自定义协议提供，协议层只允许解析到已注册媒体库或应用缓存。
5. 原始媒体放在用户选择的媒体库；数据库、日志、缩略图和临时复制文件放在 SSD 的应用数据/缓存目录。应用缓存可重建，不能成为原始媒体的第二份隐式备份。
6. 实况照片是一个 `media_item`，通过两个 `media_files` 关联照片和视频；收藏、删除、查询都以逻辑项为边界。
7. 扫描和备份使用独立长任务；任务状态可查询、可取消、最终结果持久化，界面关闭后不会把任务线程和数据库写入留在不可知状态。
8. Windows 盘符只作为显示信息。库记录规范化根路径和卷唯一标识；每次写操作前重新确认卷和根目录仍是同一对象。

### 3.3 当前 Rust 模块布局

```text
src-tauri/src/
  lib.rs             commands + ensure_library_ready
  errors.rs          AppError / ErrorCode
  infrastructure.rs  设置、库根、卷、断盘
  db/                SQLite 迁移与 repository
  scanner.rs         增量扫描与 job
  media.rs           缩略图、ffmpeg、流协议
  deletion.rs        路径解析与回收站删除
  backup.rs          备份发现/预览/复制/重试
  system.rs          托盘、通知、卷监视
```

## 4. 与原型的迁移边界

可保留为算法参考的内容：扩展名分类、文件名日期提取、实况照片的同 stem 配对、三秒连拍启发式、EXIF 方向纠正、视频首帧缩略图、回收站而非永久删除、导入后的日期目录布局。

必须重做的边界：硬编码 H/E 盘、Python HTTP 服务、静态清单、浏览器收藏、客户端文件列表删除、文本日志解析、仅按文件大小判重复、同步重建清单和全 H 盘静态文件暴露。
