CREATE TABLE IF NOT EXISTS backup_items (
    id TEXT PRIMARY KEY NOT NULL,
    backup_run_id TEXT NOT NULL REFERENCES backup_runs(id) ON DELETE CASCADE,
    source_relative TEXT NOT NULL,
    destination_relative TEXT,
    size_bytes INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL CHECK (status IN ('planned', 'copied', 'skipped', 'failed', 'cancelled')),
    copied_bytes INTEGER NOT NULL DEFAULT 0,
    error_message TEXT
);

CREATE INDEX IF NOT EXISTS idx_backup_items_run_status
    ON backup_items (backup_run_id, status);
