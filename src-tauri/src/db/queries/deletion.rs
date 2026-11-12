//! Deletion audit log and offline-row purging.

use crate::db::{current_timestamp, validate_non_empty, DbResult, Repository};
use rusqlite::{params, OptionalExtension};

impl Repository {
    /// Record the filesystem outcome separately from the logical item. This
    /// keeps partial failures and repeated-delete attempts auditable.
    pub fn record_deletion_log(&self, input: DeletionLogInput<'_>) -> DbResult<()> {
        validate_non_empty("deletion log id", input.id)?;
        validate_non_empty("media item id", input.media_item_id)?;
        validate_non_empty("status", input.status)?;
        validate_non_empty("created_at", input.created_at)?;
        self.connection.execute(
            "INSERT INTO deletion_logs
             (id, media_item_id, media_file_id, relative_path, action, status, error_message, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                input.id,
                input.media_item_id,
                input.media_file_id,
                input.relative_path,
                input.action,
                input.status,
                input.error_message,
                input.created_at,
            ],
        )?;
        Ok(())
    }

    pub fn mark_media_file_deleted(&self, file_id: &str, at: &str) -> DbResult<()> {
        validate_non_empty("media file id", file_id)?;
        self.connection.execute(
            "UPDATE media_files SET exists_now = 0, last_scanned_at = ?2 WHERE id = ?1",
            params![file_id, at],
        )?;
        let item_id: Option<String> = self
            .connection
            .query_row(
                "SELECT media_item_id FROM media_files WHERE id = ?1",
                [file_id],
                |row| row.get(0),
            )
            .optional()?;
        if let Some(item_id) = item_id {
            self.refresh_media_item_state(&item_id)?;
        }
        Ok(())
    }

    pub fn refresh_media_item_state(&self, media_item_id: &str) -> DbResult<()> {
        let (total, present): (i64, i64) = self.connection.query_row(
            "SELECT COUNT(*), COALESCE(SUM(exists_now), 0) FROM media_files WHERE media_item_id = ?1",
            [media_item_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        let state = if present == 0 {
            "missing"
        } else if present < total {
            "error"
        } else {
            "present"
        };
        self.connection.execute(
            "UPDATE media_items SET scan_state = ?2, last_seen_at = ?3 WHERE id = ?1",
            params![media_item_id, state, current_timestamp()],
        )?;
        Ok(())
    }

    /// Remove index rows for files the app itself deleted (merge source
    /// recycle). Items left without any file row are dropped too, cascading
    /// favorites, tags, ratings and deletion logs. Scan-apply keeps rows whose
    /// files vanished outside the app as offline cards; a merge recycle is
    /// deliberate, so the old segment cards must not linger in the media list.
    /// Relative paths use the scanner form with `/` separators.
    pub fn purge_files_and_empty_items(
        &self,
        library_id: &str,
        relative_paths: &[String],
    ) -> DbResult<(usize, usize)> {
        let transaction = self.connection.unchecked_transaction()?;
        let mut files_removed = 0usize;
        let mut items_removed = 0usize;
        {
            let mut item_query = transaction.prepare(
                "SELECT DISTINCT media_item_id FROM media_files
                 WHERE library_id = ?1 AND relative_path = ?2",
            )?;
            let mut file_delete = transaction
                .prepare("DELETE FROM media_files WHERE library_id = ?1 AND relative_path = ?2")?;
            let mut item_delete = transaction.prepare(
                "DELETE FROM media_items WHERE library_id = ?1 AND id = ?2
                 AND NOT EXISTS
                 (SELECT 1 FROM media_files f WHERE f.media_item_id = media_items.id)",
            )?;
            for relative_path in relative_paths {
                let item_ids = item_query
                    .query_map(params![library_id, relative_path], |row| {
                        row.get::<_, String>(0)
                    })?
                    .collect::<Result<Vec<_>, _>>()?;
                files_removed += file_delete.execute(params![library_id, relative_path])?;
                for item_id in item_ids {
                    items_removed += item_delete.execute(params![library_id, item_id])?;
                }
            }
        }
        transaction.commit()?;
        Ok((files_removed, items_removed))
    }

    /// Drop every offline (`missing`) item of a library from the index. Only
    /// rows whose files are all gone qualify; present, partial (`error`) and
    /// ambiguous items stay. Guarded by a library availability check upstream
    /// so an unplugged drive cannot wipe a healthy index.
    pub fn purge_missing_items(&self, library_id: &str) -> DbResult<usize> {
        self.connection
            .execute(
                "DELETE FROM media_items WHERE library_id = ?1 AND scan_state = 'missing'",
                params![library_id],
            )
            .map_err(Into::into)
    }

    #[cfg(test)]
    pub fn deletion_log_count(&self, media_item_id: &str) -> DbResult<i64> {
        Ok(self.connection.query_row(
            "SELECT COUNT(*) FROM deletion_logs WHERE media_item_id = ?1",
            [media_item_id],
            |row| row.get(0),
        )?)
    }
}

pub struct DeletionLogInput<'a> {
    pub id: &'a str,
    pub media_item_id: &'a str,
    pub media_file_id: Option<&'a str>,
    pub relative_path: Option<&'a str>,
    pub action: &'a str,
    pub status: &'a str,
    pub error_message: Option<&'a str>,
    pub created_at: &'a str,
}

#[cfg(test)]
mod tests {
    use crate::db::test_support::{file, item, library};
    use crate::db::*;

    #[test]
    fn purge_files_drops_fileless_items_and_keeps_partially_intact_items() {
        let repository = Repository::open_in_memory().unwrap();
        repository.create_library(library()).unwrap();
        repository
            .upsert_media_item(item("segment-13", MediaKind::Video))
            .unwrap();
        repository
            .upsert_media_file(file(
                "file-13",
                "segment-13",
                MediaFileRole::Single,
                "2026/08/VID_A_013.mp4",
            ))
            .unwrap();
        repository
            .upsert_media_item(item("segment-14", MediaKind::Video))
            .unwrap();
        repository
            .upsert_media_file(file(
                "file-14",
                "segment-14",
                MediaFileRole::Single,
                "2026/08/VID_A_014.mp4",
            ))
            .unwrap();
        repository
            .upsert_live_photo(LivePhotoInput {
                item: item("live-1", MediaKind::Live),
                photo: file(
                    "file-live-jpg",
                    "live-1",
                    MediaFileRole::LivePhoto,
                    "2026/08/IMG_1.JPG",
                ),
                video: file(
                    "file-live-mov",
                    "live-1",
                    MediaFileRole::LiveVideo,
                    "2026/08/IMG_1.MOV",
                ),
            })
            .unwrap();
        repository
            .set_favorite("segment-13", true, "unix-ms:1")
            .unwrap();

        let removed = repository
            .purge_files_and_empty_items("library-1", &["2026/08/VID_A_013.mp4".into()])
            .unwrap();
        assert_eq!(removed, (1, 1));
        assert!(repository.get_media_item("segment-13").unwrap().is_none());
        // Cascaded user state must not outlive the item.
        assert!(!repository.is_favorite("segment-13").unwrap());

        let removed = repository
            .purge_files_and_empty_items("library-1", &["2026/08/IMG_1.MOV".into()])
            .unwrap();
        assert_eq!(removed, (1, 0), "the live item still has its photo");
        assert!(repository.get_media_item("live-1").unwrap().is_some());

        let removed = repository
            .purge_files_and_empty_items("library-1", &["2026/08/VID_A_014.mp4".into()])
            .unwrap();
        assert_eq!(removed, (1, 1));
        let page = repository
            .query_media(MediaQuery {
                library_id: "library-1".into(),
                limit: 10,
                ..Default::default()
            })
            .unwrap();
        assert_eq!(page.total, 1);
        assert_eq!(page.items[0].id, "live-1");
    }

    #[test]
    fn purge_missing_removes_only_offline_items() {
        let repository = Repository::open_in_memory().unwrap();
        repository.create_library(library()).unwrap();
        repository
            .upsert_media_item(item("present-1", MediaKind::Photo))
            .unwrap();
        repository
            .upsert_media_file(file(
                "file-present",
                "present-1",
                MediaFileRole::Single,
                "2026/IMG_1.JPG",
            ))
            .unwrap();
        repository
            .upsert_media_item(item("offline-1", MediaKind::Video))
            .unwrap();
        repository
            .upsert_media_file(file(
                "file-offline",
                "offline-1",
                MediaFileRole::Single,
                "2026/VID_A_013.mp4",
            ))
            .unwrap();
        repository
            .mark_media_file_deleted("file-offline", "unix-ms:2")
            .unwrap();
        repository.refresh_media_item_state("offline-1").unwrap();

        let removed = repository.purge_missing_items("library-1").unwrap();
        assert_eq!(removed, 1);
        assert!(repository.get_media_item("offline-1").unwrap().is_none());
        assert!(repository.get_media_item("present-1").unwrap().is_some());
        assert_eq!(repository.purge_missing_items("library-1").unwrap(), 0);
    }
}
