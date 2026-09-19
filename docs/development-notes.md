# Camlib 开发合约

> 对齐当前实现（S9 后）。命令注册见 `src-tauri/src/lib.rs` `invoke_handler`；前端封装见 `src/api/`。  
> 错误契约被 `src-tauri/src/errors.rs` 与 `src/api/errors.ts` 引用，改动需两边同步。

## 1. Command API（已实现）

JSON 字段使用 camelCase（Rust 内部 snake_case，`serde` 负责映射）。

### 设置与库状态

| Command | 说明 |
| --- | --- |
| `get_app_settings` | 应用设置（库路径、缩略图目录、备份策略、UI 偏好等） |
| `get_infrastructure_state` | 库根、卷状态、设置与运行时摘要 |
| `get_library_status` | 当前库连接/断盘状态 |
| `library_list` | 已注册媒体库列表 |
| `set_library_root` | 选择/更换媒体库根目录（规范化 + 卷身份） |
| `set_thumbnail_cache_dir` | 设置缩略图缓存目录 |
| `set_backup_conflict_policy` | 备份冲突策略 |
| `set_backup_ignore_extensions` | 备份忽略扩展名 |
| `set_ui_prefs` | UI 偏好（density / sort 等，走 Rust，非 localStorage） |
| `set_auto_scan_on_startup` | 启动自动增量扫描开关 |
| `set_notifications_enabled` | 系统通知开关 |
| `set_close_behavior` | 关闭行为（退出 / 托盘） |
| `list_scan_runs` | 最近扫描 runs |
| `library_index_summary` | 索引摘要（数量、最后扫描等） |
| `get_app_about` | 版本、数据目录、ffmpeg 检测 |
| `get_thumbnail_cache_stats` | 缩略图缓存体积等 |
| `open_app_directory` | 打开应用数据/缓存等目录 |

### 媒体查询与资源

| Command | 说明 |
| --- | --- |
| `media_query` | 分页查询：日期、类型、收藏、连拍、标签、评分、关键词、排序 |
| `media_date_facets` | 侧栏日期聚合 |
| `media_get` | 单项详情（文件角色、可用性、元数据） |
| `media_open_folder` | 按 `mediaItemId` 后端解析后打开资源管理器 |
| `media_thumbnail` | 缩略图（受控缓存） |
| `media_preview` | 预览 DTO / 资源授权信息 |
| `favorite_set` / `favorite_set_batch` | 收藏读写 |
| `tag_list` / `tag_create` / `tag_find_or_create` / `tag_update` / `tag_delete` | 标签 CRUD |
| `tag_attach` / `tag_detach` / `tag_attach_batch` / `tag_detach_batch` | 标签关联 |
| `rating_set` / `rating_set_batch` | 1–5 星评分；0 清除 |

### 管理与删除

| Command | 说明 |
| --- | --- |
| `media_delete_preview` | 删除预检（媒体项数、文件数、大小、摘要） |
| `media_delete_items` | 按 mediaItemId 删除；后端解析全部文件 → 回收站；支持部分成功 |

### 长任务

| Command | 说明 |
| --- | --- |
| `library_scan_start` / `library_scan_cancel` | 增量/全量扫描；进度走 Channel |
| `thumbnail_rebuild_start` / `preview_job_cancel` | 缩略图重建 |
| `backup_sources_discover` | 发现含 DCIM 的可移动卷 |
| `backup_preview` | 备份预览：数量、冲突、空间 |
| `backup_start` / `backup_cancel` / `backup_retry_failed` | 备份执行 / 取消 / 只重试失败项 |
| `backup_history` / `backup_run_items` | 备份历史与明细 |

前端不提交任意物理路径数组；删除与打开文件夹均以 `mediaItemId` 为边界。

## 2. 错误合约

所有 command 失败返回可序列化错误对象：

```json
{
  "code": "LIBRARY_OFFLINE",
  "message": "媒体库所在卷当前不可用",
  "retryable": true,
  "details": { "libraryId": "..." }
}
```

码表（`src-tauri/src/errors.rs` / `src/api/errors.ts`）：

`INVALID_ARGUMENT`、`LIBRARY_OFFLINE`、`PATH_OUTSIDE_ROOT`、`VOLUME_CHANGED`、`MEDIA_MISSING`、`CONFLICT`、`INSUFFICIENT_SPACE`、`JOB_NOT_FOUND`、`JOB_ALREADY_RUNNING`、`CANCELLED`、`IO_ERROR`、`DATABASE_ERROR`、`THUMBNAIL_ERROR`、`INTERNAL`

前端将 `code` 映射为中文用户文案；日志可保留 `message` / `details`，但不得泄露不必要的系统绝对路径。

## 3. 长任务进度 Channel

### 传输

每个长任务由一个 Tauri progress Channel 绑定，command 立即返回 `{ jobId, ... }`。进度结果同时持久化到 `scan_runs` / `backup_runs`，重启后从 runs 表展示最近结果，而不是假装任务仍在跑。

```text
start command + progress Channel
        ↓ returns jobId
background worker → coalesced progress events → UI
        ↓
persisted scan_runs / backup_runs
```

### 事件结构（示意）

```json
{
  "jobId": "job-uuid",
  "kind": "scan",
  "seq": 42,
  "phase": "indexing",
  "state": "running",
  "processed": 120,
  "total": 267,
  "bytesProcessed": 104857600,
  "bytesTotal": 222470000000,
  "current": { "displayName": "IMG_001.jpg" },
  "message": "正在读取元数据",
  "error": null,
  "at": "2026-09-06T00:00:00Z"
}
```

`state`：`queued|running|completed|cancelled|failed`  
`phase`：`discovering|planning|copying|hashing|indexing|thumbnailing|finalizing` 等。  
事件中不放绝对路径；错误详情不泄露不必要的系统路径。

### 交付规则

- `seq` 在一个 job 内单调递增。
- 逐文件事件可合并，只保留最新进度；失败项和最终汇总不可丢。
- 每个 job 只发送一个终态事件；先写入 runs 再发终态。
- 取消是协作式：在文件复制完成、批事务提交和安全边界处检查取消 token。
- 同一 library 的扫描、删除、备份刷新串行化；只读查询可并行。

## 4. 路径安全策略

### 根目录注册

1. 目录必须存在且可读；规范化并保存 canonical root。
2. 记录 Windows 卷唯一标识、卷标和当前盘符；盘符仅作展示。
3. 拒绝把应用数据目录、缓存目录或临时目录注册为媒体库。
4. 断盘时保留库记录（`offline`）；恢复后重新验证卷 ID，再允许写操作。

### 文件解析

- 外部请求只提交 `libraryId`、`mediaItemId`；删除不接受前端任意文件数组。
- 相对路径必须非空、非绝对，统一 `\\`/`/` 后逐段拒绝 `.`、`..`、空段和 Windows 设备路径前缀。
- 解析后做 component-aware containment check，不能只做字符串前缀比较（防 `DCIM-local-evil` 等兄弟目录绕过）。
- 现有文件 canonicalize 后再检查根目录；创建目标先 canonicalize 已存在父目录。
- Windows 大小写、UNC、长路径、盘符/卷变化均有测试覆盖。
- 关键读写前再次检查状态，降低 TOCTOU 风险。

### 媒体、缓存与备份

- 默认只读：扫描、查询、预览不改变原始媒体。
- 资源访问只允许注册库内已登记的相对路径与应用缓存中的缩略图；无「任意路径读取」command。
- 删除以 `mediaItemId` 为输入，后端取得全部物理成员 → 预检 → 回收站；记录每个文件结果。
- 备份前锁定源卷身份、源路径清单、目标 library 和空间预估；卷变化立即失败。
- 复制先写同目录临时文件，校验大小后原子 rename；默认不覆盖已有内容。
- 不修改相机源盘；忽略扩展名来自设置并写入 `backup_runs`。
- 缩略图失败只影响缓存状态；缓存清理不可触及媒体库根目录。

## 5. 测试策略

### 纯 Rust 单元测试

- 路径：`..`、绝对路径、UNC、大小写、兄弟目录前缀、junction、卷 ID 不匹配、扩展名白名单。
- 配对：单照片、单视频、同 stem 实况、重复 stem、一对多、缺日期、缺配对成员。
- 扫描：幂等、变更只更新必要字段、外部删除标 missing、用户状态保持、取消不误报成功。
- 数据库：迁移顺序、外键、唯一约束、分页排序、过滤与事务回滚；schema 版本测试。
- 备份：同大小相同/不同内容、冲突策略、空间不足、忽略扩展名、校验失败、重试、取消。

### 临时目录集成

所有文件系统测试使用独立临时源/目标目录；删除使用 FakeRecycleBin 或可恢复路径断言。**禁止**自动化测试写入真实媒体库（如 `H:\DCIM-local`）。

覆盖最小合成 fixture：照片+视频同 stem、重复文件名、旧日期目录、无日期文件、损坏图片、ffmpeg 失败、中途断盘。

### 前端与构建门禁

- command DTO、错误码、进度事件类型与 Rust 保持一致（`src/api/*`）。
- CI/本地基线：

```powershell
pnpm build
cd src-tauri
cargo test
cargo fmt --check
cargo check
```

- 可选属性/模糊测试重点放在路径解析与 stem 配对，防止安全检查退化为字符串拼接。

## 6. 执行约束（持续有效）

1. 真实媒体库只允许人工只读检查；自动化测试一律用临时目录。
2. 原始媒体默认只读；删除必须进 Windows 回收站；备份不得改相机源盘。
3. 前端不拼物理路径、不把业务状态写入 `localStorage`。
4. 一会话一主题；`pnpm build` + `cargo test` 通过后再收工。
5. 修改 command / 错误码 / 表结构时，同步更新本文、`data-model.md` 与前端 `api` 层。
