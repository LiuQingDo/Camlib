//! Tauri command handlers, grouped by feature area.

pub(super) mod ai;
pub(super) mod backup;
pub(super) mod editing;
pub(super) mod media;
pub(super) mod settings;
pub(super) mod system;

use crate::infrastructure::{Infrastructure, InfrastructureError, LibraryAvailability};

/// Block dangerous filesystem work while the library volume is unavailable.
pub(super) fn ensure_library_ready(
    infrastructure: &mut Infrastructure,
    library_id: &str,
) -> Result<(), InfrastructureError> {
    let exists = infrastructure.has_library(library_id)?;
    if !exists {
        return Err(InfrastructureError::InvalidPath("媒体库不存在".to_owned()));
    }
    let status = infrastructure.library_status()?;
    match status.availability {
        LibraryAvailability::Available => Ok(()),
        LibraryAvailability::Unconfigured => Err(InfrastructureError::InvalidPath(
            "尚未配置媒体库".to_owned(),
        )),
        LibraryAvailability::Disconnected => Err(InfrastructureError::LibraryOffline(
            status
                .reason
                .unwrap_or_else(|| "媒体库已断开，请连接磁盘后重试".to_owned()),
        )),
        LibraryAvailability::Invalid => Err(InfrastructureError::VolumeChanged(
            status
                .reason
                .unwrap_or_else(|| "媒体库卷与记录不一致，请重新选择媒体库目录".to_owned()),
        )),
    }
}
