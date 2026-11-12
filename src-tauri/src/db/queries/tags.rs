//! Tags, tag attachments, and user ratings.

use crate::db::{validate_non_empty, DbError, DbResult, Repository};
use rusqlite::{params, OptionalExtension, Row};
use serde::{Deserialize, Serialize};

impl Repository {
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
                "SELECT id, name, color, created_at,
                        (SELECT COUNT(*) FROM media_tags mt WHERE mt.tag_id = tags.id),
                        EXISTS (SELECT 1 FROM media_ai_tags mat WHERE mat.tag_id = tags.id)
                 FROM tags WHERE id = ?1",
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
            "SELECT t.id, t.name, t.color, t.created_at, 0,
                    EXISTS (SELECT 1 FROM media_ai_tags mat
                            WHERE mat.tag_id = t.id AND mat.media_item_id = ?1)
             FROM tags t JOIN media_tags mt ON mt.tag_id = t.id
             WHERE mt.media_item_id = ?1 ORDER BY t.name COLLATE NOCASE, t.id",
        )?;
        let rows = statement.query_map([media_item_id], map_tag)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    /// Tags attached to one item via AI (`media_ai_tags`), with real tag ids
    /// so the UI can detach them individually. `has_ai` here flags tags the
    /// item also carries through the user-managed `media_tags` table.
    pub fn list_ai_tags_for_media(&self, media_item_id: &str) -> DbResult<Vec<Tag>> {
        let mut statement = self.connection.prepare(
            "SELECT t.id, t.name, t.color, t.created_at, 0,
                    EXISTS (SELECT 1 FROM media_tags mt
                            WHERE mt.tag_id = t.id AND mt.media_item_id = ?1)
             FROM tags t JOIN media_ai_tags mat ON mat.tag_id = t.id
             WHERE mat.media_item_id = ?1 ORDER BY t.name COLLATE NOCASE, t.id",
        )?;
        let rows = statement.query_map([media_item_id], map_tag)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    /// All tags ordered by name, with how many media items currently carry each.
    pub fn list_tags(&self) -> DbResult<Vec<Tag>> {
        let mut statement = self.connection.prepare(
            "SELECT t.id, t.name, t.color, t.created_at,
                    (SELECT COUNT(*) FROM media_tags mt WHERE mt.tag_id = t.id),
                    EXISTS (SELECT 1 FROM media_ai_tags mat WHERE mat.tag_id = t.id)
             FROM tags t ORDER BY t.name COLLATE NOCASE, t.id",
        )?;
        let rows = statement.query_map([], map_tag)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    pub fn get_tag_by_name(&self, name: &str) -> DbResult<Option<Tag>> {
        let trimmed = name.trim();
        validate_non_empty("tag name", trimmed)?;
        self.connection
            .query_row(
                "SELECT t.id, t.name, t.color, t.created_at, 0,
                        EXISTS (SELECT 1 FROM media_ai_tags mat WHERE mat.tag_id = t.id)
                 FROM tags t WHERE t.name = ?1 COLLATE NOCASE",
                [trimmed],
                map_tag,
            )
            .optional()
            .map_err(Into::into)
    }

    pub fn update_tag(&self, id: &str, name: Option<&str>, color: Option<&str>) -> DbResult<Tag> {
        validate_non_empty("tag id", id)?;
        let existing = self
            .get_tag(id)?
            .ok_or_else(|| DbError::InvalidInput("标签不存在".to_owned()))?;
        let next_name = name.map(str::trim).filter(|value| !value.is_empty());
        if let Some(next_name) = next_name {
            if !next_name.eq_ignore_ascii_case(&existing.name) {
                if let Some(conflict) = self.get_tag_by_name(next_name)? {
                    if conflict.id != id {
                        return Err(DbError::InvalidInput(format!(
                            "标签名称已存在: {next_name}"
                        )));
                    }
                }
            }
        }
        let next_color = match color {
            Some(value) => {
                let trimmed = value.trim();
                if trimmed.is_empty() {
                    None
                } else {
                    Some(trimmed.to_owned())
                }
            }
            None => existing.color.clone(),
        };
        self.connection.execute(
            "UPDATE tags SET name = COALESCE(?2, name), color = ?3 WHERE id = ?1",
            params![id, next_name, next_color],
        )?;
        self.get_tag(id)?
            .ok_or_else(|| DbError::Sqlite(rusqlite::Error::QueryReturnedNoRows))
    }

    /// Delete a tag definition. Assignments cascade via `media_tags`.
    pub fn delete_tag(&self, id: &str) -> DbResult<()> {
        validate_non_empty("tag id", id)?;
        let changed = self
            .connection
            .execute("DELETE FROM tags WHERE id = ?1", [id])?;
        if changed == 0 {
            return Err(DbError::InvalidInput("标签不存在".to_owned()));
        }
        Ok(())
    }

    /// Create a tag, or return the existing one when the name already exists.
    pub fn find_or_create_tag(&self, input: NewTag) -> DbResult<Tag> {
        validate_non_empty("tag name", &input.name)?;
        if let Some(existing) = self.get_tag_by_name(&input.name)? {
            return Ok(existing);
        }
        self.create_tag(input)
    }

    /// Attach a tag to many media items in one transaction.
    pub fn attach_tags_batch(
        &self,
        media_item_ids: &[String],
        tag_id: &str,
        at: &str,
    ) -> DbResult<usize> {
        validate_non_empty("tag id", tag_id)?;
        let transaction = self.connection.unchecked_transaction()?;
        let mut applied = 0usize;
        for media_item_id in media_item_ids {
            validate_non_empty("media_item_id", media_item_id)?;
            let changed = transaction.execute(
                "INSERT INTO media_tags (media_item_id, tag_id, created_at) VALUES (?1, ?2, ?3)
                 ON CONFLICT(media_item_id, tag_id) DO NOTHING",
                params![media_item_id, tag_id, at],
            )?;
            applied += changed;
        }
        transaction.commit()?;
        Ok(applied)
    }

    /// Detach a tag from many media items in one transaction.
    pub fn detach_tags_batch(&self, media_item_ids: &[String], tag_id: &str) -> DbResult<usize> {
        validate_non_empty("tag id", tag_id)?;
        let transaction = self.connection.unchecked_transaction()?;
        let mut applied = 0usize;
        for media_item_id in media_item_ids {
            validate_non_empty("media_item_id", media_item_id)?;
            let changed = transaction.execute(
                "DELETE FROM media_tags WHERE media_item_id = ?1 AND tag_id = ?2",
                params![media_item_id, tag_id],
            )?;
            applied += changed;
        }
        transaction.commit()?;
        Ok(applied)
    }

    /// Write a 1–5 star rating. Rating 0 clears the row (unrated).
    pub fn set_rating(&self, media_item_id: &str, rating: i64, at: &str) -> DbResult<()> {
        validate_non_empty("media_item_id", media_item_id)?;
        validate_rating(rating)?;
        if rating == 0 {
            self.connection.execute(
                "DELETE FROM media_ratings WHERE media_item_id = ?1",
                [media_item_id],
            )?;
        } else {
            self.connection.execute(
                "INSERT INTO media_ratings (media_item_id, rating, updated_at)
                 VALUES (?1, ?2, ?3)
                 ON CONFLICT(media_item_id) DO UPDATE SET
                   rating = excluded.rating,
                   updated_at = excluded.updated_at",
                params![media_item_id, rating, at],
            )?;
        }
        Ok(())
    }

    /// Apply the same rating to many items in one transaction. Returns rows changed.
    pub fn set_ratings_batch(
        &self,
        media_item_ids: &[String],
        rating: i64,
        at: &str,
    ) -> DbResult<usize> {
        validate_rating(rating)?;
        let transaction = self.connection.unchecked_transaction()?;
        let mut applied = 0usize;
        for media_item_id in media_item_ids {
            validate_non_empty("media_item_id", media_item_id)?;
            if rating == 0 {
                let changed = transaction.execute(
                    "DELETE FROM media_ratings WHERE media_item_id = ?1",
                    [media_item_id],
                )?;
                applied += changed;
            } else {
                let before: i64 = transaction.query_row(
                    "SELECT COALESCE((SELECT rating FROM media_ratings WHERE media_item_id = ?1), 0)",
                    [media_item_id],
                    |row| row.get(0),
                )?;
                transaction.execute(
                    "INSERT INTO media_ratings (media_item_id, rating, updated_at)
                     VALUES (?1, ?2, ?3)
                     ON CONFLICT(media_item_id) DO UPDATE SET
                       rating = excluded.rating,
                       updated_at = excluded.updated_at",
                    params![media_item_id, rating, at],
                )?;
                if before != rating {
                    applied += 1;
                }
            }
        }
        transaction.commit()?;
        Ok(applied)
    }

    pub fn get_rating(&self, media_item_id: &str) -> DbResult<i64> {
        Ok(self.connection.query_row(
            "SELECT COALESCE((SELECT rating FROM media_ratings WHERE media_item_id = ?1), 0)",
            [media_item_id],
            |row| row.get(0),
        )?)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Tag {
    pub id: String,
    pub name: String,
    pub color: Option<String>,
    pub created_at: String,
    /// How many media items currently carry this tag. Projected, not stored.
    #[serde(default)]
    pub media_count: i64,
    /// Whether AI tagging has ever attached this tag. Projected, not stored;
    /// used by the filter bar to badge AI-assisted tags.
    #[serde(default)]
    pub has_ai: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NewTag {
    pub id: String,
    pub name: String,
    pub color: Option<String>,
    pub created_at: String,
}

pub(crate) fn validate_rating(rating: i64) -> DbResult<()> {
    if !(0..=5).contains(&rating) {
        Err(DbError::InvalidInput(
            "评分必须是 0–5 之间的整数".to_owned(),
        ))
    } else {
        Ok(())
    }
}

pub(crate) fn map_tag(row: &Row<'_>) -> rusqlite::Result<Tag> {
    Ok(Tag {
        id: row.get(0)?,
        name: row.get(1)?,
        color: row.get(2)?,
        created_at: row.get(3)?,
        media_count: row.get(4).unwrap_or(0),
        has_ai: row.get::<_, i64>(5).unwrap_or(0) != 0,
    })
}

#[cfg(test)]
mod tests {
    use crate::db::test_support::{item, library};
    use crate::db::*;

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
        assert!(page.items[0].favorite);
        let all = repository
            .query_media(MediaQuery {
                library_id: "library-1".into(),
                limit: 10,
                ..Default::default()
            })
            .unwrap();
        assert!(all.items.iter().all(|media| media.favorite));
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

    #[test]
    fn tag_crud_batch_attach_detach_and_list_with_counts() {
        let repository = Repository::open_in_memory().unwrap();
        repository.create_library(library()).unwrap();
        for id in ["photo-a", "photo-b", "photo-c"] {
            repository
                .upsert_media_item(item(id, MediaKind::Photo))
                .unwrap();
        }

        let tag = repository
            .create_tag(NewTag {
                id: "tag-travel".into(),
                name: "旅行".into(),
                color: Some("#336699".into()),
                created_at: "2026-01-01T00:00:00Z".into(),
            })
            .unwrap();
        // Same name is a no-op lookup, not a second row.
        let again = repository
            .find_or_create_tag(NewTag {
                id: "tag-other".into(),
                name: "旅行".into(),
                color: None,
                created_at: "2026-01-02T00:00:00Z".into(),
            })
            .unwrap();
        assert_eq!(again.id, tag.id);

        let updated = repository
            .update_tag(&tag.id, Some("旅途"), Some("#112233"))
            .unwrap();
        assert_eq!(updated.name, "旅途");
        assert_eq!(updated.color.as_deref(), Some("#112233"));

        let applied = repository
            .attach_tags_batch(
                &["photo-a".into(), "photo-b".into(), "photo-a".into()],
                &tag.id,
                "2026-01-02T00:00:00Z",
            )
            .unwrap();
        assert_eq!(applied, 2);
        let listed = repository.list_tags().unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].media_count, 2);
        assert_eq!(repository.list_tags_for_media("photo-a").unwrap().len(), 1);

        let removed = repository
            .detach_tags_batch(&["photo-a".into(), "photo-c".into()], &tag.id)
            .unwrap();
        assert_eq!(removed, 1);
        assert_eq!(repository.list_tags().unwrap()[0].media_count, 1);

        repository.delete_tag(&tag.id).unwrap();
        assert!(repository.list_tags().unwrap().is_empty());
        assert!(repository
            .list_tags_for_media("photo-b")
            .unwrap()
            .is_empty());
    }

    #[test]
    fn tag_filter_composes_with_other_filters() {
        let repository = Repository::open_in_memory().unwrap();
        repository.create_library(library()).unwrap();
        for (id, date) in [
            ("photo-a", Some("2026-01-01")),
            ("photo-b", Some("2026-01-02")),
            ("photo-c", Some("2026-01-03")),
        ] {
            let mut media = item(id, MediaKind::Photo);
            media.capture_date = date.map(str::to_owned);
            repository.upsert_media_item(media).unwrap();
        }
        let travel = repository
            .create_tag(NewTag {
                id: "tag-travel".into(),
                name: "旅行".into(),
                color: None,
                created_at: "2026-01-01T00:00:00Z".into(),
            })
            .unwrap();
        let family = repository
            .create_tag(NewTag {
                id: "tag-family".into(),
                name: "家人".into(),
                color: None,
                created_at: "2026-01-01T00:00:00Z".into(),
            })
            .unwrap();
        repository
            .attach_tags_batch(
                &["photo-a".into(), "photo-b".into()],
                &travel.id,
                "2026-01-01T00:00:00Z",
            )
            .unwrap();
        repository
            .attach_tags_batch(
                &["photo-b".into(), "photo-c".into()],
                &family.id,
                "2026-01-01T00:00:00Z",
            )
            .unwrap();
        repository
            .set_favorite("photo-b", true, "2026-01-01T00:00:00Z")
            .unwrap();

        let ids = |query: MediaQuery| -> Vec<String> {
            repository
                .query_media(query)
                .unwrap()
                .items
                .into_iter()
                .map(|media| media.id)
                .collect()
        };

        assert_eq!(
            ids(MediaQuery {
                library_id: "library-1".into(),
                tag_ids: vec![travel.id.clone()],
                limit: 10,
                sort: MediaSort::Oldest,
                ..Default::default()
            }),
            ["photo-a", "photo-b"]
        );
        // Multiple tags require every selected tag (AND).
        assert_eq!(
            ids(MediaQuery {
                library_id: "library-1".into(),
                tag_ids: vec![travel.id.clone(), family.id.clone()],
                limit: 10,
                ..Default::default()
            }),
            ["photo-b"]
        );
        // Tags compose with favorite and date filters.
        assert_eq!(
            ids(MediaQuery {
                library_id: "library-1".into(),
                tag_ids: vec![travel.id.clone()],
                favorite_only: true,
                limit: 10,
                ..Default::default()
            }),
            ["photo-b"]
        );
        assert_eq!(
            ids(MediaQuery {
                library_id: "library-1".into(),
                tag_ids: vec![travel.id],
                date_from: Some("2026-01-02".into()),
                limit: 10,
                ..Default::default()
            }),
            ["photo-b"]
        );
    }

    #[test]
    fn rating_write_filter_sort_and_scan_survival() {
        let temp = tempfile::tempdir().unwrap();
        let database = temp.path().join("camlib.sqlite3");
        {
            let repository = Repository::open(&database).unwrap();
            repository.create_library(library()).unwrap();
            for id in ["photo-low", "photo-mid", "photo-high", "photo-none"] {
                repository
                    .upsert_media_item(item(id, MediaKind::Photo))
                    .unwrap();
            }
            repository
                .set_rating("photo-low", 2, "2026-01-01T00:00:00Z")
                .unwrap();
            repository
                .set_rating("photo-mid", 3, "2026-01-01T00:00:00Z")
                .unwrap();
            repository
                .set_rating("photo-high", 5, "2026-01-01T00:00:00Z")
                .unwrap();
            let applied = repository
                .set_ratings_batch(
                    &["photo-none".into(), "photo-low".into()],
                    4,
                    "2026-01-02T00:00:00Z",
                )
                .unwrap();
            assert_eq!(applied, 2);
            // Upsert (scan path) must not rewrite ratings.
            let mut scanned = item("photo-high", MediaKind::Photo);
            scanned.last_seen_at = "2026-01-03T00:00:00Z".into();
            repository.upsert_media_item(scanned).unwrap();
        }

        let repository = Repository::open(&database).unwrap();
        assert_eq!(repository.get_rating("photo-high").unwrap(), 5);
        assert_eq!(repository.get_rating("photo-low").unwrap(), 4);
        assert_eq!(repository.get_rating("photo-none").unwrap(), 4);
        assert_eq!(repository.get_rating("photo-mid").unwrap(), 3);
        let page = repository
            .query_media(MediaQuery {
                library_id: "library-1".into(),
                limit: 10,
                sort: MediaSort::RatingDesc,
                ..Default::default()
            })
            .unwrap();
        assert_eq!(page.items[0].id, "photo-high");
        assert_eq!(page.items[0].rating, 5);
        let filtered = repository
            .query_media(MediaQuery {
                library_id: "library-1".into(),
                rating_min: Some(4),
                limit: 10,
                ..Default::default()
            })
            .unwrap();
        assert_eq!(filtered.total, 3);
        let exact = repository
            .query_media(MediaQuery {
                library_id: "library-1".into(),
                rating_eq: Some(3),
                limit: 10,
                ..Default::default()
            })
            .unwrap();
        assert_eq!(exact.total, 1);
        assert_eq!(exact.items[0].id, "photo-mid");
        // Clearing rating removes the row.
        repository
            .set_rating("photo-mid", 0, "2026-01-04T00:00:00Z")
            .unwrap();
        assert_eq!(repository.get_rating("photo-mid").unwrap(), 0);
        let error = repository
            .set_rating("photo-low", 9, "2026-01-04T00:00:00Z")
            .unwrap_err();
        assert!(error.to_string().contains("0–5"));
    }

    #[test]
    fn tags_and_ratings_survive_scan_snapshot_reapply() {
        let temp = tempfile::tempdir().unwrap();
        let database = temp.path().join("camlib.sqlite3");
        let item_id;
        {
            let repository = Repository::open(&database).unwrap();
            repository.create_library(library()).unwrap();
            repository
                .upsert_media_item(item("photo-1", MediaKind::Photo))
                .unwrap();
            item_id = repository
                .list_scan_file_records("library-1")
                .ok()
                .map(|_| "photo-1".to_owned())
                .unwrap_or_else(|| "photo-1".to_owned());
            repository
                .create_tag(NewTag {
                    id: "tag-1".into(),
                    name: "旅行".into(),
                    color: None,
                    created_at: "2026-01-01T00:00:00Z".into(),
                })
                .unwrap();
            repository
                .attach_tag(&item_id, "tag-1", "2026-01-01T00:00:00Z")
                .unwrap();
            repository
                .set_rating(&item_id, 4, "2026-01-01T00:00:00Z")
                .unwrap();
            repository
                .set_favorite(&item_id, true, "2026-01-01T00:00:00Z")
                .unwrap();
            // Simulate a scan re-upsert of the same logical id.
            repository
                .upsert_media_item(item("photo-1", MediaKind::Photo))
                .unwrap();
        }
        let repository = Repository::open(&database).unwrap();
        assert!(repository.is_favorite(&item_id).unwrap());
        assert_eq!(repository.get_rating(&item_id).unwrap(), 4);
        assert_eq!(
            repository.list_tags_for_media(&item_id).unwrap()[0].name,
            "旅行"
        );
    }
}
