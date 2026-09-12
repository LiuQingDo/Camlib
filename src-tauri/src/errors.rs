//! Structured command errors shared by Rust commands and the frontend.
//!
//! The serialized shape is the contract in `docs/development-notes.md`:
//! `{ code, message, retryable, details? }`. Frontend maps `code` to Chinese
//! user-facing copy; logs may keep `message` and `details`.

use crate::backup::BackupError;
use crate::db::DbError;
use crate::infrastructure::InfrastructureError;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ErrorCode {
    InvalidArgument,
    LibraryOffline,
    PathOutsideRoot,
    VolumeChanged,
    MediaMissing,
    Conflict,
    InsufficientSpace,
    JobNotFound,
    JobAlreadyRunning,
    Cancelled,
    IoError,
    DatabaseError,
    ThumbnailError,
    Internal,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppError {
    pub code: ErrorCode,
    pub message: String,
    pub retryable: bool,
    #[serde(default, skip_serializing_if = "serde_json::Value::is_null")]
    pub details: serde_json::Value,
}

impl AppError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            retryable: matches!(
                code,
                ErrorCode::LibraryOffline | ErrorCode::IoError | ErrorCode::InsufficientSpace
            ),
            details: serde_json::Value::Null,
        }
    }

    #[allow(dead_code)]
    pub fn with_details(mut self, details: serde_json::Value) -> Self {
        if !details.is_null() {
            self.details = details;
        }
        self
    }

    pub fn invalid_argument(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::InvalidArgument, message)
    }

    pub fn library_offline(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::LibraryOffline, message)
    }

    pub fn path_outside_root(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::PathOutsideRoot, message)
    }

    pub fn volume_changed(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::VolumeChanged, message)
    }

    pub fn media_missing(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::MediaMissing, message)
    }

    #[allow(dead_code)]
    pub fn conflict(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::Conflict, message)
    }

    pub fn insufficient_space(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::InsufficientSpace, message)
    }

    pub fn job_not_found(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::JobNotFound, message)
    }

    pub fn job_already_running(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::JobAlreadyRunning, message)
    }

    pub fn cancelled(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::Cancelled, message)
    }

    pub fn io(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::IoError, message)
    }

    pub fn database(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::DatabaseError, message)
    }

    pub fn thumbnail(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::ThumbnailError, message)
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::Internal, message)
    }
}

impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl std::error::Error for AppError {}

impl From<InfrastructureError> for AppError {
    fn from(error: InfrastructureError) -> Self {
        match error {
            InfrastructureError::App(error) => error,
            InfrastructureError::LibraryOffline(message) => AppError::library_offline(message),
            InfrastructureError::VolumeChanged(message) => AppError::volume_changed(message),
            InfrastructureError::MediaMissing(message) => AppError::media_missing(message),
            InfrastructureError::PathOutsideRoot(message) => AppError::path_outside_root(message),
            InfrastructureError::InvalidPath(message) => AppError::invalid_argument(message),
            InfrastructureError::InvalidSettings(message) => AppError::invalid_argument(message),
            InfrastructureError::Io { path, message } => {
                AppError::io(format!("访问路径 {} 失败: {message}", path.display()))
            }
            InfrastructureError::Database(message) => AppError::database(message),
        }
    }
}

impl From<DbError> for AppError {
    fn from(error: DbError) -> Self {
        match error {
            DbError::InvalidInput(message) => AppError::invalid_argument(message),
            other => AppError::database(other.to_string()),
        }
    }
}

impl From<BackupError> for AppError {
    fn from(error: BackupError) -> Self {
        match error {
            BackupError::Invalid(message) => AppError::invalid_argument(message),
            BackupError::Io { path, source } => {
                AppError::io(format!("读取备份路径失败 {}: {source}", path.display()))
            }
            BackupError::Database(error) => AppError::from(error),
        }
    }
}

impl From<String> for AppError {
    fn from(message: String) -> Self {
        classify_message(message)
    }
}

impl From<&str> for AppError {
    fn from(message: &str) -> Self {
        classify_message(message.to_owned())
    }
}

/// Fallback classifier for modules that still return plain strings.
/// Prefer typed constructors; this only bridges legacy call sites.
fn classify_message(message: String) -> AppError {
    let lower = message.to_ascii_lowercase();
    if lower.contains("已有扫描") || lower.contains("已有备份") || lower.contains("正在运行")
    {
        AppError::job_already_running(message)
    } else if lower.contains("任务不存在") || lower.contains("job") && lower.contains("not") {
        AppError::job_not_found(message)
    } else if lower.contains("断开") || lower.contains("offline") {
        AppError::library_offline(message)
    } else if lower.contains("越界")
        || lower.contains("越过")
        || lower.contains("相对路径无效")
        || lower.contains("路径穿越")
    {
        AppError::path_outside_root(message)
    } else if lower.contains("卷不一致") || lower.contains("volume") {
        AppError::volume_changed(message)
    } else if lower.contains("媒体不存在") || lower.contains("媒体文件不可用") {
        AppError::media_missing(message)
    } else if lower.contains("空间不足") {
        AppError::insufficient_space(message)
    } else if lower.contains("数据库") {
        AppError::database(message)
    } else if lower.contains("缩略图") {
        AppError::thumbnail(message)
    } else if lower.contains("取消") {
        AppError::cancelled(message)
    } else {
        AppError::internal(message)
    }
}

/// Shared helper for command modules that still use `Result<_, String>`.
#[allow(dead_code)]
pub type AppResult<T> = Result<T, AppError>;

#[allow(dead_code)]
pub fn lock_poisoned(label: &str) -> AppError {
    AppError::internal(format!("{label}状态锁已损坏"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_the_documented_contract_shape() {
        let error = AppError::library_offline("媒体库所在卷当前不可用")
            .with_details(serde_json::json!({ "libraryId": "library-1" }));
        let value = serde_json::to_value(&error).unwrap();
        assert_eq!(value["code"], "LIBRARY_OFFLINE");
        assert_eq!(value["message"], "媒体库所在卷当前不可用");
        assert_eq!(value["retryable"], true);
        assert_eq!(value["details"]["libraryId"], "library-1");
    }

    #[test]
    fn infrastructure_errors_map_to_codes() {
        assert_eq!(
            AppError::from(InfrastructureError::LibraryOffline("断开".into())).code,
            ErrorCode::LibraryOffline
        );
        assert_eq!(
            AppError::from(InfrastructureError::PathOutsideRoot("越界".into())).code,
            ErrorCode::PathOutsideRoot
        );
        assert_eq!(
            AppError::from(InfrastructureError::MediaMissing("媒体不存在".into())).code,
            ErrorCode::MediaMissing
        );
        assert_eq!(
            AppError::from(InfrastructureError::Database("db".into())).code,
            ErrorCode::DatabaseError
        );
        assert_eq!(
            AppError::from(InfrastructureError::Io {
                path: "x".into(),
                message: "e".into()
            })
            .code,
            ErrorCode::IoError
        );
    }

    #[test]
    fn job_lock_errors_classify_as_internal() {
        let error = lock_poisoned("扫描任务");
        assert_eq!(error.code, ErrorCode::Internal);
    }
}
