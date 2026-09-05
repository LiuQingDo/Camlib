# Camlib 架构审计开发备注

## 1. Command API

以下是目标 API 合约草案。名称是稳定边界的建议，不代表当前仓库已有这些 command。前端通过 Tauri `invoke` 调用；JSON 字段建议使用 camelCase，Rust 内部使用 snake_case。

### 应用、库和设置

| Command | 入参 | 返回值/说明 |
| --- | --- | --- |
| `app_get_status` | 无 | 版本、数据库状态、当前活动任务、库连接状态 |
| `settings_get` | 无 | 应用设置、导入规则、缩略图目录 |
| `settings_set` | `settings` | 校验后持久化设置 |
| `library_list` | 无 | 已注册媒体库及卷标、卷 ID、在线状态 |
| `library_register` | `rootPath` | 仅用于用户选择的路径；规范化、记录卷身份并返回 library DTO |
| `library_set_active` | `libraryId` | 设置当前库 |
| `library_remove` | `libraryId`、`forgetMetadata` | 删除注册关系/元数据；不删除原始媒体，破坏性选项需二次确认 |
| `volume_list` | 无 | 可用卷的显示信息、可移动标记和卷唯一标识 |

### 查询和媒体资源

| Command | 入参 | 返回值/说明 |
| --- | --- | --- |
| `media_query` | library、日期、类型、关键词、收藏/连拍、排序、page/limit | 分页 items、总数、日期聚合、统计；不返回未经授权的绝对路径 |
| `media_get` | `mediaItemId` | 逻辑项详情、文件角色、可用性、元数据 |
| `media_resource` | `mediaFileId`、规格/范围 | 返回受控资源句柄或由自定义协议消费的授权 token；后端校验路径 |
| `media_open_folder` | `mediaItemId` | 后端解析文件并调用系统打开其所在目录 |
| `favorite_set` | `mediaItemId`、`favorite` | 在事务中写入/删除 favorites |
| `tag_set` | `mediaItemId`、tag 变化 | P1；只改变数据库，不改变原始文件 |
| `notes_set` | `mediaItemId`、rating、note | P1 |

### 长任务和管理

| Command | 入参 | 返回值/说明 |
| --- | --- | --- |
| `library_scan_start` | `libraryId`、扫描选项、进度 Channel | `{ jobId, scanRunId }`；增量扫描 |
| `thumbnail_rebuild_start` | `libraryId`、筛选范围、进度 Channel | `{ jobId }`；缓存可重建 |
| `job_get` | `jobId` | 当前状态和最后快照，供重连/恢复界面 |
| `job_cancel` | `jobId` | 请求取消；任务在安全边界停止并发出最终 cancelled |
| `media_delete_to_recycle_bin` | `mediaItemIds`、确认 token、进度 Channel | 后端重新解析全部文件，预检通过后移入回收站 |
| `backup_sources_discover` | 无/规则 | 返回包含 DCIM 的候选可移动卷 |
| `backup_preview` | source volume ID、target library ID、规则 | `{ previewId, items, conflicts, requiredBytes, freeBytes }` |
| `backup_start` | `previewId`、确认 token、进度 Channel | `{ jobId, backupRunId }`；按计划复制、校验、记录结果 |
| `backup_retry_failed` | `backupRunId`、item IDs、进度 Channel | 只重试明确失败项，并重新验证卷身份 |

### 错误合约

所有 command 失败都返回可序列化错误对象，而不是把任意底层错误字符串直接展示给用户：

```json
{
  "code": "LIBRARY_OFFLINE",
  "message": "媒体库所在卷当前不可用",
  "retryable": true,
  "details": { "libraryId": "..." }
}
```

至少定义：`INVALID_ARGUMENT`、`LIBRARY_OFFLINE`、`PATH_OUTSIDE_ROOT`、`VOLUME_CHANGED`、`MEDIA_MISSING`、`CONFLICT`、`INSUFFICIENT_SPACE`、`JOB_NOT_FOUND`、`JOB_ALREADY_RUNNING`、`CANCELLED`、`IO_ERROR`、`DATABASE_ERROR`、`THUMBNAIL_ERROR`。

## 2. 长任务进度 event/channel

### 2.1 传输选择

每个长任务由一个 Tauri `Channel<JobEvent>` 绑定，command 立即返回 `jobId`。前端还可以调用 `job_get` 获取最新快照，因此短暂丢失 Channel 不会让进度不可恢复。全局广播 event 只用于“库状态已变化”等轻量通知，不承载逐文件进度。

```text
start command + Channel<JobEvent>
        ↓ returns jobId
background worker → bounded/coalescing progress channel → UI
        ↓
job_get / persisted scan_runs / backup_runs
```

### 2.2 事件结构

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
  "current": { "displayName": "IMG_001.jpg", "relativePath": "2026/08/2026-08-16/照片/IMG_001.jpg" },
  "speedBytesPerSecond": 0,
  "etaSeconds": null,
  "message": "正在读取元数据",
  "error": null,
  "at": "2026-09-06T00:00:00Z"
}
```

`state` 取 `queued|running|completed|cancelled|failed`；`phase` 取 `discovering|planning|copying|hashing|indexing|thumbnailing|finalizing` 等。绝对路径不放入事件，错误详情也不得泄露不必要的系统路径。

### 2.3 交付规则

- `seq` 在一个 job 内单调递增；UI 丢事件后以 `job_get` 快照修正。
- 逐文件事件可合并，只保留最新进度，避免 200 GB 备份造成 UI 和 IPC 洪峰；失败项和最终汇总不可丢。
- 每个 job 只发送一个终态事件；终态写入对应的 `scan_runs` 或 `backup_runs` 后再发送。
- 取消是协作式的：复制文件完成、批事务提交和安全边界处检查取消 token；不强杀正在写入的文件。
- 同一 library 的扫描、删除、备份刷新在任务管理器中串行化；只读查询可并行。

## 3. 路径安全策略

### 3.1 根目录注册

用户通过文件夹选择器提供根目录。后端必须：

1. 要求目录存在且可读取；规范化绝对路径并保存 canonical root。
2. 读取 Windows 卷唯一标识、卷标和当前盘符；盘符仅作展示。
3. 拒绝把应用数据目录、缓存目录或临时目录注册为正式媒体库，避免误删应用文件。
4. 断盘时保留库记录，状态为 offline；恢复后重新验证卷 ID 和根目录，再允许写操作。

### 3.2 文件解析

- 前端和外部请求只提交 `libraryId`、`mediaItemId` 或库根目录下的相对路径；删除不接受前端传入的任意文件数组。
- 相对路径必须是非空、非绝对路径，统一 `\\`/`/` 后逐段拒绝 `.`、`..`、空段和 Windows 设备路径前缀。
- 解析后做 component-aware containment check，不能只做字符串前缀比较，以防 `DCIM-local-evil` 这类兄弟目录绕过。
- 现有文件要 canonicalize 后再检查根目录；创建目标要先 canonicalize 已存在的父目录，并检查每个新建段不经过不受信任的 junction/reparse point。
- Windows 大小写、UNC 路径、长路径、盘符变化和卷变化都要在测试中覆盖；路径比较按 Windows 语义执行。
- 文件打开、读取、删除前再次检查状态，降低检查与使用之间的 TOCTOU 风险；关键写操作尽量使用 Windows handle 级约束。

### 3.3 媒体、缓存和备份

- 默认只读：扫描、查询、预览不能改变原始媒体。
- 资源访问只允许注册库内的 `media_files.relative_path`，缩略图只允许应用缓存目录；不提供“任意路径读取”command。
- 删除以 `mediaItemId` 为输入，后端从数据库取得所有物理成员，先完整预检，再逐个调用 Windows 回收站；记录每个文件结果和部分成功状态。
- 备份前锁定源卷身份、源相对路径清单、目标 library 和空间预估；源卷断开或目标卷身份改变时立即失败，不继续猜测。
- 复制到目标时先写同目录临时文件，flush/关闭并校验大小，必要时校验哈希后原子 rename；不覆盖已有内容，除非用户明确选定覆盖策略。
- 不修改或删除相机源盘文件；`.lrv`/`.dng` 是否忽略来自设置并写入 `backup_runs`，而不是隐藏在实现常量中。
- 缩略图生成失败只影响缓存状态，不影响原始文件和索引；缓存清理不可触及媒体库根目录。

## 4. 测试策略

### 4.1 纯 Rust 单元测试

- 路径：`..`、绝对路径、UNC、大小写、兄弟目录前缀、符号链接/junction、缺失父目录、卷 ID 不匹配、允许和拒绝的扩展名。
- 配对：单照片、单视频、同 stem 实况照片、重复 stem、一对多、缺日期目录、缺失配对成员。
- 扫描：重复扫描幂等、文件修改只更新必要字段、外部删除标记 missing、收藏/标签/备注保持、取消不误报完整成功。
- 数据库：迁移顺序、外键、唯一约束、分页排序、日期/类型/收藏/连拍过滤和事务回滚。
- 备份计划：同大小相同内容、同大小不同内容、冲突重命名、空间不足、忽略扩展名、校验失败、重试和取消。

### 4.2 临时目录集成测试

所有文件系统测试使用每个用例独立的临时源/目标目录和虚拟卷信息；删除使用 `FakeRecycleBin`，断言源文件仍可在替身回收站中恢复。测试不得写入 `H:\DCIM-local`，不得读取或复制真实 H 盘媒体、缩略图、清单和日志。

应覆盖真实原型的最小合成 fixture：照片+视频同 stem、重复文件名、旧日期目录、无日期文件、损坏图片、ffmpeg 失败和中途断盘。fixture 只放入测试目录，不放入仓库媒体目录。

### 4.3 前端和端到端

- 先为 command DTO、错误码和 `JobEvent` 建类型/契约测试。
- UI 测试验证分页、过滤、预览、键盘导航、收藏持久化、断盘状态、确认删除和任务取消；使用 mock command/channel。
- Windows smoke test 再验证回收站、盘符/卷识别、视频资源 range 播放和文件夹打开；仍使用临时目录。
- CI 基线：`pnpm build`、`cargo fmt --check`、`cargo check`、`cargo test`，业务前端测试加入后再执行 `pnpm test`。
- 可选的属性测试/模糊测试重点放在路径解析和媒体 stem 配对，防止安全检查退化为字符串拼接。

## 5. 分阶段开发顺序

### 阶段 0：架构基线（本会话）

完成审计文档、SQLite 模型、command/event 合约、路径边界和测试矩阵；不接入真实 H 盘自动化，不实现业务功能。

### 阶段 1：Tauri 基础设施

建立应用数据/缓存目录、单实例、设置存储、卷信息读取、库注册和断盘状态。收紧 capabilities 与 CSP，先把路径安全模块和测试替身建好。

### 阶段 2：SQLite 与增量扫描

加入迁移、repository、扫描事务和逻辑项配对。先用临时 fixture 验证幂等、missing、收藏状态保留，再接查询 command。

### 阶段 3：媒体查询与预览

实现 SQL 分页、日期聚合、过滤排序、受控图片/视频资源访问。随后加入缩略图缓存、EXIF 基础字段和视频首帧适配器；ffmpeg 以可检测失败的 sidecar/适配器接入。

### 阶段 4：前端媒体库与管理

替换默认欢迎页，实现网格、预览、键盘操作、密度、收藏和选择。删除只接收逻辑项 ID，经后端二次确认后进入 Windows 回收站；所有测试继续使用临时目录。

### 阶段 5：备份工作流

实现可移动卷发现、DCIM 候选、备份预览、冲突策略、空间检查、临时文件复制、大小/哈希校验、取消、失败重试和备份历史。完成后触发增量扫描。

### 阶段 6：体验与发布加固

加入标签/评分/备注、通知、托盘、单实例体验、更多 EXIF、重复检测和离线恢复；补齐 Windows smoke test、打包检查、日志脱敏和升级迁移。

### 当前开发门槛

在阶段 1 至 5 完成前，不应把真实 `H:\DCIM-local` 接入自动扫描、删除或备份自动化。真实盘只允许人工只读检查；仓库继续禁止出现 H 盘媒体、缩略图或静态清单副本。

