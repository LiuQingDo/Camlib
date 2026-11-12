//! Media list queries: filtering, sorting, pagination, and date facets.

use super::media::{map_media_item, MediaItem, MediaKind};
use crate::db::{escape_like, DbResult, Repository};
use serde::{Deserialize, Serialize};

impl Repository {
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
        if query.burst_only {
            conditions.push("m.burst_group IS NOT NULL".to_owned());
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
        // Inclusive `YYYY-MM-DD` string bounds; NULL capture dates never match.
        if let Some(date_from) = query.date_from.filter(|value| !value.trim().is_empty()) {
            conditions.push(format!("m.capture_date >= ?{}", values.len() + 1));
            values.push(date_from.trim().to_owned());
        }
        if let Some(date_to) = query.date_to.filter(|value| !value.trim().is_empty()) {
            conditions.push(format!("m.capture_date <= ?{}", values.len() + 1));
            values.push(date_to.trim().to_owned());
        }
        // Keep only media first indexed at/after a timestamp. Production writes
        // `unix-ms:<millis>`; the filter accepts that form or a bare integer.
        if let Some(first_seen_from) = query
            .first_seen_from
            .filter(|value| !value.trim().is_empty())
        {
            let raw = first_seen_from.trim();
            let numeric = raw.strip_prefix("unix-ms:").unwrap_or(raw);
            if let Ok(threshold) = numeric.parse::<i64>() {
                conditions.push(format!(
                    "m.first_seen_at LIKE 'unix-ms:%' AND CAST(SUBSTR(m.first_seen_at, 9) AS INTEGER) >= ?{}",
                    values.len() + 1
                ));
                values.push(threshold.to_string());
            }
        }
        // Tag filters compose as AND: the media must carry every selected tag.
        // Both relation tables count — AI-tagged rows live in `media_ai_tags`
        // so user-managed `media_tags` rows can never be clobbered by AI runs.
        for tag_id in &query.tag_ids {
            if tag_id.trim().is_empty() {
                continue;
            }
            conditions.push(format!(
                "(EXISTS (SELECT 1 FROM media_tags mt WHERE mt.media_item_id = m.id AND mt.tag_id = ?{}) \
                 OR EXISTS (SELECT 1 FROM media_ai_tags mat WHERE mat.media_item_id = m.id AND mat.tag_id = ?{}))",
                values.len() + 1,
                values.len() + 2
            ));
            values.push(tag_id.trim().to_owned());
            values.push(tag_id.trim().to_owned());
        }
        if !query.item_ids.is_empty() {
            let placeholders = query
                .item_ids
                .iter()
                .map(|id| {
                    values.push(id.clone());
                    format!("?{}", values.len())
                })
                .collect::<Vec<_>>()
                .join(", ");
            conditions.push(format!("m.id IN ({placeholders})"));
        }
        if let Some(rating_eq) = query.rating_eq.filter(|value| (0..=5).contains(value)) {
            if rating_eq == 0 {
                conditions.push(
                    "NOT EXISTS (SELECT 1 FROM media_ratings r WHERE r.media_item_id = m.id)"
                        .to_owned(),
                );
            } else {
                conditions.push(format!(
                    "EXISTS (SELECT 1 FROM media_ratings r WHERE r.media_item_id = m.id AND r.rating = ?{})",
                    values.len() + 1
                ));
                values.push(rating_eq.to_string());
            }
        } else if let Some(rating_min) = query.rating_min.filter(|value| (1..=5).contains(value)) {
            conditions.push(format!(
                "EXISTS (SELECT 1 FROM media_ratings r WHERE r.media_item_id = m.id AND r.rating >= ?{})",
                values.len() + 1
            ));
            values.push(rating_min.to_string());
        }
        let where_clause = conditions.join(" AND ");
        let count_sql = format!("SELECT COUNT(*) FROM media_items m WHERE {where_clause}");
        let count_params = values.iter().map(String::as_str).collect::<Vec<_>>();
        let total: i64 = self.connection.query_row(
            &count_sql,
            rusqlite::params_from_iter(count_params.iter()),
            |row| row.get(0),
        )?;

        // `capture_at` is not populated for files that only have a date from
        // their directory/name. Use that date first and the newest member file
        // time as a tie breaker. Unknown dates are deliberately kept at the
        // end in both directions instead of SQLite's default NULL placement.
        let latest_file_modified =
            "(SELECT MAX(f.modified_at) FROM media_files f WHERE f.media_item_id = m.id)";
        let rating_projection =
            "COALESCE((SELECT r.rating FROM media_ratings r WHERE r.media_item_id = m.id), 0)";
        let order = match query.sort {
            MediaSort::Oldest => format!(
                "CASE WHEN m.capture_date IS NULL THEN 1 ELSE 0 END,
                 m.capture_date ASC, m.capture_at ASC,
                 {latest_file_modified} ASC,
                 m.display_name COLLATE NATURAL_NOCASE ASC, m.id ASC"
            ),
            MediaSort::Name => "m.display_name COLLATE NATURAL_NOCASE ASC, m.id ASC".to_owned(),
            MediaSort::RatingDesc => format!(
                "{rating_projection} DESC,
                 CASE WHEN m.capture_date IS NULL THEN 1 ELSE 0 END,
                 m.capture_date DESC, m.display_name COLLATE NATURAL_NOCASE DESC, m.id DESC"
            ),
            MediaSort::RatingAsc => format!(
                "CASE WHEN {rating_projection} = 0 THEN 1 ELSE 0 END,
                 {rating_projection} ASC,
                 CASE WHEN m.capture_date IS NULL THEN 1 ELSE 0 END,
                 m.capture_date DESC, m.display_name COLLATE NATURAL_NOCASE DESC, m.id DESC"
            ),
            // `total_size_bytes` is always populated (0 when unknown), so size
            // sorts have no NULL branch; date/name tie breakers keep runs stable.
            MediaSort::SizeDesc => "m.total_size_bytes DESC,
                 CASE WHEN m.capture_date IS NULL THEN 1 ELSE 0 END,
                 m.capture_date DESC, m.display_name COLLATE NATURAL_NOCASE DESC, m.id DESC"
                .to_owned(),
            MediaSort::SizeAsc => "m.total_size_bytes ASC,
                 CASE WHEN m.capture_date IS NULL THEN 1 ELSE 0 END,
                 m.capture_date DESC, m.display_name COLLATE NATURAL_NOCASE DESC, m.id DESC"
                .to_owned(),
            MediaSort::Newest => format!(
                "CASE WHEN m.capture_date IS NULL THEN 1 ELSE 0 END,
                 m.capture_date DESC, m.capture_at DESC,
                 {latest_file_modified} DESC,
                 m.display_name COLLATE NATURAL_NOCASE DESC, m.id DESC"
            ),
        };
        let item_sql = format!(
            "SELECT m.id, m.library_id, m.logical_key, m.kind, m.display_name,
                    m.capture_at, m.capture_date, m.width, m.height, m.duration_ms,
                    m.total_size_bytes, m.burst_group, m.metadata_json, m.scan_state,
                    m.first_seen_at, m.last_seen_at,
                    EXISTS (SELECT 1 FROM favorites fav WHERE fav.media_item_id = m.id),
                    {rating_projection}
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
}

/// List-query filters for `media_items`.
///
/// Date filters compose as AND:
/// - `date_prefix`: `YYYY` / `YYYY-MM` / `YYYY-MM-DD` LIKE prefix (sidebar).
/// - `date_from` / `date_to`: inclusive `capture_date` bounds (`YYYY-MM-DD`).
///   Rows with a NULL `capture_date` are excluded when either bound is set.
///   Frontend normally keeps prefix and range mutually exclusive in the UI.
#[derive(Debug, Clone, Default)]
pub struct MediaQuery {
    pub library_id: String,
    pub kind: Option<MediaKind>,
    pub favorite_only: bool,
    pub burst_only: bool,
    pub search: Option<String>,
    pub date_prefix: Option<String>,
    pub date_from: Option<String>,
    pub date_to: Option<String>,
    /// Keep media whose `first_seen_at` is at/after this timestamp
    /// (`unix-ms:<millis>` or a bare integer). Used by post-backup import guide.
    pub first_seen_from: Option<String>,
    /// Keep media that carry every listed tag id (AND).
    pub tag_ids: Vec<String>,
    /// Restrict to these media item ids (semantic search candidate sets).
    /// Ignored when empty; no artificial cap beyond SQLite's parameter limit,
    /// so callers must keep the list bounded (a few hundred at most).
    pub item_ids: Vec<String>,
    /// Keep media with this exact rating (0 = unrated only). Takes precedence
    /// over `rating_min` when both are set.
    pub rating_eq: Option<i64>,
    /// Keep media with rating >= this value (1–5).
    pub rating_min: Option<i64>,
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
    RatingDesc,
    RatingAsc,
    SizeDesc,
    SizeAsc,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MediaPage {
    pub items: Vec<MediaItem>,
    pub total: i64,
    pub offset: i64,
    pub limit: i64,
}

#[cfg(test)]
mod tests {
    use crate::db::test_support::{item, library};
    use crate::db::*;

    #[test]
    fn set_favorites_batch_is_transactional_and_idempotent() {
        let repository = Repository::open_in_memory().unwrap();
        repository.create_library(library()).unwrap();
        repository
            .upsert_media_item(item("photo-a", MediaKind::Photo))
            .unwrap();
        repository
            .upsert_media_item(item("photo-b", MediaKind::Photo))
            .unwrap();
        repository
            .set_favorite("photo-a", true, "2026-01-01T00:00:00Z")
            .unwrap();
        let applied = repository
            .set_favorites_batch(
                &["photo-a".into(), "photo-b".into()],
                true,
                "2026-01-02T00:00:00Z",
            )
            .unwrap();
        assert_eq!(applied, 1);
        let page = repository
            .query_media(MediaQuery {
                library_id: "library-1".into(),
                favorite_only: true,
                limit: 10,
                ..Default::default()
            })
            .unwrap();
        assert_eq!(page.total, 2);
        let removed = repository
            .set_favorites_batch(
                &["photo-a".into(), "photo-b".into()],
                false,
                "2026-01-03T00:00:00Z",
            )
            .unwrap();
        assert_eq!(removed, 2);
        let page = repository
            .query_media(MediaQuery {
                library_id: "library-1".into(),
                favorite_only: true,
                limit: 10,
                ..Default::default()
            })
            .unwrap();
        assert_eq!(page.total, 0);
    }

    #[test]
    fn media_query_sorts_dates_and_file_names_stably() {
        let repository = Repository::open_in_memory().unwrap();
        repository.create_library(library()).unwrap();

        for (id, name, date) in [
            ("photo-old", "IMG_10.JPG", "2026-01-01"),
            ("photo-middle", "IMG_2.JPG", "2026-01-02"),
            ("photo-new", "IMG_1.JPG", "2026-01-03"),
        ] {
            let mut media = item(id, MediaKind::Photo);
            media.display_name = name.to_owned();
            media.capture_date = Some(date.to_owned());
            repository.upsert_media_item(media).unwrap();
        }

        let names = repository
            .query_media(MediaQuery {
                library_id: "library-1".into(),
                sort: MediaSort::Name,
                limit: 10,
                ..Default::default()
            })
            .unwrap()
            .items
            .into_iter()
            .map(|media| media.display_name)
            .collect::<Vec<_>>();
        assert_eq!(names, ["IMG_1.JPG", "IMG_2.JPG", "IMG_10.JPG"]);

        let newest = repository
            .query_media(MediaQuery {
                library_id: "library-1".into(),
                sort: MediaSort::Newest,
                limit: 10,
                ..Default::default()
            })
            .unwrap()
            .items
            .into_iter()
            .map(|media| media.id)
            .collect::<Vec<_>>();
        assert_eq!(newest, ["photo-new", "photo-middle", "photo-old"]);
    }

    #[test]
    fn media_query_supports_date_prefix_range_and_burst_filters() {
        let repository = Repository::open_in_memory().unwrap();
        repository.create_library(library()).unwrap();

        for (id, date, burst) in [
            ("early", Some("2025-12-31"), None),
            ("start", Some("2026-01-01"), Some("burst-a")),
            ("mid", Some("2026-01-02"), Some("burst-a")),
            ("end", Some("2026-01-15"), None),
            ("late", Some("2026-02-01"), None),
            ("unknown", None, None),
        ] {
            let mut media = item(id, MediaKind::Photo);
            media.capture_date = date.map(str::to_owned);
            media.burst_group = burst.map(str::to_owned);
            repository.upsert_media_item(media).unwrap();
        }

        let ids = |query: MediaQuery| -> Vec<String> {
            repository
                .query_media(query)
                .unwrap()
                .items
                .into_iter()
                .map(|media| media.id)
                .collect()
        };

        // Prefix matches a year / month / day without an explicit range.
        assert_eq!(
            ids(MediaQuery {
                library_id: "library-1".into(),
                date_prefix: Some("2026-01".into()),
                limit: 10,
                ..Default::default()
            }),
            ["end", "mid", "start"]
        );
        // Inclusive range: start and end dates included; outside and NULL excluded.
        assert_eq!(
            ids(MediaQuery {
                library_id: "library-1".into(),
                date_from: Some("2026-01-01".into()),
                date_to: Some("2026-01-15".into()),
                limit: 10,
                ..Default::default()
            }),
            ["end", "mid", "start"]
        );
        // Open-ended lower bound.
        assert_eq!(
            ids(MediaQuery {
                library_id: "library-1".into(),
                date_from: Some("2026-01-16".into()),
                limit: 10,
                ..Default::default()
            }),
            ["late"]
        );
        // Burst-only keeps items with a non-null burst_group.
        assert_eq!(
            ids(MediaQuery {
                library_id: "library-1".into(),
                burst_only: true,
                limit: 10,
                ..Default::default()
            }),
            ["mid", "start"]
        );
        // Burst + range compose as AND.
        assert_eq!(
            ids(MediaQuery {
                library_id: "library-1".into(),
                burst_only: true,
                date_from: Some("2026-01-02".into()),
                limit: 10,
                ..Default::default()
            }),
            ["mid"]
        );
    }

    #[test]
    fn favorite_survives_repository_reopen() {
        let temp = tempfile::tempdir().unwrap();
        let database = temp.path().join("camlib.sqlite3");
        {
            let repository = Repository::open(&database).unwrap();
            repository.create_library(library()).unwrap();
            repository
                .upsert_media_item(item("photo-reopen", MediaKind::Photo))
                .unwrap();
            repository
                .set_favorite("photo-reopen", true, "2026-01-01T00:00:00Z")
                .unwrap();
        }
        let reopened = Repository::open(&database).unwrap();
        assert!(reopened.is_favorite("photo-reopen").unwrap());
    }

    #[test]
    fn size_sort_orders_by_total_size_bytes() {
        let temp = tempfile::tempdir().unwrap();
        let database = temp.path().join("camlib.sqlite3");
        let repository = Repository::open(&database).unwrap();
        repository.create_library(library()).unwrap();
        for (id, size) in [
            ("photo-small", 100_i64),
            ("photo-large", 9000),
            ("photo-mid", 1000),
        ] {
            let mut media = item(id, MediaKind::Photo);
            media.total_size_bytes = size;
            repository.upsert_media_item(media).unwrap();
        }

        let ids = |sort: MediaSort| -> Vec<String> {
            repository
                .query_media(MediaQuery {
                    library_id: "library-1".into(),
                    limit: 10,
                    sort,
                    ..Default::default()
                })
                .unwrap()
                .items
                .into_iter()
                .map(|media| media.id)
                .collect()
        };

        assert_eq!(
            ids(MediaSort::SizeDesc),
            ["photo-large", "photo-mid", "photo-small"]
        );
        assert_eq!(
            ids(MediaSort::SizeAsc),
            ["photo-small", "photo-mid", "photo-large"]
        );
    }

    #[test]
    fn media_query_filters_by_first_seen_from_unix_ms() {
        let repository = Repository::open_in_memory().unwrap();
        repository.create_library(library()).unwrap();

        for (id, first_seen) in [
            ("old-import", "unix-ms:1000"),
            ("backup-import", "unix-ms:2000"),
            ("later-import", "unix-ms:3000"),
            ("iso-import", "2026-01-01T00:00:00Z"),
        ] {
            let mut media = item(id, MediaKind::Photo);
            media.first_seen_at = first_seen.into();
            repository.upsert_media_item(media).unwrap();
        }

        let ids = repository
            .query_media(MediaQuery {
                library_id: "library-1".into(),
                first_seen_from: Some("unix-ms:2000".into()),
                limit: 10,
                ..Default::default()
            })
            .unwrap()
            .items
            .into_iter()
            .map(|media| media.id)
            .collect::<Vec<_>>();
        assert_eq!(ids, ["later-import", "backup-import"]);
    }
}
