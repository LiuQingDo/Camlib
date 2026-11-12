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
    pub const DELETION_LOGS: &str = include_str!("migrations/0003_deletion_logs.sql");
    pub const BACKUP_ITEMS: &str = include_str!("migrations/0004_backup_items.sql");
    pub const MEDIA_RATINGS: &str = include_str!("migrations/0005_media_ratings.sql");
    pub const BACKUP_MERGE: &str = include_str!("migrations/0006_backup_merge.sql");
    pub const AI_TAGS: &str = include_str!("migrations/0007_ai_tags.sql");
    pub const BACKUP_DEEP_VERIFY: &str = include_str!("migrations/0008_backup_deep_verify.sql");
}

mod queries;

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::cmp::Ordering as CmpOrdering;
use std::path::Path;

pub use queries::tags::*;

pub use queries::media::*;

pub use queries::library::*;

pub use queries::media_query::*;

pub use queries::deletion::*;

pub use queries::backup::*;

pub use queries::ai::*;

pub type DbResult<T> = Result<T, DbError>;

const CURRENT_SCHEMA_VERSION: i64 = 8;

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
    connection
        .create_collation("NATURAL_NOCASE", natural_name_compare)
        .map_err(DbError::Sqlite)?;
    Ok(())
}

/// Compare names the way a file browser normally does: numeric portions are
/// compared by value, while text portions are compared case-insensitively.
/// This keeps `IMG_2` before `IMG_10` and remains deterministic for pagination.
fn natural_name_compare(left: &str, right: &str) -> CmpOrdering {
    let left = natural_name_chunks(left);
    let right = natural_name_chunks(right);

    for (left_chunk, right_chunk) in left.iter().zip(right.iter()) {
        let (left_number, left_value) = left_chunk;
        let (right_number, right_value) = right_chunk;
        let ordering = if *left_number && *right_number {
            let left_trimmed = left_value.trim_start_matches('0');
            let right_trimmed = right_value.trim_start_matches('0');
            left_trimmed
                .len()
                .cmp(&right_trimmed.len())
                .then_with(|| left_trimmed.cmp(right_trimmed))
                .then_with(|| left_value.len().cmp(&right_value.len()))
        } else {
            left_value.cmp(right_value)
        };
        if ordering != CmpOrdering::Equal {
            return ordering;
        }
    }

    left.len().cmp(&right.len())
}

fn natural_name_chunks(value: &str) -> Vec<(bool, String)> {
    let mut chunks: Vec<(bool, String)> = Vec::new();
    for character in value.to_lowercase().chars() {
        let is_number = character.is_ascii_digit();
        if let Some((last_is_number, last_value)) = chunks.last_mut() {
            if *last_is_number == is_number {
                last_value.push(character);
                continue;
            }
        }
        chunks.push((is_number, character.to_string()));
    }
    chunks
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
    if max_version < 3 {
        let transaction = connection.transaction()?;
        transaction.execute_batch(migrations::DELETION_LOGS)?;
        transaction.execute(
            "INSERT INTO schema_migrations (version, applied_at) VALUES (?1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
            [3_i64],
        )?;
        transaction.commit()?;
    }
    if max_version < 4 {
        let transaction = connection.transaction()?;
        transaction.execute_batch(migrations::BACKUP_ITEMS)?;
        transaction.execute(
            "INSERT INTO schema_migrations (version, applied_at) VALUES (?1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
            [4_i64],
        )?;
        transaction.commit()?;
    }
    if max_version < 5 {
        let transaction = connection.transaction()?;
        transaction.execute_batch(migrations::MEDIA_RATINGS)?;
        transaction.execute(
            "INSERT INTO schema_migrations (version, applied_at) VALUES (?1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
            [5_i64],
        )?;
        transaction.commit()?;
    }
    if max_version < 6 {
        let transaction = connection.transaction()?;
        transaction.execute_batch(migrations::BACKUP_MERGE)?;
        transaction.execute(
            "INSERT INTO schema_migrations (version, applied_at) VALUES (?1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
            [6_i64],
        )?;
        transaction.commit()?;
    }
    if max_version < 7 {
        let transaction = connection.transaction()?;
        transaction.execute_batch(migrations::AI_TAGS)?;
        transaction.execute(
            "INSERT INTO schema_migrations (version, applied_at) VALUES (?1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
            [7_i64],
        )?;
        transaction.commit()?;
    }
    if max_version < 8 {
        let transaction = connection.transaction()?;
        transaction.execute_batch(migrations::BACKUP_DEEP_VERIFY)?;
        transaction.execute(
            "INSERT INTO schema_migrations (version, applied_at) VALUES (?1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
            [8_i64],
        )?;
        transaction.commit()?;
    }
    Ok(())
}

fn current_timestamp() -> String {
    format!(
        "unix-ms:{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
    )
}

fn validate_non_empty(field: &str, value: &str) -> DbResult<()> {
    if value.trim().is_empty() {
        Err(DbError::InvalidInput(format!("{field} 不能为空")))
    } else {
        Ok(())
    }
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

fn invalid_enum(value: String, field: &str) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(
        0,
        rusqlite::types::Type::Text,
        Box::new(DbError::InvalidInput(format!("{field} 值无效: {value}"))),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migrations_are_repeatable_and_create_required_tables_and_indexes() {
        let mut repository = Repository::open_in_memory().unwrap();
        assert_eq!(repository.schema_version().unwrap(), 8);
        apply_migrations(&mut repository.connection).unwrap();
        let tables: i64 = repository.connection.query_row("SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name IN ('libraries','media_items','media_files','favorites','tags','media_tags','media_ratings','backup_runs','backup_items','app_settings','deletion_logs','media_ai','media_ai_tags')", [], |row| row.get(0)).unwrap();
        assert_eq!(tables, 13);
        let indexes: i64 = repository
            .connection
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(indexes, 15);
        let has_merge_column: i64 = repository
            .connection
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('backup_items') WHERE name = 'merge_sources_json'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(has_merge_column, 1);
        let has_deep_verify_column: i64 = repository
            .connection
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('backup_runs') WHERE name = 'deep_verify'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(has_deep_verify_column, 1);
    }
}

#[cfg(test)]
pub(crate) mod test_support {
    use super::*;

    pub(crate) fn library() -> NewLibrary {
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
    pub(crate) fn item(id: &str, kind: MediaKind) -> NewMediaItem {
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
            favorite: false,
            rating: 0,
        }
    }
    pub(crate) fn file(id: &str, item_id: &str, role: MediaFileRole, path: &str) -> NewMediaFile {
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
}
