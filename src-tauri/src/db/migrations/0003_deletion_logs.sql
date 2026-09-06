CREATE TABLE IF NOT EXISTS deletion_logs (
    id TEXT PRIMARY KEY NOT NULL,
    media_item_id TEXT NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
    media_file_id TEXT REFERENCES media_files(id) ON DELETE SET NULL,
    relative_path TEXT,
    action TEXT NOT NULL CHECK (action IN ('recycle', 'already_missing', 'rejected')),
    status TEXT NOT NULL CHECK (status IN ('completed', 'failed', 'skipped')),
    error_message TEXT,
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_deletion_logs_item_created
    ON deletion_logs (media_item_id, created_at DESC);
