# Camlib 架构审计与目标架构

> 审计范围：当前仓库，以及 H 盘原型的实际存在文件。
>
> 审计日期：2026-09-06
>
> 本文只记录架构审计和设计，不实现业务功能，也不将 H 盘媒体、缩略图或静态清单复制到仓库。

## 1. 审计结论

当前仓库是 Tauri 2 + Vite + Vanilla TypeScript 的官方最小模板，尚未形成媒体库应用。H 盘原型已经验证了日期归档、照片/视频展示、实况照片配对、连拍标记、收藏、回收站删除和相机备份等用户流程，但运行时仍依赖硬编码路径、静态 JavaScript 清单、浏览器 `localStorage` 和本地 HTTP 服务。

目标架构应让 Rust 成为唯一的文件系统、索引、数据库、缩略图和备份边界；前端只持有 DTO、媒体项 ID 和任务 ID。静态清单不再是正式索引，Python HTTP 服务不再作为运行时依赖。

## 2. 当前代码现状

### 2.1 仓库

- `package.json` 只有 `build`、`dev`、`preview` 和 Tauri 命令；依赖只有 Tauri API、opener、Vite 和 TypeScript。
- `src/main.ts` 只注册默认表单，并调用 `greet`。
- `index.html` 和 `src/styles.css` 仍是 Tauri 欢迎页。
- `src-tauri/src/lib.rs` 只有 `greet` command；没有应用状态、数据库、扫描器、任务管理器或路径安全层。
- `Cargo.toml` 只有 Tauri、opener、Serde 和 Serde JSON；尚未引入 SQLite、媒体元数据、Windows 文件操作或测试替身。
- `tauri.conf.json` 使用 Vite `1420` 端口、`frontendDist=../dist`，CSP 为 `null`；能力文件只有 `core:default` 和 `opener:default`。
- 仓库没有测试、数据库迁移或业务源代码；当前没有 Git 提交记录。
- 现有 `docs/requirements.md` 和 `docs/codex-development-workflow.md` 是需求与开发流程文档，不代表功能已经存在。

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
- 按文件名时间戳把相邻三秒内、至少三项的媒体标记为连拍。
- 生成一个启动索引和按月 JavaScript 分片，并从文本备份日志解析最近备份信息。
- 清单中的 `stats.files` 统计的是逻辑项，不是所有物理文件；`duplicates` 明确未计算。

主要架构风险：静态清单会过期；搜索必须把月份分片加载到浏览器内存；清单输出暴露 H 盘相对路径并依赖本地 HTTP；逻辑 ID 主要由日期、类型和 stem 拼接而成；同一日期内重复 stem 可能在字典分类阶段互相覆盖；元数据范围有限；缩略图和清单都写在媒体盘而非应用缓存。

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

### 3.3 建议 Rust 模块

```text
src-tauri/src/
  app_state.rs       应用目录、数据库、任务管理器、单实例
  commands/          command 入参、出参和错误映射
  db/                迁移、repository、查询 DTO
  library/           卷识别、扫描、配对、增量同步
  media/             资源访问、元数据、缩略图、回收站
  backup/            源盘发现、预览、复制和校验
  jobs/              job 状态、取消令牌、进度 channel
  security/          路径解析、根目录约束、卷校验
  windows/            回收站、盘符/卷信息、文件夹打开
```

## 4. 与原型的迁移边界

可保留为算法参考的内容：扩展名分类、文件名日期提取、实况照片的同 stem 配对、三秒连拍启发式、EXIF 方向纠正、视频首帧缩略图、回收站而非永久删除、导入后的日期目录布局。

必须重做的边界：硬编码 H/E 盘、Python HTTP 服务、静态清单、浏览器收藏、客户端文件列表删除、文本日志解析、仅按文件大小判重复、同步重建清单和全 H 盘静态文件暴露。

