//! Deletion audit log and offline-row purging.

use super::media::{parse_media_kind, MediaKind};
use crate::db::{current_timestamp, validate_non_empty, DbResult, Repository};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};

/// One row of the read-only "已删除" list.
///
/// `media_items` carries no `deleted` flag (a scan only marks rows
/// `present`/`missing`/`ambiguous`/`error`), so this list is derived entirely
/// from the deletion audit log. An item that was recycled more than once shows
/// up once, with its newest successful log.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DeletedItem {
    /// Media item id — stable identity of the row (not the log id).
    pub id: String,
    pub display_name: String,
    pub kind: MediaKind,
    pub capture_date: Option<String>,
    pub relative_path: String,
    /// `unix-ms:<millis>` of the newest completed recycle.
    pub deleted_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DeletedItemsPage {
    pub items: Vec<DeletedItem>,
    pub total: i64,
    pub offset: i64,
    pub limit: i64,
}

impl Repository {
    /// Newest completed recycle per media item, newest first.
    ///
    /// Filtering happens *inside* the window's source query on purpose: ranking
    /// every log first would let a later `already_missing`/`failed` row mask an
    /// earlier successful recycle, hiding media that really did reach the
    /// recycle bin. `rowid` breaks `created_at` ties by insertion order so a
    /// repeated delete inside the same millisecond still resolves to the last
    /// write.
    pub fn list_deleted_items(
        &self,
        library_id: &str,
        limit: i64,
        offset: i64,
    ) -> DbResult<DeletedItemsPage> {
        validate_non_empty("library id", library_id)?;
        let limit = limit.clamp(1, 500);
        let offset = offset.max(0);
        let total: i64 = self.connection.query_row(
            "SELECT COUNT(DISTINCT l.media_item_id)
             FROM deletion_logs l
             JOIN media_items i ON i.id = l.media_item_id
             WHERE i.library_id = ?1 AND l.action = 'recycle' AND l.status = 'completed'",
            [library_id],
            |row| row.get(0),
        )?;
        let mut statement = self.connection.prepare(
            "WITH completed AS (
                 SELECT l.media_item_id,
                        l.media_file_id,
                        l.relative_path,
                        l.created_at,
                        l.rowid AS seq,
                        ROW_NUMBER() OVER (
                            PARTITION BY l.media_item_id
                            ORDER BY l.created_at DESC, l.rowid DESC
                        ) AS rank
                 FROM deletion_logs l
                 JOIN media_items i ON i.id = l.media_item_id
                 WHERE i.library_id = ?1 AND l.action = 'recycle' AND l.status = 'completed'
             )
             SELECT c.media_item_id,
                    i.display_name,
                    i.kind,
                    i.capture_date,
                    COALESCE(c.relative_path, f.relative_path) AS relative_path,
                    c.created_at
             FROM completed c
             JOIN media_items i ON i.id = c.media_item_id
             LEFT JOIN media_files f ON f.id = c.media_file_id
             WHERE c.rank = 1
             ORDER BY c.created_at DESC, c.seq DESC
             LIMIT ?2 OFFSET ?3",
        )?;
        let items = statement
            .query_map(params![library_id, limit, offset], |row| {
                Ok(DeletedItem {
                    id: row.get(0)?,
                    display_name: row.get(1)?,
                    kind: parse_media_kind(row.get::<_, String>(2)?)?,
                    capture_date: row.get(3)?,
                    relative_path: row.get::<_, Option<String>>(4)?.unwrap_or_default(),
                    deleted_at: row.get(5)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(DeletedItemsPage {
            items,
            total,
            offset,
            limit,
        })
    }

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
    fn deleted_list_dedupes_repeats_and_ignores_non_recycled_logs() {
        let repository = Repository::open_in_memory().unwrap();
        repository.create_library(library()).unwrap();
        for (id, kind) in [
            ("item-a", MediaKind::Photo),
            ("item-b", MediaKind::Video),
            ("item-c", MediaKind::Photo),
            ("item-d", MediaKind::Photo),
        ] {
            repository.upsert_media_item(item(id, kind)).unwrap();
        }

        let log = |id: &str,
                   item_id: &str,
                   path: &str,
                   action: &'static str,
                   status: &'static str,
                   created_at: &str| {
            repository
                .record_deletion_log(DeletionLogInput {
                    id,
                    media_item_id: item_id,
                    media_file_id: None,
                    relative_path: Some(path),
                    action,
                    status,
                    error_message: None,
                    created_at,
                })
                .unwrap();
        };

        // item-a was recycled twice: only the newest row may survive.
        log(
            "log-a1",
            "item-a",
            "2026/08/IMG_1.JPG",
            "recycle",
            "completed",
            "unix-ms:1000",
        );
        log(
            "log-a2",
            "item-a",
            "2026/09/IMG_1.JPG",
            "recycle",
            "completed",
            "unix-ms:2000",
        );
        // item-b: a successful recycle followed by a re-delete that found
        // nothing on disk. The successful log must still be listed.
        log(
            "log-b1",
            "item-b",
            "2026/08/VID_1.mp4",
            "recycle",
            "completed",
            "unix-ms:1500",
        );
        log(
            "log-b2",
            "item-b",
            "2026/08/VID_1.mp4",
            "already_missing",
            "skipped",
            "unix-ms:2500",
        );
        // item-c: the recycle itself failed; nothing reached the recycle bin.
        log(
            "log-c1",
            "item-c",
            "2026/08/IMG_2.JPG",
            "recycle",
            "failed",
            "unix-ms:3000",
        );
        // item-d: nothing was recycled, the file was already gone.
        log(
            "log-d1",
            "item-d",
            "2026/08/IMG_3.JPG",
            "already_missing",
            "skipped",
            "unix-ms:4000",
        );

        let page = repository.list_deleted_items("library-1", 100, 0).unwrap();
        assert_eq!(page.total, 2);
        assert_eq!(
            page.items
                .iter()
                .map(|item| item.id.as_str())
                .collect::<Vec<_>>(),
            vec!["item-a", "item-b"],
            "newest deletion first, one row per media item"
        );
        assert_eq!(page.items[0].relative_path, "2026/09/IMG_1.JPG");
        assert_eq!(page.items[0].deleted_at, "unix-ms:2000");
        assert_eq!(page.items[0].display_name, "item-a.JPG");
        assert_eq!(page.items[0].kind, MediaKind::Photo);
        assert_eq!(page.items[1].kind, MediaKind::Video);
        assert_eq!(page.items[1].display_name, "item-b.JPG");

        let second = repository.list_deleted_items("library-1", 1, 1).unwrap();
        assert_eq!(second.total, 2, "total counts distinct items, not rows");
        assert_eq!(second.items.len(), 1);
        assert_eq!(second.items[0].id, "item-b");

        assert!(repository
            .list_deleted_items("library-unknown", 100, 0)
            .unwrap()
            .items
            .is_empty());
    }

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
