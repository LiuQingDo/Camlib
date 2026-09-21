# Contributing to Camlib

Thanks for your interest. Camlib is early (v0.1.x) — Issues and PRs are welcome.

中文说明见 [README.md](README.md) 的「贡献」一节；本文是更完整的贡献指南（英文为主，便于开源协作）。

## Before you start

1. **Large changes: open an Issue first** so we can align on direction.
2. Read the docs under [`docs/`](docs/) — especially [architecture](docs/architecture.md), [data-model](docs/data-model.md), and [development-notes](docs/development-notes.md) (Chinese).
3. Product boundaries today: Windows-first local library + camera DCIM backup. Out of scope: cloud sync, RAW editing, AI classification, mobile, auto-update.

## Development environment

| Dependency | Requirement |
| --- | --- |
| OS | Windows 10 / 11 (primary target) |
| Node.js | 20+ with [pnpm](https://pnpm.io/) |
| Rust | stable via [rustup](https://rustup.rs/) |
| ffmpeg (optional) | Video thumbnails; PATH or `CAMLIB_FFMPEG_PATH` |

```powershell
git clone https://github.com/LiuQingDo/Camlib.git
cd Camlib
pnpm install
pnpm tauri dev
```

On first launch, pick a media library root (a local folder that holds camera backups — **not** the camera card itself for daily browsing).

## Checks before you open a PR

```powershell
pnpm build

cd src-tauri
cargo test
cargo fmt --check
cargo check
```

CI runs the same baseline on `windows-latest` for every push and pull request (see [`.github/workflows/ci.yml`](.github/workflows/ci.yml)).

Optional: place a Windows `ffmpeg.exe` under `src-tauri/resources/ffmpeg/` for local video thumbnails. **Do not commit the binary** — it is gitignored on purpose.

## Hard rules

These are non-negotiable; PRs that break them will be rejected:

1. **No real media libraries in automated tests.** Use `tempfile` dirs only. Never point tests at paths like `H:\DCIM-local`.
2. **Originals are read-only by default.** Deletes must go through the Recycle Bin path.
3. **Backup sources are read-only.** The camera / removable volume must not be modified or deleted.
4. **Frontend does not build physical paths.** Commands take `libraryId` / `mediaItemId`; Rust resolves and validates containment.
5. **No third-party binaries or user media in Git.** ffmpeg stays out of the repository.

## Schema, API, and docs

When you change any of the following, update the matching docs in the same PR:

| Change | Also update |
| --- | --- |
| SQLite schema | New file under `src-tauri/src/db/migrations/`, plus `docs/data-model.md` |
| Tauri command / DTO / error codes | `docs/development-notes.md`, `src/api/*` (TS mirrors) |
| User-visible behavior or release process | `docs/requirements.md` and/or `docs/release-checklist.md` as appropriate |

Schema truth source is the migrations folder. If docs disagree with code, fix the docs to match the migrations.

## Filesystem / delete / backup PRs

Any change that can touch files on disk needs tests covering at least:

- Path containment (`..`, absolute paths, UNC, sibling-directory prefix tricks)
- Offline / volume-changed rejection for dangerous writes
- Backup conflict, space, cancel, and verify-failure paths when applicable

## Commit & PR style

- Prefer clear, scoped commits; English or Chinese is fine.
- PR description: what changed, why, and how you verified (`pnpm build`, `cargo test`, …).
- Use the PR template checklist.
- Link related Issues (`Fixes #123`).

## Releases

Maintainers follow [`docs/release-checklist.md`](docs/release-checklist.md). Version numbers stay consistent across `package.json`, `src-tauri/Cargo.toml`, and `src-tauri/tauri.conf.json`. User-facing version history lives in [CHANGELOG.md](CHANGELOG.md).

## Code of conduct

Be respectful and constructive. Harassment or bad-faith contributions will not be accepted. (A formal `CODE_OF_CONDUCT.md` may be added if the community grows.)

## Security

Please report vulnerabilities privately — see [SECURITY.md](SECURITY.md).
