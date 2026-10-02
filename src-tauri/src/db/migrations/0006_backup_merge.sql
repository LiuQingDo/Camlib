-- Camera auto-split video segments merge support.
-- When non-NULL, this backup item is a multi-source merge job and the column
-- holds a JSON array of source_relative paths in playback order.
ALTER TABLE backup_items ADD COLUMN merge_sources_json TEXT;
