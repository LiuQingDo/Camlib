# Camlib SQLite 数据模型

> 这是当前 SQLite 模型；迁移由 `src-tauri/src/db/migrations` 管理。

## 1. 设计原则

- 数据库位于 SSD 应用数据目录；原始媒体和缩略图不进入数据库。
- 数据库只保存相对于已注册媒体库根目录的规范化相对路径，不把路径拼接权交给前端。
- `media_items` 表示用户看到的逻辑媒体；`media_files` 表示实际物理文件。
- 业务状态与扫描状态分离：文件暂时离线不应清除收藏、标签或备注。
- 所有时间使用 ISO 8601 UTC 文本或整数毫秒，界面按本地时区显示；拍摄日期另存为 `YYYY-MM-DD` 便于分组。
- 所有外部输入使用参数化 SQL；迁移使用单独版本号并在事务中执行。

## 2. 表结构

下面的 SQL 是建议基线，实际实现时可拆分为 `migrations/0001_initial.sql` 等迁移文件。

```sql
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;

CREATE TABLE schema_migrations (
  version        INTEGER PRIMARY KEY,
  applied_at     TEXT NOT NULL
);

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
  UNIQUE (library_id, relative_path)
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

CREATE TABLE media_notes (
  media_item_id      TEXT PRIMARY KEY REFERENCES media_items(id) ON DELETE CASCADE,
  rating             INTEGER CHECK (rating IS NULL OR rating BETWEEN 0 AND 5),
  note               TEXT,
  updated_at         TEXT NOT NULL
);

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

CREATE TABLE app_settings (
  key                TEXT PRIMARY KEY,
  value_json         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
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

## 3. 索引和查询约定

```sql
CREATE INDEX idx_items_library_date
  ON media_items(library_id, capture_date DESC, display_name);
CREATE INDEX idx_items_library_kind_date
  ON media_items(library_id, kind, capture_date DESC);
CREATE INDEX idx_items_scan_state
  ON media_items(library_id, scan_state);
CREATE INDEX idx_files_item
  ON media_files(media_item_id, role);
CREATE INDEX idx_files_path
  ON media_files(library_id, relative_path);
CREATE INDEX idx_burst_group
  ON media_items(library_id, burst_group);
CREATE INDEX idx_backup_items_run_status
  ON backup_items(backup_run_id, status);
```

文件名搜索第一版可使用 `display_name LIKE ? ESCAPE '\\'`，并对用户输入做通配符转义；数据量增大后再评估 SQLite FTS5。日期导航、类型统计和收藏过滤都应由 SQL 聚合完成，不复制原型的全库 `ALL` 数组。

## 4. 扫描一致性

1. 扫描开始创建 `scan_runs`，记录本次 `scan_generation`。
2. 枚举文件时只写入相对路径、大小、修改时间和可选的文件身份；对未变化文件跳过缩略图、EXIF 和哈希计算。
3. 每批文件在短事务中 upsert；逻辑配对在同一目录/日期/规范化 stem 范围内完成，发生一对多或多对多时标记 `ambiguous`，不得静默覆盖。
4. 扫描结束后，将本次 generation 未见到的文件标记 `exists_now=0`，将关联逻辑项标为 `missing`；不删除 favorites、tags、notes。
5. 只有扫描成功提交后才更新 `libraries.last_scan_at`；取消或断盘时保留部分进度，但不把未完成扫描宣称为完整索引。
6. 逻辑项 ID 使用数据库持久化 ID；重新扫描优先按文件相对路径/文件身份/哈希重连，避免仅因排序或清单分片变化导致收藏丢失。

## 5. 缩略图缓存键

缩略图不建为原始媒体表中的 BLOB。建议缓存键包含 `media_file_id`、`size_bytes`、`modified_at`、缩略图规格、处理器版本和可选 content hash，例如：

```text
<cache-root>\thumbs\<library-id>\<file-id>-<fingerprint>-<width>x<height>-v<processor>.jpg
```

缓存失效只删除或覆盖缓存文件，不影响 SQLite 中的媒体记录和原始文件。
