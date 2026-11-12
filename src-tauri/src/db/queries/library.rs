//! Library registry, scan-run lifecycle, and the scan snapshot writer.

use super::media::{upsert_media_file_on_unchecked, upsert_media_item_on};
use super::media::{MediaFileRole, MediaItem, MediaKind, NewMediaFile, ScanState};
use crate::db::{invalid_enum, stable_id, validate_non_empty, DbError, DbResult, Repository};
use rusqlite::{params, OptionalExtension, Row};
use serde::{Deserialize, Serialize};

impl Repository {
    pub fn create_library(&self, input: NewLibrary) -> DbResult<Library> {
        validate_non_empty("library id", &input.id)?;
        validate_non_empty("library root", &input.root_path)?;
        validate_non_empty("created_at", &input.created_at)?;
        validate_non_empty("updated_at", &input.updated_at)?;
        let id = input.id.clone();
        self.connection.execute(
            "INSERT INTO libraries
             (id, root_path, volume_id, volume_label, drive_letter, state,
              last_seen_at, last_scan_at, scan_generation, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            params![
                input.id,
                input.root_path,
                input.volume_id,
                input.volume_label,
                input.drive_letter,
                input.state.as_str(),
                input.last_seen_at,
                input.last_scan_at,
                input.scan_generation,
                input.created_at,
                input.updated_at,
            ],
        )?;
        self.get_library(id.as_str())?
            .ok_or_else(|| DbError::Sqlite(rusqlite::Error::QueryReturnedNoRows))
    }

    pub fn get_library(&self, id: &str) -> DbResult<Option<Library>> {
        self.connection
            .query_row(
                "SELECT id, root_path, volume_id, volume_label, drive_letter, state,
                        last_seen_at, last_scan_at, scan_generation, created_at, updated_at
                 FROM libraries WHERE id = ?1",
                [id],
                map_library,
            )
            .optional()
            .map_err(Into::into)
    }

    pub fn get_library_by_root(&self, root_path: &str) -> DbResult<Option<Library>> {
        self.connection
            .query_row(
                "SELECT id, root_path, volume_id, volume_label, drive_letter, state,
                        last_seen_at, last_scan_at, scan_generation, created_at, updated_at
                 FROM libraries WHERE root_path = ?1",
                [root_path],
                map_library,
            )
            .optional()
            .map_err(Into::into)
    }

    pub fn upsert_library(&self, input: NewLibrary) -> DbResult<Library> {
        validate_non_empty("library id", &input.id)?;
        validate_non_empty("library root", &input.root_path)?;
        validate_non_empty("created_at", &input.created_at)?;
        validate_non_empty("updated_at", &input.updated_at)?;
        self.connection.execute(
            "INSERT INTO libraries
             (id, root_path, volume_id, volume_label, drive_letter, state,
              last_seen_at, last_scan_at, scan_generation, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
             ON CONFLICT(id) DO UPDATE SET
               root_path = excluded.root_path, volume_id = excluded.volume_id,
               volume_label = excluded.volume_label, drive_letter = excluded.drive_letter,
               state = excluded.state, last_seen_at = excluded.last_seen_at,
               updated_at = excluded.updated_at",
            params![
                input.id,
                input.root_path,
                input.volume_id,
                input.volume_label,
                input.drive_letter,
                input.state.as_str(),
                input.last_seen_at,
                input.last_scan_at,
                input.scan_generation,
                input.created_at,
                input.updated_at,
            ],
        )?;
        self.get_library(&input.id)?
            .ok_or_else(|| DbError::Sqlite(rusqlite::Error::QueryReturnedNoRows))
    }

    pub fn begin_scan_run(&self, input: NewScanRun) -> DbResult<()> {
        validate_non_empty("scan run id", &input.id)?;
        validate_non_empty("job id", &input.job_id)?;
        validate_non_empty("library id", &input.library_id)?;
        validate_non_empty("started_at", &input.started_at)?;
        self.connection.execute(
            "INSERT INTO scan_runs
             (id, library_id, job_id, status, started_at, finished_at, files_seen,
              items_added, items_updated, items_missing, errors, error_summary)
             VALUES (?1, ?2, ?3, 'running', ?4, NULL, 0, 0, 0, 0, 0, NULL)",
            params![input.id, input.library_id, input.job_id, input.started_at],
        )?;
        Ok(())
    }

    pub fn finish_scan_run(&self, input: FinishScanRun<'_>) -> DbResult<()> {
        self.connection.execute(
            "UPDATE scan_runs SET status = ?2, finished_at = ?3, files_seen = ?4,
             items_added = ?5, items_updated = ?6, items_missing = ?7, errors = ?8,
             error_summary = ?9 WHERE id = ?1",
            params![
                input.id,
                input.status,
                input.finished_at,
                input.files_seen,
                input.items_added,
                input.items_updated,
                input.items_missing,
                input.errors,
                input.error_summary,
            ],
        )?;
        Ok(())
    }

    /// Mark orphaned running scan rows as failed after a process restart.
    /// No job machinery is resumed — the UI just shows a clear terminal state.
    pub fn fail_interrupted_scan_runs(&self, finished_at: &str) -> DbResult<usize> {
        let changed = self.connection.execute(
            "UPDATE scan_runs SET status = 'failed', finished_at = ?1,
             error_summary = '应用退出时任务仍在进行，已标记为中断'
             WHERE status = 'running'",
            [finished_at],
        )?;
        Ok(changed)
    }

    pub fn list_scan_file_records(&self, library_id: &str) -> DbResult<Vec<ScanFileRecord>> {
        let mut statement = self.connection.prepare(
            "SELECT id, media_item_id, relative_path, size_bytes, modified_at, exists_now
             FROM media_files WHERE library_id = ?1",
        )?;
        let rows = statement.query_map([library_id], |row| {
            Ok(ScanFileRecord {
                id: row.get(0)?,
                media_item_id: row.get(1)?,
                relative_path: row.get(2)?,
                size_bytes: row.get(3)?,
                modified_at: row.get(4)?,
                exists_now: row.get::<_, i64>(5)? != 0,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    /// Commit one complete filesystem snapshot. The caller must not invoke this
    /// until enumeration has succeeded; therefore a failed or cancelled scan
    /// leaves the old media rows untouched.
    pub fn apply_scan_snapshot(
        &self,
        library_id: &str,
        generation: i64,
        now: &str,
        groups: &[ScanGroup],
    ) -> DbResult<ScanApplyStats> {
        let transaction = self.connection.unchecked_transaction()?;
        let mut existing = std::collections::HashMap::<String, ScanFileRecord>::new();
        {
            let mut statement = transaction.prepare(
                "SELECT id, media_item_id, relative_path, size_bytes, modified_at, exists_now
                 FROM media_files WHERE library_id = ?1",
            )?;
            let rows = statement.query_map([library_id], |row| {
                Ok(ScanFileRecord {
                    id: row.get(0)?,
                    media_item_id: row.get(1)?,
                    relative_path: row.get(2)?,
                    size_bytes: row.get(3)?,
                    modified_at: row.get(4)?,
                    exists_now: row.get::<_, i64>(5)? != 0,
                })
            })?;
            for row in rows {
                let record = row?;
                existing.insert(record.relative_path.clone(), record);
            }
        }

        transaction.execute(
            "UPDATE media_files SET exists_now = 0, last_scanned_at = ?2 WHERE library_id = ?1",
            params![library_id, now],
        )?;

        let mut stats = ScanApplyStats::default();
        for group in groups {
            let matched = group
                .files
                .iter()
                .filter_map(|file| existing.get(&file.relative_path))
                .map(|file| file.media_item_id.clone())
                .next();
            let item_id = matched.clone().unwrap_or_else(|| {
                stable_id("item", &format!("{library_id}:{}", group.logical_key))
            });
            if matched.is_none() {
                stats.items_added += 1;
            } else if group.files.iter().any(|file| file.needs_reprocess) {
                stats.items_updated += 1;
            }

            let total_size = group.files.iter().map(|file| file.size_bytes).sum::<i64>();
            let item = MediaItem {
                id: item_id.clone(),
                library_id: library_id.to_owned(),
                logical_key: group.logical_key.clone(),
                kind: group.kind.clone(),
                display_name: group.display_name.clone(),
                capture_at: group.capture_at.clone(),
                capture_date: group.capture_date.clone(),
                width: None,
                height: None,
                duration_ms: None,
                total_size_bytes: total_size,
                burst_group: group.burst_group.clone(),
                metadata_json: None,
                scan_state: if group.ambiguous {
                    ScanState::Ambiguous
                } else {
                    ScanState::Present
                },
                first_seen_at: now.to_owned(),
                last_seen_at: now.to_owned(),
                // Favorites and ratings live in their own tables and are never
                // rewritten by a scan; the projected fields stay 0/false here.
                favorite: false,
                rating: 0,
            };
            transaction.execute(
                "UPDATE media_items SET logical_key = logical_key || '#legacy-' || id
                 WHERE library_id = ?1 AND logical_key = ?2 AND id <> ?3",
                params![library_id, group.logical_key, item_id],
            )?;
            upsert_media_item_on(&transaction, &item)?;
            for file in &group.files {
                let id = existing
                    .get(&file.relative_path)
                    .map(|old| old.id.clone())
                    .unwrap_or_else(|| {
                        stable_id("file", &format!("{library_id}:{}", file.relative_path))
                    });
                let input = NewMediaFile {
                    id,
                    media_item_id: item_id.clone(),
                    library_id: library_id.to_owned(),
                    role: file.role.clone(),
                    relative_path: file.relative_path.clone(),
                    size_bytes: file.size_bytes,
                    modified_at: file.modified_at.clone(),
                    content_hash: None,
                    hash_algorithm: None,
                    file_identity: None,
                    exists_now: true,
                    last_scanned_at: now.to_owned(),
                };
                // The logical item was upserted in this same transaction, so
                // skipping the per-file existence probe keeps large rescans
                // from issuing tens of thousands of redundant SELECTs.
                upsert_media_file_on_unchecked(&transaction, &input)?;
                stats.files_seen += 1;
            }
        }

        let seen_paths = groups
            .iter()
            .flat_map(|group| group.files.iter().map(|file| file.relative_path.as_str()))
            .collect::<std::collections::HashSet<_>>();
        stats.items_missing = existing
            .values()
            .filter(|file| file.exists_now && !seen_paths.contains(file.relative_path.as_str()))
            .count() as i64;
        transaction.execute(
            "UPDATE media_items SET scan_state = 'missing', last_seen_at = ?2
             WHERE library_id = ?1 AND NOT EXISTS
             (SELECT 1 FROM media_files f WHERE f.media_item_id = media_items.id AND f.exists_now = 1)",
            params![library_id, now],
        )?;
        // Merge scratch (`.VID_….camlib-part.mp4`, `.camlib-merge.mp4`) can be
        // indexed if a scan runs while ffmpeg is writing. Once it is gone, drop
        // the row instead of leaving an offline card in the library.
        transaction.execute(
            "DELETE FROM media_items
             WHERE library_id = ?1
               AND scan_state = 'missing'
               AND id IN (
                 SELECT media_item_id FROM media_files
                 WHERE library_id = ?1
                   AND (file_name LIKE '%.camlib-%' OR relative_path LIKE '%.camlib-%')
               )",
            params![library_id],
        )?;
        transaction.execute(
            "UPDATE libraries SET last_scan_at = ?2, scan_generation = ?3, updated_at = ?2
             WHERE id = ?1",
            params![library_id, now, generation],
        )?;
        transaction.commit()?;
        Ok(stats)
    }

    pub fn list_libraries(&self) -> DbResult<Vec<Library>> {
        let mut statement = self.connection.prepare(
            "SELECT id, root_path, volume_id, volume_label, drive_letter, state,
                    last_seen_at, last_scan_at, scan_generation, created_at, updated_at
             FROM libraries ORDER BY created_at, id",
        )?;
        let rows = statement.query_map([], map_library)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    /// Recent scan attempts for one library, newest first.
    pub fn list_scan_runs(&self, library_id: &str, limit: i64) -> DbResult<Vec<ScanRun>> {
        let limit = limit.clamp(1, 100);
        let mut statement = self.connection.prepare(
            "SELECT id, library_id, job_id, status, started_at, finished_at, files_seen,
                    items_added, items_updated, items_missing, errors, error_summary
             FROM scan_runs
             WHERE library_id = ?1
             ORDER BY started_at DESC, rowid DESC
             LIMIT ?2",
        )?;
        let rows = statement.query_map(params![library_id, limit], map_scan_run)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    /// Aggregate index counters used by the settings status card.
    pub fn library_index_summary(&self, library_id: &str) -> DbResult<LibraryIndexSummary> {
        let library = self
            .get_library(library_id)?
            .ok_or_else(|| DbError::InvalidInput("媒体库不存在".to_owned()))?;
        let mut statement = self.connection.prepare(
            "SELECT
                COUNT(*) AS total,
                COALESCE(SUM(CASE WHEN kind = 'photo' THEN 1 ELSE 0 END), 0),
                COALESCE(SUM(CASE WHEN kind = 'video' THEN 1 ELSE 0 END), 0),
                COALESCE(SUM(CASE WHEN kind = 'live' THEN 1 ELSE 0 END), 0),
                COALESCE(SUM(CASE WHEN scan_state = 'missing' THEN 1 ELSE 0 END), 0),
                COALESCE(SUM(total_size_bytes), 0)
             FROM media_items WHERE library_id = ?1",
        )?;
        let row = statement.query_row([library_id], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, i64>(4)?,
                row.get::<_, i64>(5)?,
            ))
        })?;
        let favorites = self.connection.query_row(
            "SELECT COUNT(*) FROM favorites f
             JOIN media_items m ON m.id = f.media_item_id
             WHERE m.library_id = ?1",
            [library_id],
            |row| row.get(0),
        )?;
        Ok(LibraryIndexSummary {
            library_id: library_id.to_owned(),
            total_items: row.0,
            photos: row.1,
            videos: row.2,
            live: row.3,
            missing: row.4,
            favorites,
            total_size_bytes: row.5,
            last_scan_at: library.last_scan_at,
            scan_generation: library.scan_generation,
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum LibraryState {
    Available,
    Offline,
    Invalid,
}

impl LibraryState {
    pub(crate) fn as_str(&self) -> &'static str {
        match self {
            Self::Available => "available",
            Self::Offline => "offline",
            Self::Invalid => "invalid",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Library {
    pub id: String,
    pub root_path: String,
    pub volume_id: Option<String>,
    pub volume_label: Option<String>,
    pub drive_letter: Option<String>,
    pub state: LibraryState,
    pub last_seen_at: Option<String>,
    pub last_scan_at: Option<String>,
    pub scan_generation: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NewLibrary {
    pub id: String,
    pub root_path: String,
    pub volume_id: Option<String>,
    pub volume_label: Option<String>,
    pub drive_letter: Option<String>,
    pub state: LibraryState,
    pub last_seen_at: Option<String>,
    pub last_scan_at: Option<String>,
    pub scan_generation: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone)]
pub struct NewScanRun {
    pub id: String,
    pub library_id: String,
    pub job_id: String,
    pub started_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ScanRun {
    pub id: String,
    pub library_id: String,
    pub job_id: String,
    pub status: String,
    pub started_at: String,
    pub finished_at: Option<String>,
    pub files_seen: i64,
    pub items_added: i64,
    pub items_updated: i64,
    pub items_missing: i64,
    pub errors: i64,
    pub error_summary: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LibraryIndexSummary {
    pub library_id: String,
    pub total_items: i64,
    pub photos: i64,
    pub videos: i64,
    pub live: i64,
    pub missing: i64,
    pub favorites: i64,
    pub total_size_bytes: i64,
    pub last_scan_at: Option<String>,
    pub scan_generation: i64,
}

pub struct FinishScanRun<'a> {
    pub id: &'a str,
    pub status: &'a str,
    pub finished_at: &'a str,
    pub files_seen: i64,
    pub items_added: i64,
    pub items_updated: i64,
    pub items_missing: i64,
    pub errors: i64,
    pub error_summary: Option<&'a str>,
}

#[derive(Debug, Clone)]
pub struct ScanFileRecord {
    pub id: String,
    pub media_item_id: String,
    pub relative_path: String,
    pub size_bytes: i64,
    pub modified_at: String,
    pub exists_now: bool,
}

#[derive(Debug, Clone)]
pub struct ScanGroup {
    pub logical_key: String,
    pub display_name: String,
    pub kind: MediaKind,
    pub capture_at: Option<String>,
    pub capture_date: Option<String>,
    pub ambiguous: bool,
    /// Shared id for items in the same burst cluster; `None` when not a burst.
    pub burst_group: Option<String>,
    pub files: Vec<ScanGroupFile>,
}

#[derive(Debug, Clone)]
pub struct ScanGroupFile {
    pub relative_path: String,
    pub role: MediaFileRole,
    pub size_bytes: i64,
    pub modified_at: String,
    pub needs_reprocess: bool,
}

#[derive(Debug, Clone, Default)]
pub struct ScanApplyStats {
    pub files_seen: i64,
    pub items_added: i64,
    pub items_updated: i64,
    pub items_missing: i64,
}

pub(crate) fn map_library(row: &Row<'_>) -> rusqlite::Result<Library> {
    Ok(Library {
        id: row.get(0)?,
        root_path: row.get(1)?,
        volume_id: row.get(2)?,
        volume_label: row.get(3)?,
        drive_letter: row.get(4)?,
        state: parse_library_state(row.get::<_, String>(5)?)?,
        last_seen_at: row.get(6)?,
        last_scan_at: row.get(7)?,
        scan_generation: row.get(8)?,
        created_at: row.get(9)?,
        updated_at: row.get(10)?,
    })
}

pub(crate) fn map_scan_run(row: &Row<'_>) -> rusqlite::Result<ScanRun> {
    Ok(ScanRun {
        id: row.get(0)?,
        library_id: row.get(1)?,
        job_id: row.get(2)?,
        status: row.get(3)?,
        started_at: row.get(4)?,
        finished_at: row.get(5)?,
        files_seen: row.get(6)?,
        items_added: row.get(7)?,
        items_updated: row.get(8)?,
        items_missing: row.get(9)?,
        errors: row.get(10)?,
        error_summary: row.get(11)?,
    })
}

pub(crate) fn parse_library_state(value: String) -> rusqlite::Result<LibraryState> {
    match value.as_str() {
        "available" => Ok(LibraryState::Available),
        "offline" => Ok(LibraryState::Offline),
        "invalid" => Ok(LibraryState::Invalid),
        _ => Err(invalid_enum(value, "library.state")),
    }
}

#[cfg(test)]
mod tests {
    use crate::db::test_support::{item, library};
    use crate::db::*;

    #[test]
    fn scan_runs_and_index_summary_are_queryable() {
        let repository = Repository::open_in_memory().unwrap();
        repository.create_library(library()).unwrap();

        repository
            .begin_scan_run(NewScanRun {
                id: "run-a".into(),
                library_id: "library-1".into(),
                job_id: "job-a".into(),
                started_at: "2026-01-02T00:00:00Z".into(),
            })
            .unwrap();
        repository
            .finish_scan_run(FinishScanRun {
                id: "run-a",
                status: "completed",
                finished_at: "2026-01-02T00:05:00Z",
                files_seen: 3,
                items_added: 2,
                items_updated: 1,
                items_missing: 0,
                errors: 0,
                error_summary: None,
            })
            .unwrap();
        repository
            .begin_scan_run(NewScanRun {
                id: "run-b".into(),
                library_id: "library-1".into(),
                job_id: "job-b".into(),
                started_at: "2026-01-03T00:00:00Z".into(),
            })
            .unwrap();

        let runs = repository.list_scan_runs("library-1", 8).unwrap();
        assert_eq!(runs.len(), 2);
        assert_eq!(runs[0].id, "run-b");
        assert_eq!(runs[0].status, "running");
        assert_eq!(runs[1].id, "run-a");
        assert_eq!(runs[1].files_seen, 3);

        repository
            .upsert_media_item(item("photo-1", MediaKind::Photo))
            .unwrap();
        repository
            .upsert_media_item(item("video-1", MediaKind::Video))
            .unwrap();
        repository
            .set_favorite("photo-1", true, "2026-01-03T01:00:00Z")
            .unwrap();

        let summary = repository.library_index_summary("library-1").unwrap();
        assert_eq!(summary.total_items, 2);
        assert_eq!(summary.photos, 1);
        assert_eq!(summary.videos, 1);
        assert_eq!(summary.live, 0);
        assert_eq!(summary.favorites, 1);
        assert_eq!(summary.missing, 0);
    }
}
