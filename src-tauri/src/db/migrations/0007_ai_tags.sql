-- Optional AI enhancement (cloud API): auto tagging + semantic search.
-- One row per processed media item. `embedding` holds the caption embedding
-- as little-endian f32 BLOB; `embedding_model` guards retrieval so a model
-- switch never mixes incompatible vectors.
CREATE TABLE IF NOT EXISTS media_ai (
    media_item_id TEXT PRIMARY KEY NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
    caption TEXT,
    tags_json TEXT,
    embedding BLOB,
    embedding_model TEXT,
    ai_model TEXT,
    embedding_dim INTEGER,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'success', 'failed')),
    error_message TEXT,
    processed_at TEXT
);

-- AI tag assignments live in their own relation table. `tags` rows are shared
-- (same-name tags are reused), but user-managed `media_tags` rows are never
-- touched by AI processing and vice versa, so detaching a user tag cannot
-- remove an AI tag.
CREATE TABLE IF NOT EXISTS media_ai_tags (
    media_item_id TEXT NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
    tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    PRIMARY KEY (media_item_id, tag_id)
);

CREATE INDEX IF NOT EXISTS idx_media_ai_status
    ON media_ai (status);
CREATE INDEX IF NOT EXISTS idx_media_ai_tags_tag
    ON media_ai_tags (tag_id, media_item_id);
