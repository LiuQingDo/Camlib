# Camlib SQLite 数据模型

> 真相来源：`src-tauri/src/db/migrations/`  
> 当前 schema 版本：`CURRENT_SCHEMA_VERSION = 5`（`src-tauri/src/db/mod.rs`）  
> 迁移在应用启动时按版本顺序自动执行；版本过高时拒绝打开，避免降级损坏。

## 1. 设计原则

- 数据库位于 SSD 应用数据目录；原始媒体和缩略图不进入数据库。
- 只保存相对于已注册媒体库根目录的规范化相对路径；路径拼接权不交给前端。
- `media_items` 表示用户看到的逻辑媒体；`media_files` 表示实际物理文件。
- 业务状态（收藏、标签、评分）与扫描状态分离：文件暂时离线不应清除用户状态。
- 时间使用 ISO 8601 UTC 文本或整数毫秒；拍摄日期另存 `YYYY-MM-DD` 便于分组。
- 外部输入使用参数化 SQL；迁移使用版本号并在事务中执行。

## 2. 迁移一览

| 版本 | 文件 | 内容 |
| --- | --- | --- |
| 1 | `0001_initial.sql` | libraries、media_items、media_files、favorites、tags、media_tags、backup_runs、app_settings + 索引 |
| 2 | `0002_scan_runs.sql` | scan_runs（扫描任务结果） |
| 3 | `0003_deletion_logs.sql` | deletion_logs（删除结果明细） |
| 4 | `0004_backup_items.sql` | backup_items（备份单文件状态） |
| 5 | `0005_media_ratings.sql` | media_ratings（1–5 星评分） |

## 3. 表结构（与迁移对齐）

下列 SQL 摘自迁移文件，便于阅读；**修改 schema 必须新增迁移文件**，不要只改本文。

### 核心索引与用户状态（v1）

```sql
PRAGMA foreign_keys = ON;

CREATE TABLE libraries (
  id                 TEXT PRIMARY KEY,
  root_path          TEXT NOT NULL UNIQUE,
  volume_id          TEXT,
  volume_label       TEXT,
  drive_letter       TEXT,
  state              TEXT NOT NULL CHECK (state IN ('available','offline','invalid')),
  last_seen_at       TEXT,
  last_scan_at       TEXT,
  scan_generation    INTEGER NOT NULL DEFAULT 0,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);

CREATE TABLE media_items (
  id                 TEXT PRIMARY KEY,
  library_id         TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  logical_key        TEXT NOT NULL,
  kind               TEXT NOT NULL CHECK (kind IN ('photo','video','live')),
  display_name       TEXT NOT NULL,
  capture_at         TEXT,
  capture_date       TEXT,
  width              INTEGER,
  height             INTEGER,
  duration_ms        INTEGER,
  total_size_bytes   INTEGER NOT NULL DEFAULT 0,
  burst_group        TEXT,
  metadata_json      TEXT,
  scan_state         TEXT NOT NULL DEFAULT 'present'
                     CHECK (scan_state IN ('present','missing','ambiguous','error')),
  first_seen_at      TEXT NOT NULL,
  last_seen_at       TEXT NOT NULL,
  UNIQUE (library_id, logical_key)
);

CREATE TABLE media_files (
  id                 TEXT PRIMARY KEY,
  media_item_id      TEXT NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
  library_id         TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  role               TEXT NOT NULL CHECK (role IN ('single','live_photo','live_video')),
  relative_path      TEXT NOT NULL,
  file_name          TEXT NOT NULL,
  extension          TEXT NOT NULL,
  size_bytes         INTEGER NOT NULL,
  modified_at        TEXT NOT NULL,
  content_hash       TEXT,
  hash_algorithm     TEXT,
  file_identity      TEXT,
  exists_now         INTEGER NOT NULL DEFAULT 1 CHECK (exists_now IN (0,1)),
  last_scanned_at    TEXT NOT NULL,
  UNIQUE (library_id, relative_path),
  UNIQUE (media_item_id, role)
);

CREATE TABLE favorites (
  media_item_id      TEXT PRIMARY KEY REFERENCES media_items(id) ON DELETE CASCADE,
  created_at         TEXT NOT NULL
);

CREATE TABLE tags (
  id                 TEXT PRIMARY KEY,
  name               TEXT NOT NULL UNIQUE,
  color              TEXT,
  created_at         TEXT NOT NULL
);

CREATE TABLE media_tags (
  media_item_id      TEXT NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
  tag_id             TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  created_at         TEXT NOT NULL,
  PRIMARY KEY (media_item_id, tag_id)
);

CREATE TABLE backup_runs (
  id                 TEXT PRIMARY KEY,
  job_id             TEXT NOT NULL,
  source_volume_id   TEXT,
  source_root_path   TEXT NOT NULL,
  target_library_id  TEXT NOT NULL REFERENCES libraries(id),
  status             TEXT NOT NULL CHECK (status IN ('preview','running','completed','cancelled','failed')),
  conflict_policy    TEXT NOT NULL CHECK (conflict_policy IN ('skip_same','rename','overwrite')),
  ignore_extensions  TEXT NOT NULL,
  started_at         TEXT NOT NULL,
  finished_at        TEXT,
  total_files        INTEGER NOT NULL DEFAULT 0,
  copied_files       INTEGER NOT NULL DEFAULT 0,
  skipped_files      INTEGER NOT NULL DEFAULT 0,
  failed_files       INTEGER NOT NULL DEFAULT 0,
  total_bytes        INTEGER NOT NULL DEFAULT 0,
  copied_bytes       INTEGER NOT NULL DEFAULT 0,
  error_summary      TEXT
);

CREATE TABLE app_settings (
  key                TEXT PRIMARY KEY,
  value_json         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);
```

### 扫描与删除（v2–v3）

```sql
CREATE TABLE scan_runs (
  id                 TEXT PRIMARY KEY,
  library_id         TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  job_id             TEXT NOT NULL,
  status             TEXT NOT NULL CHECK (status IN ('running','completed','cancelled','failed')),
  started_at         TEXT NOT NULL,
  finished_at        TEXT,
  files_seen         INTEGER NOT NULL DEFAULT 0,
  items_added        INTEGER NOT NULL DEFAULT 0,
  items_updated      INTEGER NOT NULL DEFAULT 0,
  items_missing      INTEGER NOT NULL DEFAULT 0,
  errors             INTEGER NOT NULL DEFAULT 0,
  error_summary      TEXT
);

CREATE TABLE deletion_logs (
  id             TEXT PRIMARY KEY,
  media_item_id  TEXT NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
  media_file_id  TEXT REFERENCES media_files(id) ON DELETE SET NULL,
  relative_path  TEXT,
  action         TEXT NOT NULL,
  status         TEXT NOT NULL,
  error_message  TEXT,
  created_at     TEXT NOT NULL
);
```

### 备份明细与评分（v4–v5）

```sql
CREATE TABLE backup_items (
  id                 TEXT PRIMARY KEY,
  backup_run_id      TEXT NOT NULL REFERENCES backup_runs(id) ON DELETE CASCADE,
  source_relative    TEXT NOT NULL,
  destination_rel    TEXT,
  source_size_bytes  INTEGER NOT NULL,
  destination_size   INTEGER,
  source_hash        TEXT,
  destination_hash   TEXT,
  status             TEXT NOT NULL CHECK (status IN ('planned','copied','skipped','failed','cancelled')),
  error_message      TEXT
);

CREATE TABLE media_ratings (
  media_item_id      TEXT PRIMARY KEY REFERENCES media_items(id) ON DELETE CASCADE,
  rating             INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  updated_at         TEXT NOT NULL
);
```

说明：

- **没有** `media_notes` 备注表；备注若要做，需新增迁移。
- 评分存在独立 `media_ratings` 表；`rating = 0` 表示未评分（删除行）。
- 扫描 upsert **不得**改写 favorites / tags / ratings。

## 4. 索引与查询约定

v1 已建索引包括：

```sql
idx_media_items_library_date     -- (library_id, capture_date DESC, display_name)
idx_media_items_library_kind_date
idx_media_items_scan_state
idx_media_items_burst_group
idx_media_files_item_role
idx_media_files_library_path
idx_media_items_favorites
idx_media_tags_tag
idx_backup_runs_target_status
idx_backup_items_run_status      -- v4
idx_media_ratings_rating         -- v5
```

文件名搜索使用 `display_name LIKE ? ESCAPE '\\'` 并对用户输入做通配符转义；数据量增大后再评估 FTS5。日期导航、类型统计、收藏/评分过滤由 SQL 聚合完成，不在前端持有全库数组。

## 5. 扫描一致性

1. 扫描开始创建 `scan_runs`，记录本次 `scan_generation`。
2. 枚举时只写入相对路径、大小、修改时间和可选文件身份；未变化文件跳过缩略图、EXIF 和哈希。
3. 每批文件在短事务中 upsert；逻辑配对在同一目录/日期/规范化 stem 范围内完成；一对多或多对多标记 `ambiguous`，不得静默覆盖。
4. 扫描结束后，本次 generation 未见到的文件标记 `exists_now=0`，关联逻辑项标为 `missing`；**不删除** favorites、tags、ratings。
5. 只有扫描成功提交后才更新 `libraries.last_scan_at`；取消或断盘时保留部分进度，不把未完成扫描宣称为完整索引。
6. 逻辑项 ID 使用数据库持久化 ID；重新扫描优先按相对路径/文件身份/哈希重连，避免收藏/评分丢失。

## 6. 缩略图缓存键

缩略图不建为数据库 BLOB。缓存键包含文件身份与规格，例如：

```text
<cache-root>\thumbs\<library-id>\<file-id>-<fingerprint>-<width>x<height>-v<processor>.jpg
```

缓存失效只删除或覆盖缓存文件，不影响 SQLite 记录和原始文件。
