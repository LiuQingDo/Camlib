//! AI tagging results, embeddings, and AI search helpers.

use crate::db::{escape_like, validate_non_empty, DbResult, Repository};
use rusqlite::{params, OptionalExtension, Row};
use serde::{Deserialize, Serialize};

impl Repository {
    // ── AI tagging / semantic search (media_ai, media_ai_tags) ──────────────

    pub fn get_media_ai(&self, media_item_id: &str) -> DbResult<Option<MediaAiRow>> {
        self.connection
            .query_row(
                "SELECT media_item_id, caption, tags_json, embedding, embedding_model,
                        ai_model, embedding_dim, status, error_message, processed_at
                 FROM media_ai WHERE media_item_id = ?1",
                [media_item_id],
                map_media_ai,
            )
            .optional()
            .map_err(Into::into)
    }

    /// Insert or replace the AI processing row. `embedding` fields stay as
    /// provided; pass `None` while only the tag/caption outcome is known.
    #[allow(clippy::too_many_arguments)]
    pub fn upsert_media_ai(&self, row: MediaAiUpsert<'_>) -> DbResult<()> {
        validate_non_empty("media_item_id", row.media_item_id)?;
        validate_non_empty("status", row.status)?;
        self.connection.execute(
            "INSERT INTO media_ai
             (media_item_id, caption, tags_json, embedding, embedding_model, ai_model,
              embedding_dim, status, error_message, processed_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
             ON CONFLICT(media_item_id) DO UPDATE SET
               caption = excluded.caption,
               tags_json = excluded.tags_json,
               embedding = excluded.embedding,
               embedding_model = excluded.embedding_model,
               ai_model = excluded.ai_model,
               embedding_dim = excluded.embedding_dim,
               status = excluded.status,
               error_message = excluded.error_message,
               processed_at = excluded.processed_at",
            params![
                row.media_item_id,
                row.caption,
                row.tags_json,
                row.embedding,
                row.embedding_model,
                row.ai_model,
                row.embedding_dim,
                row.status,
                row.error_message,
                row.processed_at,
            ],
        )?;
        Ok(())
    }

    /// Store (or replace) just the caption embedding after a later backfill.
    pub fn set_media_ai_embedding(
        &self,
        media_item_id: &str,
        embedding: &[u8],
        embedding_model: &str,
        embedding_dim: i64,
        processed_at: &str,
    ) -> DbResult<()> {
        validate_non_empty("media_item_id", media_item_id)?;
        self.connection.execute(
            "UPDATE media_ai SET embedding = ?2, embedding_model = ?3,
                    embedding_dim = ?4, processed_at = ?5
             WHERE media_item_id = ?1",
            params![
                media_item_id,
                embedding,
                embedding_model,
                embedding_dim,
                processed_at
            ],
        )?;
        Ok(())
    }

    /// Photo/live items eligible for AI tagging, newest capture first.
    pub fn list_ai_candidates(&self, library_id: &str) -> DbResult<Vec<AiWorkItem>> {
        let mut statement = self.connection.prepare(
            "SELECT m.id, m.display_name FROM media_items m
             WHERE m.library_id = ?1 AND m.kind IN ('photo', 'live')
               AND m.scan_state = 'present'
             ORDER BY m.capture_date DESC, m.id",
        )?;
        let rows = statement
            .query_map([library_id], |row| {
                Ok(AiWorkItem {
                    media_item_id: row.get(0)?,
                    display_name: row.get(1)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// Rows that succeeded but lack a current-model embedding (never embedded,
    /// or produced by a different embedding model that was since configured).
    pub fn list_ai_missing_embeddings(
        &self,
        library_id: &str,
        embedding_model: &str,
    ) -> DbResult<Vec<AiWorkItem>> {
        let mut statement = self.connection.prepare(
            "SELECT m.id, m.display_name FROM media_ai a
             JOIN media_items m ON m.id = a.media_item_id
             WHERE m.library_id = ?1 AND a.status = 'success'
               AND (a.embedding IS NULL OR a.embedding_model IS NULL
                    OR a.embedding_model != ?2)",
        )?;
        let rows = statement
            .query_map(params![library_id, embedding_model], |row| {
                Ok(AiWorkItem {
                    media_item_id: row.get(0)?,
                    display_name: row.get(1)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// All current-model caption vectors for a library, for brute-force cosine.
    pub fn list_ai_embeddings(
        &self,
        library_id: &str,
        embedding_model: &str,
    ) -> DbResult<Vec<AiEmbeddingRow>> {
        let mut statement = self.connection.prepare(
            "SELECT a.media_item_id, a.embedding FROM media_ai a
             JOIN media_items m ON m.id = a.media_item_id
             WHERE m.library_id = ?1 AND a.status = 'success'
               AND a.embedding IS NOT NULL AND a.embedding_model = ?2",
        )?;
        let rows = statement
            .query_map(params![library_id, embedding_model], |row| {
                Ok(AiEmbeddingRow {
                    media_item_id: row.get(0)?,
                    embedding: row.get(1)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// Rows whose caption/tags contain the term (LIKE). Fallback search path
    /// when no embedding model is configured; case-insensitive for ASCII.
    pub fn search_media_ai_text(&self, library_id: &str, term: &str) -> DbResult<Vec<String>> {
        let pattern = format!("%{}%", escape_like(term));
        let mut statement = self.connection.prepare(
            "SELECT a.media_item_id FROM media_ai a
             JOIN media_items m ON m.id = a.media_item_id
             WHERE m.library_id = ?1 AND a.status = 'success'
               AND (a.caption LIKE ?2 ESCAPE '\\' OR a.tags_json LIKE ?2 ESCAPE '\\')",
        )?;
        let rows = statement
            .query_map(params![library_id, pattern], |row| row.get(0))?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// Replace the AI tag assignments of one item inside one transaction.
    /// Missing tags are created first so the names survive in the tag list.
    pub fn replace_ai_tags(
        &self,
        media_item_id: &str,
        tag_names: &[String],
        tag_prefix: &str,
        at: &str,
    ) -> DbResult<usize> {
        validate_non_empty("media_item_id", media_item_id)?;
        let transaction = self.connection.unchecked_transaction()?;
        transaction.execute(
            "DELETE FROM media_ai_tags WHERE media_item_id = ?1",
            [media_item_id],
        )?;
        let mut applied = 0usize;
        for name in tag_names {
            let trimmed = name.trim();
            if trimmed.is_empty() {
                continue;
            }
            let tag_id = match transaction
                .query_row(
                    "SELECT id FROM tags WHERE name = ?1 COLLATE NOCASE",
                    [trimmed],
                    |row| row.get::<_, String>(0),
                )
                .optional()?
            {
                Some(id) => id,
                None => {
                    let id = format!("{tag_prefix}{:016x}", {
                        use std::hash::{Hash, Hasher};
                        let mut hasher = std::collections::hash_map::DefaultHasher::new();
                        trimmed.to_lowercase().hash(&mut hasher);
                        at.hash(&mut hasher);
                        hasher.finish()
                    });
                    transaction.execute(
                        "INSERT INTO tags (id, name, color, created_at) VALUES (?1, ?2, NULL, ?3)",
                        params![id, trimmed, at],
                    )?;
                    id
                }
            };
            transaction.execute(
                "INSERT INTO media_ai_tags (media_item_id, tag_id, created_at) VALUES (?1, ?2, ?3)
                 ON CONFLICT(media_item_id, tag_id) DO NOTHING",
                params![media_item_id, tag_id, at],
            )?;
            applied += 1;
        }
        transaction.commit()?;
        Ok(applied)
    }

    /// Remove one AI tag from one item (user explicitly declines an AI tag).
    pub fn detach_ai_tag(&self, media_item_id: &str, tag_id: &str) -> DbResult<()> {
        validate_non_empty("media_item_id", media_item_id)?;
        validate_non_empty("tag id", tag_id)?;
        self.connection.execute(
            "DELETE FROM media_ai_tags WHERE media_item_id = ?1 AND tag_id = ?2",
            params![media_item_id, tag_id],
        )?;
        Ok(())
    }

    /// Aggregate counters for the settings AI card.
    pub fn ai_stats(&self, library_id: &str) -> DbResult<AiStats> {
        self.connection
            .query_row(
                "SELECT
                   (SELECT COUNT(*) FROM media_items
                     WHERE library_id = ?1 AND kind IN ('photo', 'live')
                       AND scan_state = 'present'),
                   (SELECT COUNT(*) FROM media_ai a
                     JOIN media_items m ON m.id = a.media_item_id
                     WHERE m.library_id = ?1 AND a.status = 'success'),
                   (SELECT COUNT(*) FROM media_ai a
                     JOIN media_items m ON m.id = a.media_item_id
                     WHERE m.library_id = ?1 AND a.status = 'failed')",
                [library_id],
                |row| {
                    let total: i64 = row.get(0)?;
                    let success: i64 = row.get(1)?;
                    let failed: i64 = row.get(2)?;
                    Ok(AiStats {
                        total_photos: total,
                        processed: success,
                        failed,
                        pending: (total - success - failed).max(0),
                    })
                },
            )
            .map_err(Into::into)
    }

    /// Whole-library counters over present items. `SUM`/`MIN` return NULL on
    /// an empty library, hence the `Option` round-trip.
    pub fn library_brief(&self, library_id: &str) -> DbResult<LibraryBrief> {
        self.connection
            .query_row(
                "SELECT COUNT(*),
                        SUM(kind = 'photo'), SUM(kind = 'video'), SUM(kind = 'live'),
                        (SELECT COUNT(*) FROM favorites f
                          JOIN media_items m2 ON m2.id = f.media_item_id
                          WHERE m2.library_id = ?1),
                        SUM(total_size_bytes),
                        MIN(capture_date), MAX(capture_date)
                 FROM media_items
                 WHERE library_id = ?1 AND scan_state = 'present'",
                [library_id],
                |row| {
                    Ok(LibraryBrief {
                        total: row.get(0)?,
                        photos: row.get::<_, Option<i64>>(1)?.unwrap_or(0),
                        videos: row.get::<_, Option<i64>>(2)?.unwrap_or(0),
                        lives: row.get::<_, Option<i64>>(3)?.unwrap_or(0),
                        favorites: row.get::<_, Option<i64>>(4)?.unwrap_or(0),
                        total_size_bytes: row.get::<_, Option<i64>>(5)?.unwrap_or(0),
                        date_from: row.get(6)?,
                        date_to: row.get(7)?,
                    })
                },
            )
            .map_err(Into::into)
    }
}

/// One persisted AI processing outcome for a media item (`media_ai` row).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MediaAiRow {
    pub media_item_id: String,
    pub caption: Option<String>,
    pub tags_json: Option<String>,
    pub embedding: Option<Vec<u8>>,
    pub embedding_model: Option<String>,
    pub ai_model: Option<String>,
    pub embedding_dim: Option<i64>,
    pub status: String,
    pub error_message: Option<String>,
    pub processed_at: Option<String>,
}

/// Write-side counterpart of `MediaAiRow`; string fields are borrows so the
/// worker can stream results without cloning tag JSON.
#[derive(Debug, Clone, Default)]
pub struct MediaAiUpsert<'a> {
    pub media_item_id: &'a str,
    pub caption: Option<&'a str>,
    pub tags_json: Option<&'a str>,
    pub embedding: Option<&'a [u8]>,
    pub embedding_model: Option<&'a str>,
    pub ai_model: Option<&'a str>,
    pub embedding_dim: Option<i64>,
    pub status: &'a str,
    pub error_message: Option<&'a str>,
    pub processed_at: Option<&'a str>,
}

/// A media item queued for AI processing, with a display name for progress UI.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AiWorkItem {
    pub media_item_id: String,
    pub display_name: String,
}

/// A persisted caption vector ready for cosine scoring.
#[derive(Debug, Clone)]
pub struct AiEmbeddingRow {
    pub media_item_id: String,
    pub embedding: Vec<u8>,
}

/// Counters shown in the settings AI card.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AiStats {
    pub total_photos: i64,
    pub processed: i64,
    pub failed: i64,
    pub pending: i64,
}

/// Compact whole-library snapshot, injected into the AI assistant system
/// prompt so answers about "how many / when" come from the real index.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LibraryBrief {
    pub total: i64,
    pub photos: i64,
    pub videos: i64,
    pub lives: i64,
    pub favorites: i64,
    pub total_size_bytes: i64,
    pub date_from: Option<String>,
    pub date_to: Option<String>,
}

pub(crate) fn map_media_ai(row: &Row<'_>) -> rusqlite::Result<MediaAiRow> {
    Ok(MediaAiRow {
        media_item_id: row.get(0)?,
        caption: row.get(1)?,
        tags_json: row.get(2)?,
        embedding: row.get(3)?,
        embedding_model: row.get(4)?,
        ai_model: row.get(5)?,
        embedding_dim: row.get(6)?,
        status: row.get(7)?,
        error_message: row.get(8)?,
        processed_at: row.get(9)?,
    })
}
