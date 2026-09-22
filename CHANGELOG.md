# Changelog

All notable changes to Camlib are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

- **PATCH** — bug fixes, copy, security hardening; no data migration
- **MINOR** — features; index/settings stay backward compatible
- **MAJOR** — breaking changes (migration or re-scan required)

SQLite schema version lives in `CURRENT_SCHEMA_VERSION` (`src-tauri/src/db/mod.rs`). See [docs/data-model.md](docs/data-model.md).

Release installers may bundle ffmpeg for video thumbnails; the **Git repository does not**. Uninstall does not delete the media library directory; index/settings live under `%APPDATA%\com.camera.media-library\`.

## [Unreleased]

## [0.2.0] - 2026-09-21

Assets: [GitHub Release v0.2.0](https://github.com/LiuQingDo/Camlib/releases/tag/v0.2.0) — `Camlib_0.2.0_x64-setup.exe` (NSIS, recommended), `Camlib_0.2.0_x64_en-US.msi` (WiX)

### Added

- Persisted light/dark `ui_theme` preference
- Collapsible filters, infinite-scroll load-more, and thumbnail cache
- SVG star ratings, duration badge, and preview skeleton
- Auto-dismissing toast kinds and dismissible error banner
- Open-source scaffolding: GitHub Actions CI, issue / PR templates, `CONTRIBUTING.md`, `SECURITY.md`, this changelog
- Repo and package metadata (description, repository links, keywords)

## [0.1.2] - 2026-09-20

Assets: [GitHub Release v0.1.2](https://github.com/LiuQingDo/Camlib/releases/tag/v0.1.2) — `Camlib_0.1.2_x64-setup.exe` (NSIS, recommended), `Camlib_0.1.2_x64_en-US.msi` (WiX)

### Added

- Custom embedded titlebar with window controls
- `ui_preview_mode` setting (standard / immersive preview)
- English README (`README.en.md`) and language switcher links
- MIT `LICENSE` and package metadata
- Documentation for Insta360 Ace Pro 2 USB backup and default ignored extensions (`.dng`, `.lrv`)
- Settings for default ignore extensions; backup panel can override per job

### Changed

- README rewritten with feature tables and project structure
- UI polish (e.g. glass header panel radius)
- Local `ffmpeg.exe` under `src-tauri/resources/ffmpeg/` is gitignored; repo keeps layout README only

## [0.1.1] - 2026-09

### Fixed

- Serve image streams whole; photo zoom / pan viewer

### Changed

- Version bump and related frontend / Tauri fixes

## [0.1.0] - 2026

Initial line: local media library (scan, browse, filter), favorites / tags / ratings, Recycle Bin deletes, camera USB backup (DCIM discover → preview → copy verify), tray / single-instance shell, SQLite index.

<!-- Link refs -->

[Unreleased]: https://github.com/LiuQingDo/Camlib/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/LiuQingDo/Camlib/releases/tag/v0.2.0
[0.1.2]: https://github.com/LiuQingDo/Camlib/releases/tag/v0.1.2
[0.1.1]: https://github.com/LiuQingDo/Camlib/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/LiuQingDo/Camlib/releases/tag/v0.1.0
