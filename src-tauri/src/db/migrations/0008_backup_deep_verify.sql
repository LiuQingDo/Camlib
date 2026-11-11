-- Optional deep verification for camera backup.
-- When 1, the executor compares a streaming content hash of the source file
-- with the bytes actually written into the library instead of trusting the
-- file size alone. Stored on the run (not only in the request) so a retry or a
-- restart keeps the guarantee the user confirmed in the preview.
ALTER TABLE backup_runs ADD COLUMN deep_verify INTEGER NOT NULL DEFAULT 0;
