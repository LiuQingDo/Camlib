-- Drop the caption-embedding columns: natural-language search now matches the
-- stored captions/tags directly, so no vector is produced or read any more.
-- SQLite 3.35+ (bundled here) supports DROP COLUMN; the columns carry no index
-- or constraint, so the rewrite only rewrites the table once.
ALTER TABLE media_ai DROP COLUMN embedding;
ALTER TABLE media_ai DROP COLUMN embedding_model;
ALTER TABLE media_ai DROP COLUMN embedding_dim;
