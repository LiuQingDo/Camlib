CREATE TABLE IF NOT EXISTS media_ratings (
    media_item_id TEXT PRIMARY KEY NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
    rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
    updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_media_ratings_rating
    ON media_ratings (rating);
