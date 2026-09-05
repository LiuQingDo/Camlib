//! SQLite persistence for the logical media library.
//!
//! This module intentionally has no scanner, thumbnail, or delete behaviour. It
//! stores only library metadata and paths relative to a registered library root.

/// Names the public data-layer types as DTOs at the application boundary.
/// They are serde-compatible with the TypeScript contracts in `src/api/media.ts`.
pub mod dto {
    pub use super::{
        BackupRun, BackupStatus, ConflictPolicy, Library, LibraryState, MediaFile, MediaFileRole,
        MediaItem, MediaItemDetails, MediaKind, MediaPage, ScanState, Tag,
    };
}

mod migrations {
    pub const INITIAL: &str = include_str!("migrations/0001_initial.sql");
    pub const SCAN_RUNS: &str = include_str!("migrations/0002_scan_runs.sql");
}

use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use std::path::{Component, Path};

pub type DbResult<T> = Result<T, DbError>;

const CURRENT_SCHEMA_VERSION: i64 = 2;

#[derive(Debug)]
pub enum DbError {
    Sqlite(rusqlite::Error),
    InvalidInput(String),
    UnsupportedSchemaVersion(i64),
}

impl std::fmt::Display for DbError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Sqlite(error) => write!(f, "数据库操作失败: {error}"),
            Self::InvalidInput(message) => write!(f, "数据库输入无效: {message}"),
            Self::UnsupportedSchemaVersion(version) => {
                write!(f, "数据库版本不受支持: {version}")
            }
        }
    }
}

impl std::error::Error for DbError {}

impl From<rusqlite::Error> for DbError {
    fn from(error: rusqlite::Error) -> Self {
        Self::Sqlite(error)
    }
}

#[derive(Debug)]
pub struct Repository {
    connection: Connection,
}

impl Repository {
    /// Open (or create) the database at an application-data path.
    pub fn open(path: impl AsRef<Path>) -> DbResult<Self> {
        let path = path.as_ref();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|error| DbError::InvalidInput(format!("创建数据库目录失败: {error}")))?;
        }
        let mut connection = Connection::open(path)?;
        configure_connection(&connection)?;
        apply_migrations(&mut connection)?;
        Ok(Self { connection })
    }

    /// An isolated database intended for unit and integration tests.
    pub fn open_in_memory() -> DbResult<Self> {
        let mut connection = Connection::open_in_memory()?;
        configure_connection(&connection)?;
        apply_migrations(&mut connection)?;
        Ok(Self { connection })
    }

    pub fn schema_version(&self) -> DbResult<i64> {
        Ok(self.connection.query_row(
            "SELECT COALESCE(MAX(version), 0) FROM schema_migrations",
            [],
            |row| row.get(0),
        )?)
    }

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
                burst_group: None,
                metadata_json: None,
                scan_state: if group.ambiguous {
                    ScanState::Ambiguous
                } else {
                    ScanState::Present
                },
                first_seen_at: now.to_owned(),
                last_seen_at: now.to_owned(),
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
                upsert_media_file_on(&transaction, &input)?;
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

    /// Insert or update one logical media item. The stable `id` is supplied by
    /// the caller so rescans can retain favorites and tags.
    pub fn upsert_media_item(&self, input: NewMediaItem) -> DbResult<MediaItem> {
        validate_media_item_input(&input)?;
        if input.kind == MediaKind::Live {
            return Err(DbError::InvalidInput(
                "实况照片必须通过 upsert_live_photo 一次写入逻辑项和两个文件".to_owned(),
            ));
        }
        let id = input.id.clone();
        self.connection.execute(
            "INSERT INTO media_items
             (id, library_id, logical_key, kind, display_name, capture_at, capture_date,
              width, height, duration_ms, total_size_bytes, burst_group, metadata_json,
              scan_state, first_seen_at, last_seen_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)
             ON CONFLICT(id) DO UPDATE SET
               library_id = excluded.library_id,
               logical_key = excluded.logical_key,
               kind = excluded.kind,
               display_name = excluded.display_name,
               capture_at = excluded.capture_at,
               capture_date = excluded.capture_date,
               width = excluded.width,
               height = excluded.height,
               duration_ms = excluded.duration_ms,
               total_size_bytes = excluded.total_size_bytes,
               burst_group = excluded.burst_group,
               metadata_json = excluded.metadata_json,
               scan_state = excluded.scan_state,
               last_seen_at = excluded.last_seen_at",
            params![
                input.id,
                input.library_id,
                input.logical_key,
                input.kind.as_str(),
                input.display_name,
                input.capture_at,
                input.capture_date,
                input.width,
                input.height,
                input.duration_ms,
                input.total_size_bytes,
                input.burst_group,
                input.metadata_json,
                input.scan_state.as_str(),
                input.first_seen_at,
                input.last_seen_at,
            ],
        )?;
        self.get_media_item(&id)?
            .ok_or_else(|| DbError::Sqlite(rusqlite::Error::QueryReturnedNoRows))
    }

    /// Atomically create/update one Live Photo logical item and its two members.
    /// No public API accepts a Live Photo as two logical items.
    pub fn upsert_live_photo(&self, input: LivePhotoInput) -> DbResult<MediaItemDetails> {
        if input.item.kind != MediaKind::Live {
            return Err(DbError::InvalidInput(
                "实况照片逻辑项的 kind 必须为 live".to_owned(),
            ));
        }
        if input.photo.role != MediaFileRole::LivePhoto
            || input.video.role != MediaFileRole::LiveVideo
        {
            return Err(DbError::InvalidInput(
                "实况照片必须关联 live_photo 和 live_video 两个文件".to_owned(),
            ));
        }
        if input.photo.id == input.video.id {
            return Err(DbError::InvalidInput(
                "实况照片的照片文件和视频文件必须是不同文件".to_owned(),
            ));
        }
        if input.photo.media_item_id != input.item.id
            || input.video.media_item_id != input.item.id
            || input.photo.library_id != input.item.library_id
            || input.video.library_id != input.item.library_id
        {
            return Err(DbError::InvalidInput(
                "实况照片的逻辑项、库和文件关联必须一致".to_owned(),
            ));
        }

        let transaction = self.connection.unchecked_transaction()?;
        upsert_media_item_on(&transaction, &input.item)?;
        upsert_media_file_on(&transaction, &input.photo)?;
        upsert_media_file_on(&transaction, &input.video)?;
        transaction.commit()?;
        self.get_media_item_details(&input.item.id)?
            .ok_or_else(|| DbError::Sqlite(rusqlite::Error::QueryReturnedNoRows))
    }

    pub fn upsert_media_file(&self, input: NewMediaFile) -> DbResult<MediaFile> {
        validate_media_file_input(&input)?;
        if input.role != MediaFileRole::Single {
            return Err(DbError::InvalidInput(
                "实况照片文件必须通过 upsert_live_photo 成对写入".to_owned(),
            ));
        }
        ensure_media_item_library(&self.connection, &input.media_item_id, &input.library_id)?;
        let id = input.id.clone();
        upsert_media_file_on(&self.connection, &input)?;
        self.get_media_file(&id)?
            .ok_or_else(|| DbError::Sqlite(rusqlite::Error::QueryReturnedNoRows))
    }

    pub fn get_media_file(&self, id: &str) -> DbResult<Option<MediaFile>> {
        self.connection
            .query_row(
                "SELECT id, media_item_id, library_id, role, relative_path, file_name,
                        extension, size_bytes, modified_at, content_hash, hash_algorithm,
                        file_identity, exists_now, last_scanned_at
                 FROM media_files WHERE id = ?1",
                [id],
                map_media_file,
            )
            .optional()
            .map_err(Into::into)
    }

    pub fn get_media_item(&self, id: &str) -> DbResult<Option<MediaItem>> {
        self.connection
            .query_row(
                "SELECT id, library_id, logical_key, kind, display_name, capture_at,
                        capture_date, width, height, duration_ms, total_size_bytes,
                        burst_group, metadata_json, scan_state, first_seen_at, last_seen_at
                 FROM media_items WHERE id = ?1",
                [id],
                map_media_item,
            )
            .optional()
            .map_err(Into::into)
    }

    pub fn get_media_item_details(&self, id: &str) -> DbResult<Option<MediaItemDetails>> {
        let Some(item) = self.get_media_item(id)? else {
            return Ok(None);
        };
        let mut statement = self.connection.prepare(
            "SELECT id, media_item_id, library_id, role, relative_path, file_name,
                    extension, size_bytes, modified_at, content_hash, hash_algorithm,
                    file_identity, exists_now, last_scanned_at
             FROM media_files WHERE media_item_id = ?1 ORDER BY role, id",
        )?;
        let files = statement
            .query_map([id], map_media_file)?
            .collect::<Result<Vec<_>, _>>()?;
        let favorite = self.is_favorite(id)?;
        let tags = self.list_tags_for_media(id)?;
        Ok(Some(MediaItemDetails {
            item,
            files,
            favorite,
            tags,
        }))
    }

    pub fn query_media(&self, query: MediaQuery) -> DbResult<MediaPage> {
        let limit = query.limit.clamp(1, 500);
        let offset = query.offset.max(0);
        let mut conditions = vec!["m.library_id = ?1".to_owned()];
        let mut values = vec![query.library_id.clone()];
        if let Some(kind) = query.kind {
            conditions.push(format!("m.kind = ?{}", values.len() + 1));
            values.push(kind.as_str().to_owned());
        }
        if query.favorite_only {
            conditions
                .push("EXISTS (SELECT 1 FROM favorites f WHERE f.media_item_id = m.id)".to_owned());
        }
        if let Some(search) = query.search.filter(|value| !value.trim().is_empty()) {
            conditions.push(format!(
                "m.display_name LIKE ?{} ESCAPE '\\'",
                values.len() + 1
            ));
            values.push(format!("%{}%", escape_like(&search)));
        }
        if let Some(date_prefix) = query.date_prefix.filter(|value| !value.trim().is_empty()) {
            conditions.push(format!(
                "m.capture_date LIKE ?{} ESCAPE '\\'",
                values.len() + 1
            ));
            values.push(format!("{}%", escape_like(&date_prefix)));
        }
        let where_clause = conditions.join(" AND ");
        let count_sql = format!("SELECT COUNT(*) FROM media_items m WHERE {where_clause}");
        let count_params = values.iter().map(String::as_str).collect::<Vec<_>>();
        let total: i64 = self.connection.query_row(
            &count_sql,
            rusqlite::params_from_iter(count_params.iter()),
            |row| row.get(0),
        )?;

        let order = match query.sort {
            MediaSort::Oldest => "m.capture_at ASC, m.id ASC",
            MediaSort::Name => "m.display_name COLLATE NOCASE ASC, m.id ASC",
            MediaSort::Newest => "m.capture_at DESC, m.id DESC",
        };
        let item_sql = format!(
            "SELECT m.id, m.library_id, m.logical_key, m.kind, m.display_name,
                    m.capture_at, m.capture_date, m.width, m.height, m.duration_ms,
                    m.total_size_bytes, m.burst_group, m.metadata_json, m.scan_state,
                    m.first_seen_at, m.last_seen_at
             FROM media_items m WHERE {where_clause}
             ORDER BY {order} LIMIT ?{} OFFSET ?{}",
            values.len() + 1,
            values.len() + 2
        );
        let mut params = values;
        params.push(limit.to_string());
        params.push(offset.to_string());
        let query_params = params.iter().map(String::as_str).collect::<Vec<_>>();
        let mut statement = self.connection.prepare(&item_sql)?;
        let items = statement
            .query_map(
                rusqlite::params_from_iter(query_params.iter()),
                map_media_item,
            )?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(MediaPage {
            items,
            total,
            offset,
            limit,
        })
    }

    pub fn list_date_facets(&self, library_id: &str) -> DbResult<Vec<DateFacet>> {
        let mut statement = self.connection.prepare(
            "SELECT capture_date, COUNT(*)
             FROM media_items
             WHERE library_id = ?1 AND capture_date IS NOT NULL
             GROUP BY capture_date ORDER BY capture_date DESC",
        )?;
        let rows = statement.query_map([library_id], |row| {
            Ok(DateFacet {
                date: row.get(0)?,
                count: row.get(1)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    pub fn set_favorite(&self, media_item_id: &str, favorite: bool, at: &str) -> DbResult<()> {
        validate_non_empty("media_item_id", media_item_id)?;
        if favorite {
            self.connection.execute(
                "INSERT INTO favorites (media_item_id, created_at) VALUES (?1, ?2)
                 ON CONFLICT(media_item_id) DO NOTHING",
                params![media_item_id, at],
            )?;
        } else {
            self.connection.execute(
                "DELETE FROM favorites WHERE media_item_id = ?1",
                [media_item_id],
            )?;
        }
        Ok(())
    }

    pub fn is_favorite(&self, media_item_id: &str) -> DbResult<bool> {
        Ok(self.connection.query_row(
            "SELECT EXISTS (SELECT 1 FROM favorites WHERE media_item_id = ?1)",
            [media_item_id],
            |row| row.get::<_, i64>(0),
        )? != 0)
    }

    pub fn create_tag(&self, input: NewTag) -> DbResult<Tag> {
        validate_non_empty("tag id", &input.id)?;
        validate_non_empty("tag name", &input.name)?;
        let id = input.id.clone();
        self.connection.execute(
            "INSERT INTO tags (id, name, color, created_at) VALUES (?1, ?2, ?3, ?4)",
            params![input.id, input.name, input.color, input.created_at],
        )?;
        self.get_tag(&id)?
            .ok_or_else(|| DbError::Sqlite(rusqlite::Error::QueryReturnedNoRows))
    }

    pub fn get_tag(&self, id: &str) -> DbResult<Option<Tag>> {
        self.connection
            .query_row(
                "SELECT id, name, color, created_at FROM tags WHERE id = ?1",
                [id],
                map_tag,
            )
            .optional()
            .map_err(Into::into)
    }

    pub fn attach_tag(&self, media_item_id: &str, tag_id: &str, at: &str) -> DbResult<()> {
        self.connection.execute(
            "INSERT INTO media_tags (media_item_id, tag_id, created_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(media_item_id, tag_id) DO NOTHING",
            params![media_item_id, tag_id, at],
        )?;
        Ok(())
    }

    pub fn detach_tag(&self, media_item_id: &str, tag_id: &str) -> DbResult<()> {
        self.connection.execute(
            "DELETE FROM media_tags WHERE media_item_id = ?1 AND tag_id = ?2",
            params![media_item_id, tag_id],
        )?;
        Ok(())
    }

    pub fn list_tags_for_media(&self, media_item_id: &str) -> DbResult<Vec<Tag>> {
        let mut statement = self.connection.prepare(
            "SELECT t.id, t.name, t.color, t.created_at
             FROM tags t JOIN media_tags mt ON mt.tag_id = t.id
             WHERE mt.media_item_id = ?1 ORDER BY t.name COLLATE NOCASE, t.id",
        )?;
        let rows = statement.query_map([media_item_id], map_tag)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    pub fn create_backup_run(&self, input: NewBackupRun) -> DbResult<BackupRun> {
        validate_non_empty("backup run id", &input.id)?;
        validate_non_empty("job id", &input.job_id)?;
        validate_non_empty("source root path", &input.source_root_path)?;
        let id = input.id.clone();
        self.connection.execute(
            "INSERT INTO backup_runs
             (id, job_id, source_volume_id, source_root_path, target_library_id, status,
              conflict_policy, ignore_extensions, started_at, finished_at, total_files,
              copied_files, skipped_files, failed_files, total_bytes, copied_bytes, error_summary)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)",
            params![
                input.id,
                input.job_id,
                input.source_volume_id,
                input.source_root_path,
                input.target_library_id,
                input.status.as_str(),
                input.conflict_policy.as_str(),
                input.ignore_extensions,
                input.started_at,
                input.finished_at,
                input.total_files,
                input.copied_files,
                input.skipped_files,
                input.failed_files,
                input.total_bytes,
                input.copied_bytes,
                input.error_summary,
            ],
        )?;
        self.get_backup_run(&id)?
            .ok_or_else(|| DbError::Sqlite(rusqlite::Error::QueryReturnedNoRows))
    }

    pub fn get_backup_run(&self, id: &str) -> DbResult<Option<BackupRun>> {
        self.connection
            .query_row(
                "SELECT id, job_id, source_volume_id, source_root_path, target_library_id,
                        status, conflict_policy, ignore_extensions, started_at, finished_at,
                        total_files, copied_files, skipped_files, failed_files, total_bytes,
                        copied_bytes, error_summary
                 FROM backup_runs WHERE id = ?1",
                [id],
                map_backup_run,
            )
            .optional()
            .map_err(Into::into)
    }

    pub fn set_app_setting<T: Serialize>(
        &self,
        key: &str,
        value: &T,
        updated_at: &str,
    ) -> DbResult<()> {
        validate_non_empty("setting key", key)?;
        let value_json = serde_json::to_string(value)
            .map_err(|error| DbError::InvalidInput(format!("设置无法序列化: {error}")))?;
        self.connection.execute(
            "INSERT INTO app_settings (key, value_json, updated_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json,
                                            updated_at = excluded.updated_at",
            params![key, value_json, updated_at],
        )?;
        Ok(())
    }

    pub fn get_app_setting<T: for<'de> Deserialize<'de>>(&self, key: &str) -> DbResult<Option<T>> {
        let value: Option<String> = self
            .connection
            .query_row(
                "SELECT value_json FROM app_settings WHERE key = ?1",
                [key],
                |row| row.get(0),
            )
            .optional()?;
        value
            .map(|json| {
                serde_json::from_str(&json)
                    .map_err(|error| DbError::InvalidInput(error.to_string()))
            })
            .transpose()
    }
}

fn configure_connection(connection: &Connection) -> DbResult<()> {
    connection.execute_batch(
        "PRAGMA foreign_keys = ON;
         PRAGMA busy_timeout = 5000;
         PRAGMA journal_mode = WAL;",
    )?;
    Ok(())
}

fn apply_migrations(connection: &mut Connection) -> DbResult<()> {
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS schema_migrations (
             version INTEGER PRIMARY KEY NOT NULL,
             applied_at TEXT NOT NULL
         );",
    )?;
    let max_version: i64 = connection.query_row(
        "SELECT COALESCE(MAX(version), 0) FROM schema_migrations",
        [],
        |row| row.get(0),
    )?;
    if max_version > CURRENT_SCHEMA_VERSION {
        return Err(DbError::UnsupportedSchemaVersion(max_version));
    }
    if max_version < 1 {
        let transaction = connection.transaction()?;
        transaction.execute_batch(migrations::INITIAL)?;
        transaction.execute(
            "INSERT INTO schema_migrations (version, applied_at) VALUES (?1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
            [1_i64],
        )?;
        transaction.commit()?;
    }
    if max_version < 2 {
        let transaction = connection.transaction()?;
        transaction.execute_batch(migrations::SCAN_RUNS)?;
        transaction.execute(
            "INSERT INTO schema_migrations (version, applied_at) VALUES (?1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
            [2_i64],
        )?;
        transaction.commit()?;
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum LibraryState {
    Available,
    Offline,
    Invalid,
}

impl LibraryState {
    fn as_str(&self) -> &'static str {
        match self {
            Self::Available => "available",
            Self::Offline => "offline",
            Self::Invalid => "invalid",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MediaKind {
    Photo,
    Video,
    Live,
}
impl MediaKind {
    fn as_str(&self) -> &'static str {
        match self {
            Self::Photo => "photo",
            Self::Video => "video",
            Self::Live => "live",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MediaFileRole {
    Single,
    LivePhoto,
    LiveVideo,
}
impl MediaFileRole {
    fn as_str(&self) -> &'static str {
        match self {
            Self::Single => "single",
            Self::LivePhoto => "live_photo",
            Self::LiveVideo => "live_video",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ScanState {
    Present,
    Missing,
    Ambiguous,
    Error,
}
impl ScanState {
    fn as_str(&self) -> &'static str {
        match self {
            Self::Present => "present",
            Self::Missing => "missing",
            Self::Ambiguous => "ambiguous",
            Self::Error => "error",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum BackupStatus {
    Preview,
    Running,
    Completed,
    Cancelled,
    Failed,
}
impl BackupStatus {
    fn as_str(&self) -> &'static str {
        match self {
            Self::Preview => "preview",
            Self::Running => "running",
            Self::Completed => "completed",
            Self::Cancelled => "cancelled",
            Self::Failed => "failed",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ConflictPolicy {
    SkipSame,
    Rename,
    Overwrite,
}
impl ConflictPolicy {
    fn as_str(&self) -> &'static str {
        match self {
            Self::SkipSame => "skip_same",
            Self::Rename => "rename",
            Self::Overwrite => "overwrite",
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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MediaItem {
    pub id: String,
    pub library_id: String,
    pub logical_key: String,
    pub kind: MediaKind,
    pub display_name: String,
    pub capture_at: Option<String>,
    pub capture_date: Option<String>,
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub duration_ms: Option<i64>,
    pub total_size_bytes: i64,
    pub burst_group: Option<String>,
    pub metadata_json: Option<String>,
    pub scan_state: ScanState,
    pub first_seen_at: String,
    pub last_seen_at: String,
}

pub type NewMediaItem = MediaItem;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MediaFile {
    pub id: String,
    pub media_item_id: String,
    pub library_id: String,
    pub role: MediaFileRole,
    pub relative_path: String,
    pub file_name: String,
    pub extension: String,
    pub size_bytes: i64,
    pub modified_at: String,
    pub content_hash: Option<String>,
    pub hash_algorithm: Option<String>,
    pub file_identity: Option<String>,
    pub exists_now: bool,
    pub last_scanned_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NewMediaFile {
    pub id: String,
    pub media_item_id: String,
    pub library_id: String,
    pub role: MediaFileRole,
    pub relative_path: String,
    pub size_bytes: i64,
    pub modified_at: String,
    pub content_hash: Option<String>,
    pub hash_algorithm: Option<String>,
    pub file_identity: Option<String>,
    pub exists_now: bool,
    pub last_scanned_at: String,
}

#[derive(Debug, Clone)]
pub struct LivePhotoInput {
    pub item: NewMediaItem,
    pub photo: NewMediaFile,
    pub video: NewMediaFile,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MediaItemDetails {
    pub item: MediaItem,
    pub files: Vec<MediaFile>,
    pub favorite: bool,
    pub tags: Vec<Tag>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Tag {
    pub id: String,
    pub name: String,
    pub color: Option<String>,
    pub created_at: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NewTag {
    pub id: String,
    pub name: String,
    pub color: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BackupRun {
    pub id: String,
    pub job_id: String,
    pub source_volume_id: Option<String>,
    pub source_root_path: String,
    pub target_library_id: String,
    pub status: BackupStatus,
    pub conflict_policy: ConflictPolicy,
    pub ignore_extensions: String,
    pub started_at: String,
    pub finished_at: Option<String>,
    pub total_files: i64,
    pub copied_files: i64,
    pub skipped_files: i64,
    pub failed_files: i64,
    pub total_bytes: i64,
    pub copied_bytes: i64,
    pub error_summary: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NewBackupRun {
    pub id: String,
    pub job_id: String,
    pub source_volume_id: Option<String>,
    pub source_root_path: String,
    pub target_library_id: String,
    pub status: BackupStatus,
    pub conflict_policy: ConflictPolicy,
    pub ignore_extensions: String,
    pub started_at: String,
    pub finished_at: Option<String>,
    pub total_files: i64,
    pub copied_files: i64,
    pub skipped_files: i64,
    pub failed_files: i64,
    pub total_bytes: i64,
    pub copied_bytes: i64,
    pub error_summary: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct MediaQuery {
    pub library_id: String,
    pub kind: Option<MediaKind>,
    pub favorite_only: bool,
    pub search: Option<String>,
    pub date_prefix: Option<String>,
    pub offset: i64,
    pub limit: i64,
    pub sort: MediaSort,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DateFacet {
    pub date: String,
    pub count: i64,
}
#[derive(Debug, Clone, Default)]
pub enum MediaSort {
    #[default]
    Newest,
    Oldest,
    Name,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MediaPage {
    pub items: Vec<MediaItem>,
    pub total: i64,
    pub offset: i64,
    pub limit: i64,
}

fn validate_non_empty(field: &str, value: &str) -> DbResult<()> {
    if value.trim().is_empty() {
        Err(DbError::InvalidInput(format!("{field} 不能为空")))
    } else {
        Ok(())
    }
}

fn validate_media_item_input(input: &MediaItem) -> DbResult<()> {
    validate_non_empty("media item id", &input.id)?;
    validate_non_empty("library id", &input.library_id)?;
    validate_non_empty("logical key", &input.logical_key)?;
    validate_non_empty("display name", &input.display_name)?;
    validate_non_empty("first_seen_at", &input.first_seen_at)?;
    validate_non_empty("last_seen_at", &input.last_seen_at)?;
    if input.total_size_bytes < 0 || input.duration_ms.is_some_and(|value| value < 0) {
        return Err(DbError::InvalidInput("媒体数值不能为负数".to_owned()));
    }
    Ok(())
}

fn validate_relative_path(value: &str) -> DbResult<String> {
    validate_non_empty("relative_path", value)?;
    if value.starts_with('/')
        || value.starts_with('\\')
        || (value.len() >= 2 && value.as_bytes()[1] == b':')
    {
        return Err(DbError::InvalidInput(
            "文件路径必须是媒体库根目录下的相对路径".to_owned(),
        ));
    }
    let normalized = value.replace('\\', "/");
    let parts = normalized.split('/').collect::<Vec<_>>();
    if parts
        .iter()
        .any(|part| part.is_empty() || *part == "." || *part == "..")
    {
        return Err(DbError::InvalidInput("文件相对路径包含非法段".to_owned()));
    }
    // Also exercise Path's platform-specific prefix handling when running on Windows.
    if Path::new(value).components().any(|component| {
        matches!(
            component,
            Component::Prefix(_) | Component::RootDir | Component::ParentDir | Component::CurDir
        )
    }) {
        return Err(DbError::InvalidInput(
            "文件路径必须是规范化相对路径".to_owned(),
        ));
    }
    Ok(normalized)
}

fn validate_media_file_input(input: &NewMediaFile) -> DbResult<()> {
    validate_non_empty("media file id", &input.id)?;
    validate_non_empty("media item id", &input.media_item_id)?;
    validate_non_empty("library id", &input.library_id)?;
    validate_non_empty("modified_at", &input.modified_at)?;
    validate_non_empty("last_scanned_at", &input.last_scanned_at)?;
    if input.size_bytes < 0 {
        return Err(DbError::InvalidInput("文件大小不能为负数".to_owned()));
    }
    validate_relative_path(&input.relative_path)?;
    Ok(())
}

fn upsert_media_item_on(connection: &Connection, input: &MediaItem) -> DbResult<()> {
    validate_media_item_input(input)?;
    connection.execute(
        "INSERT INTO media_items
         (id, library_id, logical_key, kind, display_name, capture_at, capture_date,
          width, height, duration_ms, total_size_bytes, burst_group, metadata_json,
          scan_state, first_seen_at, last_seen_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)
         ON CONFLICT(id) DO UPDATE SET
           library_id = excluded.library_id, logical_key = excluded.logical_key,
           kind = excluded.kind, display_name = excluded.display_name,
           capture_at = excluded.capture_at, capture_date = excluded.capture_date,
           width = excluded.width, height = excluded.height,
           duration_ms = excluded.duration_ms, total_size_bytes = excluded.total_size_bytes,
           burst_group = excluded.burst_group, metadata_json = excluded.metadata_json,
           scan_state = excluded.scan_state, last_seen_at = excluded.last_seen_at",
        params![
            input.id,
            input.library_id,
            input.logical_key,
            input.kind.as_str(),
            input.display_name,
            input.capture_at,
            input.capture_date,
            input.width,
            input.height,
            input.duration_ms,
            input.total_size_bytes,
            input.burst_group,
            input.metadata_json,
            input.scan_state.as_str(),
            input.first_seen_at,
            input.last_seen_at,
        ],
    )?;
    Ok(())
}

fn upsert_media_file_on(connection: &Connection, input: &NewMediaFile) -> DbResult<()> {
    validate_media_file_input(input)?;
    ensure_media_item_library(connection, &input.media_item_id, &input.library_id)?;
    let relative_path = validate_relative_path(&input.relative_path)?;
    let file_name = relative_path.rsplit('/').next().unwrap_or(&relative_path);
    let extension = Path::new(file_name)
        .extension()
        .map(|value| value.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    connection.execute(
        "INSERT INTO media_files
         (id, media_item_id, library_id, role, relative_path, file_name, extension,
          size_bytes, modified_at, content_hash, hash_algorithm, file_identity,
          exists_now, last_scanned_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
         ON CONFLICT(id) DO UPDATE SET
           media_item_id = excluded.media_item_id, library_id = excluded.library_id,
           role = excluded.role, relative_path = excluded.relative_path,
           file_name = excluded.file_name, extension = excluded.extension,
           size_bytes = excluded.size_bytes, modified_at = excluded.modified_at,
           content_hash = excluded.content_hash, hash_algorithm = excluded.hash_algorithm,
           file_identity = excluded.file_identity, exists_now = excluded.exists_now,
           last_scanned_at = excluded.last_scanned_at",
        params![
            input.id,
            input.media_item_id,
            input.library_id,
            input.role.as_str(),
            relative_path,
            file_name,
            extension,
            input.size_bytes,
            input.modified_at,
            input.content_hash,
            input.hash_algorithm,
            input.file_identity,
            if input.exists_now { 1_i64 } else { 0_i64 },
            input.last_scanned_at,
        ],
    )?;
    Ok(())
}

fn ensure_media_item_library(
    connection: &Connection,
    media_item_id: &str,
    library_id: &str,
) -> DbResult<()> {
    let exists: bool = connection.query_row(
        "SELECT EXISTS (SELECT 1 FROM media_items WHERE id = ?1 AND library_id = ?2)",
        params![media_item_id, library_id],
        |row| Ok(row.get::<_, i64>(0)? != 0),
    )?;
    if !exists {
        return Err(DbError::InvalidInput(
            "媒体文件必须关联同一媒体库中的逻辑媒体项".to_owned(),
        ));
    }
    Ok(())
}

fn escape_like(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

fn stable_id(prefix: &str, value: &str) -> String {
    // FNV-1a is deterministic across processes, unlike DefaultHasher. The
    // database's unique constraints remain the final guard against collisions.
    let mut hash = 0xcbf29ce484222325_u64;
    for byte in value.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{prefix}-{hash:016x}")
}

fn map_library(row: &Row<'_>) -> rusqlite::Result<Library> {
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
fn map_media_item(row: &Row<'_>) -> rusqlite::Result<MediaItem> {
    Ok(MediaItem {
        id: row.get(0)?,
        library_id: row.get(1)?,
        logical_key: row.get(2)?,
        kind: parse_media_kind(row.get::<_, String>(3)?)?,
        display_name: row.get(4)?,
        capture_at: row.get(5)?,
        capture_date: row.get(6)?,
        width: row.get(7)?,
        height: row.get(8)?,
        duration_ms: row.get(9)?,
        total_size_bytes: row.get(10)?,
        burst_group: row.get(11)?,
        metadata_json: row.get(12)?,
        scan_state: parse_scan_state(row.get::<_, String>(13)?)?,
        first_seen_at: row.get(14)?,
        last_seen_at: row.get(15)?,
    })
}
fn map_media_file(row: &Row<'_>) -> rusqlite::Result<MediaFile> {
    Ok(MediaFile {
        id: row.get(0)?,
        media_item_id: row.get(1)?,
        library_id: row.get(2)?,
        role: parse_media_file_role(row.get::<_, String>(3)?)?,
        relative_path: row.get(4)?,
        file_name: row.get(5)?,
        extension: row.get(6)?,
        size_bytes: row.get(7)?,
        modified_at: row.get(8)?,
        content_hash: row.get(9)?,
        hash_algorithm: row.get(10)?,
        file_identity: row.get(11)?,
        exists_now: row.get::<_, i64>(12)? != 0,
        last_scanned_at: row.get(13)?,
    })
}
fn map_tag(row: &Row<'_>) -> rusqlite::Result<Tag> {
    Ok(Tag {
        id: row.get(0)?,
        name: row.get(1)?,
        color: row.get(2)?,
        created_at: row.get(3)?,
    })
}
fn map_backup_run(row: &Row<'_>) -> rusqlite::Result<BackupRun> {
    Ok(BackupRun {
        id: row.get(0)?,
        job_id: row.get(1)?,
        source_volume_id: row.get(2)?,
        source_root_path: row.get(3)?,
        target_library_id: row.get(4)?,
        status: parse_backup_status(row.get::<_, String>(5)?)?,
        conflict_policy: parse_conflict_policy(row.get::<_, String>(6)?)?,
        ignore_extensions: row.get(7)?,
        started_at: row.get(8)?,
        finished_at: row.get(9)?,
        total_files: row.get(10)?,
        copied_files: row.get(11)?,
        skipped_files: row.get(12)?,
        failed_files: row.get(13)?,
        total_bytes: row.get(14)?,
        copied_bytes: row.get(15)?,
        error_summary: row.get(16)?,
    })
}

fn invalid_enum(value: String, field: &str) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(
        0,
        rusqlite::types::Type::Text,
        Box::new(DbError::InvalidInput(format!("{field} 值无效: {value}"))),
    )
}
fn parse_library_state(value: String) -> rusqlite::Result<LibraryState> {
    match value.as_str() {
        "available" => Ok(LibraryState::Available),
        "offline" => Ok(LibraryState::Offline),
        "invalid" => Ok(LibraryState::Invalid),
        _ => Err(invalid_enum(value, "library.state")),
    }
}
fn parse_media_kind(value: String) -> rusqlite::Result<MediaKind> {
    match value.as_str() {
        "photo" => Ok(MediaKind::Photo),
        "video" => Ok(MediaKind::Video),
        "live" => Ok(MediaKind::Live),
        _ => Err(invalid_enum(value, "media_items.kind")),
    }
}
fn parse_media_file_role(value: String) -> rusqlite::Result<MediaFileRole> {
    match value.as_str() {
        "single" => Ok(MediaFileRole::Single),
        "live_photo" => Ok(MediaFileRole::LivePhoto),
        "live_video" => Ok(MediaFileRole::LiveVideo),
        _ => Err(invalid_enum(value, "media_files.role")),
    }
}
fn parse_scan_state(value: String) -> rusqlite::Result<ScanState> {
    match value.as_str() {
        "present" => Ok(ScanState::Present),
        "missing" => Ok(ScanState::Missing),
        "ambiguous" => Ok(ScanState::Ambiguous),
        "error" => Ok(ScanState::Error),
        _ => Err(invalid_enum(value, "media_items.scan_state")),
    }
}
fn parse_backup_status(value: String) -> rusqlite::Result<BackupStatus> {
    match value.as_str() {
        "preview" => Ok(BackupStatus::Preview),
        "running" => Ok(BackupStatus::Running),
        "completed" => Ok(BackupStatus::Completed),
        "cancelled" => Ok(BackupStatus::Cancelled),
        "failed" => Ok(BackupStatus::Failed),
        _ => Err(invalid_enum(value, "backup_runs.status")),
    }
}
fn parse_conflict_policy(value: String) -> rusqlite::Result<ConflictPolicy> {
    match value.as_str() {
        "skip_same" => Ok(ConflictPolicy::SkipSame),
        "rename" => Ok(ConflictPolicy::Rename),
        "overwrite" => Ok(ConflictPolicy::Overwrite),
        _ => Err(invalid_enum(value, "backup_runs.conflict_policy")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn library() -> NewLibrary {
        NewLibrary {
            id: "library-1".into(),
            root_path: "C:/media".into(),
            volume_id: None,
            volume_label: None,
            drive_letter: Some("C".into()),
            state: LibraryState::Available,
            last_seen_at: Some("2026-01-01T00:00:00Z".into()),
            last_scan_at: None,
            scan_generation: 0,
            created_at: "2026-01-01T00:00:00Z".into(),
            updated_at: "2026-01-01T00:00:00Z".into(),
        }
    }
    fn item(id: &str, kind: MediaKind) -> NewMediaItem {
        NewMediaItem {
            id: id.into(),
            library_id: "library-1".into(),
            logical_key: id.into(),
            kind,
            display_name: format!("{id}.JPG"),
            capture_at: None,
            capture_date: Some("2026-01-01".into()),
            width: None,
            height: None,
            duration_ms: None,
            total_size_bytes: 1,
            burst_group: None,
            metadata_json: None,
            scan_state: ScanState::Present,
            first_seen_at: "2026-01-01T00:00:00Z".into(),
            last_seen_at: "2026-01-01T00:00:00Z".into(),
        }
    }
    fn file(id: &str, item_id: &str, role: MediaFileRole, path: &str) -> NewMediaFile {
        NewMediaFile {
            id: id.into(),
            media_item_id: item_id.into(),
            library_id: "library-1".into(),
            role,
            relative_path: path.into(),
            size_bytes: 1,
            modified_at: "2026-01-01T00:00:00Z".into(),
            content_hash: None,
            hash_algorithm: None,
            file_identity: None,
            exists_now: true,
            last_scanned_at: "2026-01-01T00:00:00Z".into(),
        }
    }

    #[test]
    fn migrations_are_repeatable_and_create_required_tables_and_indexes() {
        let mut repository = Repository::open_in_memory().unwrap();
        assert_eq!(repository.schema_version().unwrap(), 2);
        apply_migrations(&mut repository.connection).unwrap();
        let tables: i64 = repository.connection.query_row("SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name IN ('libraries','media_items','media_files','favorites','tags','media_tags','backup_runs','app_settings')", [], |row| row.get(0)).unwrap();
        assert_eq!(tables, 8);
        let indexes: i64 = repository
            .connection
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(indexes, 10);
    }

    #[test]
    fn live_photo_is_one_item_with_photo_and_video_files_in_one_transaction() {
        let repository = Repository::open_in_memory().unwrap();
        repository.create_library(library()).unwrap();
        let input = LivePhotoInput {
            item: item("live-1", MediaKind::Live),
            photo: file(
                "file-photo",
                "live-1",
                MediaFileRole::LivePhoto,
                "2026/01/IMG_0001.JPG",
            ),
            video: file(
                "file-video",
                "live-1",
                MediaFileRole::LiveVideo,
                "2026/01/IMG_0001.MOV",
            ),
        };
        let details = repository.upsert_live_photo(input).unwrap();
        assert_eq!(details.item.kind, MediaKind::Live);
        assert_eq!(details.files.len(), 2);
        assert!(details
            .files
            .iter()
            .any(|file| file.role == MediaFileRole::LivePhoto));
        assert!(details
            .files
            .iter()
            .any(|file| file.role == MediaFileRole::LiveVideo));
        assert!(details
            .files
            .iter()
            .all(|file| !Path::new(&file.relative_path).is_absolute()));
    }

    #[test]
    fn relative_paths_and_foreign_keys_are_enforced() {
        let repository = Repository::open_in_memory().unwrap();
        repository.create_library(library()).unwrap();
        repository
            .upsert_media_item(item("photo-1", MediaKind::Photo))
            .unwrap();
        let error = repository
            .upsert_media_file(file(
                "file-1",
                "photo-1",
                MediaFileRole::Single,
                "../outside.jpg",
            ))
            .unwrap_err();
        assert!(error.to_string().contains("相对路径"));
        let error = repository
            .upsert_media_file(file(
                "file-2",
                "unknown",
                MediaFileRole::Single,
                "inside.jpg",
            ))
            .unwrap_err();
        assert!(matches!(error, DbError::InvalidInput(_)));
    }

    #[test]
    fn favorite_tag_setting_and_query_are_persistent() {
        let repository = Repository::open_in_memory().unwrap();
        repository.create_library(library()).unwrap();
        repository
            .upsert_media_item(item("photo-1", MediaKind::Photo))
            .unwrap();
        repository
            .set_favorite("photo-1", true, "2026-01-01T00:00:00Z")
            .unwrap();
        repository
            .create_tag(NewTag {
                id: "tag-1".into(),
                name: "旅行".into(),
                color: None,
                created_at: "2026-01-01T00:00:00Z".into(),
            })
            .unwrap();
        repository
            .attach_tag("photo-1", "tag-1", "2026-01-01T00:00:00Z")
            .unwrap();
        repository
            .set_app_setting("density", &"comfortable", "2026-01-01T00:00:00Z")
            .unwrap();
        let page = repository
            .query_media(MediaQuery {
                library_id: "library-1".into(),
                favorite_only: true,
                limit: 10,
                ..Default::default()
            })
            .unwrap();
        assert_eq!(page.total, 1);
        let searched = repository
            .query_media(MediaQuery {
                library_id: "library-1".into(),
                search: Some("photo".into()),
                limit: 10,
                ..Default::default()
            })
            .unwrap();
        assert_eq!(searched.total, 1);
        assert_eq!(
            repository.list_tags_for_media("photo-1").unwrap()[0].name,
            "旅行"
        );
        assert_eq!(
            repository
                .get_app_setting::<String>("density")
                .unwrap()
                .as_deref(),
            Some("comfortable")
        );
    }
}
