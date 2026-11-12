//! Backup run and backup item persistence.

use crate::db::{invalid_enum, validate_non_empty, DbError, DbResult, Repository};
use rusqlite::{params, OptionalExtension, Row};
use serde::{Deserialize, Serialize};

impl Repository {
    pub fn create_backup_run(&self, input: NewBackupRun) -> DbResult<BackupRun> {
        validate_non_empty("backup run id", &input.id)?;
        validate_non_empty("job id", &input.job_id)?;
        validate_non_empty("source root path", &input.source_root_path)?;
        let id = input.id.clone();
        self.connection.execute(
            "INSERT INTO backup_runs
             (id, job_id, source_volume_id, source_root_path, target_library_id, status,
              conflict_policy, ignore_extensions, started_at, finished_at, total_files,
              copied_files, skipped_files, failed_files, total_bytes, copied_bytes, error_summary,
              deep_verify)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)",
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
                input.deep_verify,
            ],
        )?;
        self.get_backup_run(&id)?
            .ok_or_else(|| DbError::Sqlite(rusqlite::Error::QueryReturnedNoRows))
    }

    /// Recent backup history for the UI. Pure previews (never started) are
    /// omitted so the list only shows real copy attempts.
    pub fn list_backup_runs(&self, limit: i64) -> DbResult<Vec<BackupRun>> {
        let limit = limit.clamp(1, 100);
        let mut statement = self.connection.prepare(
            "SELECT id, job_id, source_volume_id, source_root_path, target_library_id,
                    status, conflict_policy, ignore_extensions, started_at, finished_at,
                    total_files, copied_files, skipped_files, failed_files, total_bytes,
                    copied_bytes, error_summary, deep_verify
             FROM backup_runs
             WHERE status != 'preview'
             ORDER BY CAST(REPLACE(started_at, 'unix-ms:', '') AS INTEGER) DESC, id DESC
             LIMIT ?1",
        )?;
        let rows = statement
            .query_map([limit], map_backup_run)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// Mark orphaned running backup rows as failed after a process restart.
    pub fn fail_interrupted_backup_runs(&self, finished_at: &str) -> DbResult<usize> {
        let changed = self.connection.execute(
            "UPDATE backup_runs SET status = 'failed', finished_at = ?1,
             error_summary = '应用退出时任务仍在进行，已标记为中断'
             WHERE status = 'running'",
            [finished_at],
        )?;
        Ok(changed)
    }

    pub fn get_backup_run(&self, id: &str) -> DbResult<Option<BackupRun>> {
        self.connection
            .query_row(
                "SELECT id, job_id, source_volume_id, source_root_path, target_library_id,
                        status, conflict_policy, ignore_extensions, started_at, finished_at,
                        total_files, copied_files, skipped_files, failed_files, total_bytes,
                        copied_bytes, error_summary, deep_verify
                 FROM backup_runs WHERE id = ?1",
                [id],
                map_backup_run,
            )
            .optional()
            .map_err(Into::into)
    }

    // 单条 UPDATE 的参数表：形参顺序与 SQL 的 ?1..?9 占位符一一对应，
    // 拆成参数结构体后这条"形参↔占位符"的对应关系会被打散，反而更易绑错。
    #[allow(clippy::too_many_arguments)]
    pub fn update_backup_run(
        &self,
        id: &str,
        job_id: &str,
        status: BackupStatus,
        copied_files: i64,
        skipped_files: i64,
        failed_files: i64,
        copied_bytes: i64,
        finished_at: Option<&str>,
        error_summary: Option<&str>,
    ) -> DbResult<()> {
        self.connection.execute(
            "UPDATE backup_runs SET job_id = ?2, status = ?3, copied_files = ?4,
             skipped_files = ?5, failed_files = ?6, copied_bytes = ?7,
             finished_at = ?8, error_summary = ?9 WHERE id = ?1",
            params![
                id,
                job_id,
                status.as_str(),
                copied_files,
                skipped_files,
                failed_files,
                copied_bytes,
                finished_at,
                error_summary,
            ],
        )?;
        Ok(())
    }

    pub fn create_backup_item(&self, input: NewBackupItem) -> DbResult<()> {
        validate_non_empty("backup item id", &input.id)?;
        validate_non_empty("backup run id", &input.backup_run_id)?;
        validate_non_empty("source relative path", &input.source_relative)?;
        validate_non_empty("status", &input.status)?;
        self.connection.execute(
            "INSERT INTO backup_items
             (id, backup_run_id, source_relative, destination_relative, size_bytes,
              status, copied_bytes, error_message, merge_sources_json)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                input.id,
                input.backup_run_id,
                input.source_relative,
                input.destination_relative,
                input.size_bytes,
                input.status,
                input.copied_bytes,
                input.error_message,
                input.merge_sources_json,
            ],
        )?;
        Ok(())
    }

    /// Persist a backup plan atomically. Preview can contain thousands of
    /// camera files, so committing each row independently is needlessly slow.
    pub fn create_backup_items(&self, inputs: &[NewBackupItem]) -> DbResult<()> {
        for input in inputs {
            validate_non_empty("backup item id", &input.id)?;
            validate_non_empty("backup run id", &input.backup_run_id)?;
            validate_non_empty("source relative path", &input.source_relative)?;
            validate_non_empty("status", &input.status)?;
        }
        let transaction = self.connection.unchecked_transaction()?;
        {
            let mut statement = transaction.prepare(
                "INSERT INTO backup_items
                 (id, backup_run_id, source_relative, destination_relative, size_bytes,
                  status, copied_bytes, error_message, merge_sources_json)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            )?;
            for input in inputs {
                statement.execute(params![
                    input.id,
                    input.backup_run_id,
                    input.source_relative,
                    input.destination_relative,
                    input.size_bytes,
                    input.status,
                    input.copied_bytes,
                    input.error_message,
                    input.merge_sources_json,
                ])?;
            }
        }
        transaction.commit()?;
        Ok(())
    }

    pub fn list_backup_items(&self, backup_run_id: &str) -> DbResult<Vec<BackupItem>> {
        let mut statement = self.connection.prepare(
            "SELECT id, backup_run_id, source_relative, destination_relative, size_bytes,
                    status, copied_bytes, error_message, merge_sources_json
             FROM backup_items WHERE backup_run_id = ?1 ORDER BY id",
        )?;
        let rows = statement
            .query_map([backup_run_id], map_backup_item)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(Into::into);
        rows
    }

    pub fn update_backup_item(
        &self,
        id: &str,
        status: &str,
        copied_bytes: i64,
        destination_relative: Option<&str>,
        error_message: Option<&str>,
    ) -> DbResult<()> {
        self.connection.execute(
            "UPDATE backup_items SET status = ?2, copied_bytes = ?3,
             destination_relative = COALESCE(?4, destination_relative), error_message = ?5
             WHERE id = ?1",
            params![
                id,
                status,
                copied_bytes,
                destination_relative,
                error_message
            ],
        )?;
        Ok(())
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
    pub(crate) fn as_str(&self) -> &'static str {
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
    pub(crate) fn as_str(&self) -> &'static str {
        match self {
            Self::SkipSame => "skip_same",
            Self::Rename => "rename",
            Self::Overwrite => "overwrite",
        }
    }
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
    /// Content-hash verification of every copied file. Off by default; the
    /// value is fixed at preview time so the execution matches what the user
    /// confirmed and a retry keeps the same guarantee.
    pub deep_verify: bool,
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
    pub deep_verify: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BackupItem {
    pub id: String,
    pub backup_run_id: String,
    pub source_relative: String,
    pub destination_relative: Option<String>,
    pub size_bytes: i64,
    pub status: String,
    pub copied_bytes: i64,
    pub error_message: Option<String>,
    /// JSON array of source_relative paths when this item merges camera-split
    /// video segments. `None` for ordinary single-file copies.
    pub merge_sources_json: Option<String>,
}

#[derive(Debug, Clone)]
pub struct NewBackupItem {
    pub id: String,
    pub backup_run_id: String,
    pub source_relative: String,
    pub destination_relative: Option<String>,
    pub size_bytes: i64,
    pub status: String,
    pub copied_bytes: i64,
    pub error_message: Option<String>,
    pub merge_sources_json: Option<String>,
}

pub(crate) fn map_backup_run(row: &Row<'_>) -> rusqlite::Result<BackupRun> {
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
        deep_verify: row.get(17)?,
    })
}

pub(crate) fn map_backup_item(row: &Row<'_>) -> rusqlite::Result<BackupItem> {
    Ok(BackupItem {
        id: row.get(0)?,
        backup_run_id: row.get(1)?,
        source_relative: row.get(2)?,
        destination_relative: row.get(3)?,
        size_bytes: row.get(4)?,
        status: row.get(5)?,
        copied_bytes: row.get(6)?,
        error_message: row.get(7)?,
        merge_sources_json: row.get(8)?,
    })
}

pub(crate) fn parse_backup_status(value: String) -> rusqlite::Result<BackupStatus> {
    match value.as_str() {
        "preview" => Ok(BackupStatus::Preview),
        "running" => Ok(BackupStatus::Running),
        "completed" => Ok(BackupStatus::Completed),
        "cancelled" => Ok(BackupStatus::Cancelled),
        "failed" => Ok(BackupStatus::Failed),
        _ => Err(invalid_enum(value, "backup_runs.status")),
    }
}
pub(crate) fn parse_conflict_policy(value: String) -> rusqlite::Result<ConflictPolicy> {
    match value.as_str() {
        "skip_same" => Ok(ConflictPolicy::SkipSame),
        "rename" => Ok(ConflictPolicy::Rename),
        "overwrite" => Ok(ConflictPolicy::Overwrite),
        _ => Err(invalid_enum(value, "backup_runs.conflict_policy")),
    }
}

#[cfg(test)]
mod tests {
    use crate::db::test_support::library;
    use crate::db::*;

    #[test]
    fn list_backup_runs_skips_previews_and_orders_newest_first() {
        let repository = Repository::open_in_memory().unwrap();
        repository.create_library(library()).unwrap();

        let insert = |id: &str, status: BackupStatus, started_at: &str| {
            repository
                .create_backup_run(NewBackupRun {
                    id: id.into(),
                    job_id: format!("job-{id}"),
                    source_volume_id: Some("volume-a".into()),
                    source_root_path: "E:\\".into(),
                    target_library_id: "library-1".into(),
                    status,
                    conflict_policy: ConflictPolicy::SkipSame,
                    ignore_extensions: "[\".dng\"]".into(),
                    started_at: started_at.into(),
                    finished_at: None,
                    total_files: 2,
                    copied_files: 1,
                    skipped_files: 0,
                    failed_files: 0,
                    total_bytes: 10,
                    copied_bytes: 5,
                    error_summary: None,
                    deep_verify: false,
                })
                .unwrap();
        };
        insert("preview-only", BackupStatus::Preview, "unix-ms:100");
        insert("older-run", BackupStatus::Completed, "unix-ms:200");
        insert("newer-run", BackupStatus::Failed, "unix-ms:300");

        let runs = repository.list_backup_runs(10).unwrap();
        let ids = runs.iter().map(|run| run.id.as_str()).collect::<Vec<_>>();
        assert_eq!(ids, ["newer-run", "older-run"]);
        assert_eq!(runs[0].failed_files, 0);
    }

    #[test]
    fn backup_run_persists_the_deep_verify_switch() {
        let repository = Repository::open_in_memory().unwrap();
        repository.create_library(library()).unwrap();
        let run = repository
            .create_backup_run(NewBackupRun {
                id: "run-deep".into(),
                job_id: "job-deep".into(),
                source_volume_id: None,
                source_root_path: "E:\\".into(),
                target_library_id: "library-1".into(),
                status: BackupStatus::Preview,
                conflict_policy: ConflictPolicy::SkipSame,
                ignore_extensions: "[]".into(),
                started_at: "unix-ms:100".into(),
                finished_at: None,
                total_files: 1,
                copied_files: 0,
                skipped_files: 0,
                failed_files: 0,
                total_bytes: 4,
                copied_bytes: 0,
                error_summary: None,
                deep_verify: true,
            })
            .unwrap();
        assert!(run.deep_verify);
        // The flag survives the round trip so retry keeps the same guarantee.
        let reloaded = repository.get_backup_run("run-deep").unwrap().unwrap();
        assert!(reloaded.deep_verify);
    }

    #[test]
    fn interrupted_scan_and_backup_runs_are_marked_failed_on_restart() {
        let repository = Repository::open_in_memory().unwrap();
        repository.create_library(library()).unwrap();

        repository
            .begin_scan_run(NewScanRun {
                id: "run-scan-orphan".into(),
                library_id: "library-1".into(),
                job_id: "job-scan".into(),
                started_at: "unix-ms:100".into(),
            })
            .unwrap();
        repository
            .create_backup_run(NewBackupRun {
                id: "run-backup-orphan".into(),
                job_id: "job-backup".into(),
                source_volume_id: None,
                source_root_path: "E:\\".into(),
                target_library_id: "library-1".into(),
                status: BackupStatus::Running,
                conflict_policy: ConflictPolicy::SkipSame,
                ignore_extensions: "[]".into(),
                started_at: "unix-ms:100".into(),
                finished_at: None,
                total_files: 1,
                copied_files: 0,
                skipped_files: 0,
                failed_files: 0,
                total_bytes: 0,
                copied_bytes: 0,
                error_summary: None,
                deep_verify: false,
            })
            .unwrap();

        let scan_changed = repository
            .fail_interrupted_scan_runs("unix-ms:999")
            .unwrap();
        let backup_changed = repository
            .fail_interrupted_backup_runs("unix-ms:999")
            .unwrap();
        assert_eq!(scan_changed, 1);
        assert_eq!(backup_changed, 1);

        let scans = repository.list_scan_runs("library-1", 5).unwrap();
        assert_eq!(scans[0].status, "failed");
        assert!(scans[0]
            .error_summary
            .as_deref()
            .unwrap_or_default()
            .contains("中断"));

        let backups = repository.list_backup_runs(5).unwrap();
        assert_eq!(backups[0].status, BackupStatus::Failed);
        assert!(backups[0]
            .error_summary
            .as_deref()
            .unwrap_or_default()
            .contains("中断"));
    }
}
