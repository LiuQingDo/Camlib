CREATE TABLE IF NOT EXISTS scan_runs (
    id TEXT PRIMARY KEY NOT NULL,
    library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
    job_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'cancelled', 'failed')),
    started_at TEXT NOT NULL,
    finished_at TEXT,
    files_seen INTEGER NOT NULL DEFAULT 0,
    items_added INTEGER NOT NULL DEFAULT 0,
    items_updated INTEGER NOT NULL DEFAULT 0,
    items_missing INTEGER NOT NULL DEFAULT 0,
    errors INTEGER NOT NULL DEFAULT 0,
    error_summary TEXT
);

CREATE INDEX IF NOT EXISTS idx_scan_runs_library_started
    ON scan_runs (library_id, started_at DESC);
