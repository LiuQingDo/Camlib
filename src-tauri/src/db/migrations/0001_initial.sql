CREATE TABLE IF NOT EXISTS libraries (
    id TEXT PRIMARY KEY NOT NULL,
    root_path TEXT NOT NULL UNIQUE,
    volume_id TEXT,
    volume_label TEXT,
    drive_letter TEXT,
    state TEXT NOT NULL CHECK (state IN ('available', 'offline', 'invalid')),
    last_seen_at TEXT,
    last_scan_at TEXT,
    scan_generation INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS media_items (
    id TEXT PRIMARY KEY NOT NULL,
    library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
    logical_key TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('photo', 'video', 'live')),
    display_name TEXT NOT NULL,
    capture_at TEXT,
    capture_date TEXT,
    width INTEGER,
    height INTEGER,
    duration_ms INTEGER,
    total_size_bytes INTEGER NOT NULL DEFAULT 0,
    burst_group TEXT,
    metadata_json TEXT,
    scan_state TEXT NOT NULL DEFAULT 'present'
        CHECK (scan_state IN ('present', 'missing', 'ambiguous', 'error')),
    first_seen_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    UNIQUE (library_id, logical_key)
);

CREATE TABLE IF NOT EXISTS media_files (
    id TEXT PRIMARY KEY NOT NULL,
    media_item_id TEXT NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
    library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('single', 'live_photo', 'live_video')),
    relative_path TEXT NOT NULL,
    file_name TEXT NOT NULL,
    extension TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    modified_at TEXT NOT NULL,
    content_hash TEXT,
    hash_algorithm TEXT,
    file_identity TEXT,
    exists_now INTEGER NOT NULL DEFAULT 1 CHECK (exists_now IN (0, 1)),
    last_scanned_at TEXT NOT NULL,
    UNIQUE (library_id, relative_path),
    UNIQUE (media_item_id, role)
);

CREATE TABLE IF NOT EXISTS favorites (
    media_item_id TEXT PRIMARY KEY NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tags (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL UNIQUE,
    color TEXT,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS media_tags (
    media_item_id TEXT NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
    tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    PRIMARY KEY (media_item_id, tag_id)
);

CREATE TABLE IF NOT EXISTS backup_runs (
    id TEXT PRIMARY KEY NOT NULL,
    job_id TEXT NOT NULL,
    source_volume_id TEXT,
    source_root_path TEXT NOT NULL,
    target_library_id TEXT NOT NULL REFERENCES libraries(id),
    status TEXT NOT NULL CHECK (status IN ('preview', 'running', 'completed', 'cancelled', 'failed')),
    conflict_policy TEXT NOT NULL CHECK (conflict_policy IN ('skip_same', 'rename', 'overwrite')),
    ignore_extensions TEXT NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    total_files INTEGER NOT NULL DEFAULT 0,
    copied_files INTEGER NOT NULL DEFAULT 0,
    skipped_files INTEGER NOT NULL DEFAULT 0,
    failed_files INTEGER NOT NULL DEFAULT 0,
    total_bytes INTEGER NOT NULL DEFAULT 0,
    copied_bytes INTEGER NOT NULL DEFAULT 0,
    error_summary TEXT
);

CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY NOT NULL,
    value_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_media_items_library_date
    ON media_items (library_id, capture_date DESC, display_name);
CREATE INDEX IF NOT EXISTS idx_media_items_library_kind_date
    ON media_items (library_id, kind, capture_date DESC, display_name);
CREATE INDEX IF NOT EXISTS idx_media_items_scan_state
    ON media_items (library_id, scan_state);
CREATE INDEX IF NOT EXISTS idx_media_items_burst_group
    ON media_items (library_id, burst_group);
CREATE INDEX IF NOT EXISTS idx_media_files_item_role
    ON media_files (media_item_id, role);
CREATE INDEX IF NOT EXISTS idx_media_files_library_path
    ON media_files (library_id, relative_path);
CREATE INDEX IF NOT EXISTS idx_media_items_favorites
    ON favorites (media_item_id);
CREATE INDEX IF NOT EXISTS idx_media_tags_tag
    ON media_tags (tag_id, media_item_id);
CREATE INDEX IF NOT EXISTS idx_backup_runs_target_status
    ON backup_runs (target_library_id, status, started_at DESC);
