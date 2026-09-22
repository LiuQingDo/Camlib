# Camlib 当前架构

> 更新日期：2026-09-21  
> 本文描述**当前代码真实状态**。历史原型一笔带过，见文末。

## 0. 当前实现摘要

仓库是 Tauri 2 + Vite + Vanilla TypeScript + Rust + SQLite 的可运行媒体库应用（Windows 优先）。

**Rust 边界**（`src-tauri/src/`）：

| 模块 | 职责 |
| --- | --- |
| `lib.rs` | Tauri commands、状态装配、`ensure_library_ready` |
| `errors.rs` | 结构化 `AppError` / `ErrorCode`，command 错误合约 |
| `infrastructure.rs` | 设置、库根、卷身份、断盘状态 |
| `db/` | SQLite 迁移（当前 schema v5）、查询、收藏/标签/评分、扫描与备份 runs |
| `scanner.rs` | 增量扫描、实况配对、连拍、进度 Channel |
| `media.rs` | 缩略图、ffmpeg 适配器、`camlib` 流协议与 Range |
| `deletion.rs` | 路径解析、回收站删除预检与执行 |
| `backup.rs` | DCIM 发现、预览、复制校验、重试 |
| `system.rs` | 托盘、关闭行为、通知、卷监视 |

**前端边界**（`src/`）：

| 模块 | 职责 |
| --- | --- |
| `main.ts` | 界面渲染、筛选、网格、预览、设置、备份面板 |
| `api/media.ts` | 媒体/扫描/备份/标签/评分 invoke 封装 |
| `api/infrastructure.ts` | 设置、库状态、关于页 invoke 封装 |
| `api/errors.ts` | 错误码 → 中文文案映射 |

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
6. UI 偏好（密度、排序、浅色/深色主题等）走 `app_settings` / `set_ui_prefs`，不写 `localStorage`。

## 2. 目标架构（已落地）

```text
Vanilla TypeScript UI
  ├─ 查询 SQLite DTO、分页结果、媒体资源句柄
  ├─ 发起 command，订阅 job progress Channel
  └─ 不拼接物理路径、不直接读写文件、不保存业务状态到 localStorage
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

### 关键决策

1. SQLite 是正式索引和用户状态的唯一来源；静态清单不参与运行时一致性判断。
2. 前端按查询条件分页请求媒体项，不把全库装入内存；日期导航由 SQL 聚合返回。
3. 删除只提交 `mediaItemId`，后端从数据库与文件系统重新解析全部关联文件。
4. 不启动 Python HTTP 服务；图片、视频和缩略图通过 Tauri 受控 command / `camlib://` 协议提供。
5. 实况照片是一个 `media_item`，通过 `media_files` 关联照片和视频；收藏、删除、查询都以逻辑项为边界。
6. 扫描和备份使用独立长任务；任务状态可查询、可取消、最终结果持久化到 `scan_runs` / `backup_runs`。
7. Windows 盘符只作为显示信息。库记录规范化根路径和卷唯一标识；写操作前重新确认卷身份。

### Rust 模块布局

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

Command 列表与错误合约见 `docs/development-notes.md`。数据表结构见 `docs/data-model.md`（以 `src-tauri/src/db/migrations/` 为准）。

## 3. 历史原型（一笔带过）

实现前曾有 PowerShell 备份、Python 静态清单/HTTP 服务、浏览器查看器等原型。可保留的算法参考已并入当前实现（扩展名分类、文件名日期提取、同 stem 实况配对、连拍启发式、EXIF 方向、视频首帧缩略图、回收站删除、`年\月\日期\类型` 目录布局）。硬编码盘符、Python HTTP、静态清单、`localStorage` 收藏、客户端文件列表删除等原型做法均已废弃，不再维护原型行为描述。
