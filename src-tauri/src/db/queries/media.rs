//! Media items, media files, favorites, and the media-item read models.

use super::tags::Tag;
use crate::db::{invalid_enum, validate_non_empty, DbError, DbResult, Repository};
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use std::path::{Component, Path};

impl Repository {
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
                        burst_group, metadata_json, scan_state, first_seen_at, last_seen_at,
                        EXISTS (SELECT 1 FROM favorites fav WHERE fav.media_item_id = media_items.id),
                        COALESCE((SELECT r.rating FROM media_ratings r WHERE r.media_item_id = media_items.id), 0)
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
        let ai = self.get_media_ai(id)?.filter(|row| row.status == "success");
        // AI tags resolve through the relation table so each carries a real
        // tag id the UI can detach individually; tags whose row was deleted
        // (cascade) naturally drop out instead of lingering as bare strings.
        let ai_tags = if ai.is_some() {
            self.list_ai_tags_for_media(id)?
        } else {
            Vec::new()
        };
        Ok(Some(MediaItemDetails {
            item,
            files,
            favorite,
            tags,
            ai_caption: ai.as_ref().and_then(|row| row.caption.clone()),
            ai_tags,
        }))
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

    /// Apply the same favorite flag to many items in one transaction.
    pub fn set_favorites_batch(
        &self,
        media_item_ids: &[String],
        favorite: bool,
        at: &str,
    ) -> DbResult<usize> {
        let transaction = self.connection.unchecked_transaction()?;
        let mut applied = 0usize;
        for media_item_id in media_item_ids {
            validate_non_empty("media_item_id", media_item_id)?;
            if favorite {
                let changed = transaction.execute(
                    "INSERT INTO favorites (media_item_id, created_at) VALUES (?1, ?2)
                     ON CONFLICT(media_item_id) DO NOTHING",
                    params![media_item_id, at],
                )?;
                applied += changed;
            } else {
                let changed = transaction.execute(
                    "DELETE FROM favorites WHERE media_item_id = ?1",
                    [media_item_id],
                )?;
                applied += changed;
            }
        }
        transaction.commit()?;
        Ok(applied)
    }

    pub fn is_favorite(&self, media_item_id: &str) -> DbResult<bool> {
        Ok(self.connection.query_row(
            "SELECT EXISTS (SELECT 1 FROM favorites WHERE media_item_id = ?1)",
            [media_item_id],
            |row| row.get::<_, i64>(0),
        )? != 0)
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
    pub(crate) fn as_str(&self) -> &'static str {
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
    pub(crate) fn as_str(&self) -> &'static str {
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
    pub(crate) fn as_str(&self) -> &'static str {
        match self {
            Self::Present => "present",
            Self::Missing => "missing",
            Self::Ambiguous => "ambiguous",
            Self::Error => "error",
        }
    }
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
    /// Projected from `favorites` so list queries need no N+1 follow-up.
    #[serde(default)]
    pub favorite: bool,
    /// Projected from `media_ratings` (0 = unrated). Never rewritten by a scan.
    #[serde(default)]
    pub rating: i64,
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
    /// AI-generated one-line description; `None` when AI is unprocessed.
    #[serde(default)]
    pub ai_caption: Option<String>,
    /// Tags attached via AI (`media_ai_tags`), resolved to real tag rows so
    /// they stay individually detachable; independent of `tags`.
    #[serde(default)]
    pub ai_tags: Vec<Tag>,
}

pub(crate) fn validate_media_item_input(input: &MediaItem) -> DbResult<()> {
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

pub(crate) fn validate_relative_path(value: &str) -> DbResult<String> {
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

pub(crate) fn validate_media_file_input(input: &NewMediaFile) -> DbResult<()> {
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

pub(crate) fn upsert_media_item_on(connection: &Connection, input: &MediaItem) -> DbResult<()> {
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

pub(crate) fn upsert_media_file_on(connection: &Connection, input: &NewMediaFile) -> DbResult<()> {
    validate_media_file_input(input)?;
    ensure_media_item_library(connection, &input.media_item_id, &input.library_id)?;
    upsert_media_file_on_unchecked(connection, input)
}

/// Insert/update a media file when the caller already guaranteed the parent
/// logical item exists in the same transaction (scan snapshot apply path).
pub(crate) fn upsert_media_file_on_unchecked(
    connection: &Connection,
    input: &NewMediaFile,
) -> DbResult<()> {
    validate_media_file_input(input)?;
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

pub(crate) fn ensure_media_item_library(
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

pub(crate) fn map_media_item(row: &Row<'_>) -> rusqlite::Result<MediaItem> {
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
        favorite: row.get::<_, i64>(16)? != 0,
        rating: row.get(17)?,
    })
}
pub(crate) fn map_media_file(row: &Row<'_>) -> rusqlite::Result<MediaFile> {
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

pub(crate) fn parse_media_kind(value: String) -> rusqlite::Result<MediaKind> {
    match value.as_str() {
        "photo" => Ok(MediaKind::Photo),
        "video" => Ok(MediaKind::Video),
        "live" => Ok(MediaKind::Live),
        _ => Err(invalid_enum(value, "media_items.kind")),
    }
}
pub(crate) fn parse_media_file_role(value: String) -> rusqlite::Result<MediaFileRole> {
    match value.as_str() {
        "single" => Ok(MediaFileRole::Single),
        "live_photo" => Ok(MediaFileRole::LivePhoto),
        "live_video" => Ok(MediaFileRole::LiveVideo),
        _ => Err(invalid_enum(value, "media_files.role")),
    }
}
pub(crate) fn parse_scan_state(value: String) -> rusqlite::Result<ScanState> {
    match value.as_str() {
        "present" => Ok(ScanState::Present),
        "missing" => Ok(ScanState::Missing),
        "ambiguous" => Ok(ScanState::Ambiguous),
        "error" => Ok(ScanState::Error),
        _ => Err(invalid_enum(value, "media_items.scan_state")),
    }
}

#[cfg(test)]
mod tests {
    use crate::db::test_support::{file, item, library};
    use crate::db::*;

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
}
