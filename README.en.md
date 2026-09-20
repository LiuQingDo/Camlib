# Camlib

**Personal camera media library** — a local desktop app, Windows-first.

Back up photos and videos from your camera card, then browse, filter, and manage them on your machine. Originals stay in a directory you choose; the app is read-only by default and deletes go to the Recycle Bin.

- Backend: Rust (filesystem, SQLite index, thumbnails, camera backup)
- Frontend: Vanilla TypeScript + Vite (UI only; never builds physical paths)
- Desktop shell: Tauri 2

[中文](README.md) | English

## Why Camlib

Camera media usually ends up scattered across DCIM cards and external drives: manual copies to sort them, File Explorer to find them, easy to lose a file forever.

Camlib closes that loop locally:

1. **Backup**: detect removable drive → preview items → copy and verify → retry / cancel on failure
2. **Index**: incremental scan for photos / videos / live photos; SQLite state survives disconnected volumes
3. **Browse & manage**: date navigation, search/filters, favorites / tags / ratings, Recycle Bin deletes

No cloud upload. The app does not replace your media disk. Indexes and thumbnails are rebuildable; damage there never touches originals.

## Features

| Area | Capabilities |
| --- | --- |
| Library | Register a local root; record volume identity; block dangerous writes when offline |
| Scan | Incremental ingest; live-photo pairing; burst markers; relative-path index |
| Browse | Date sidebar, thumbnail grid, full preview, streamed video (Range) |
| Filter | File name, type, date, favorites, tags, ratings, burst |
| Manage | Favorites, tags, ratings; Recycle Bin delete (preview + execute by media item ID) |
| Camera backup | DCIM discovery → conflict/space preview → copy verify → progress / retry; default ignored extensions |
| System | Single instance, tray, close behavior, notifications, settings / about |

Out of scope for now: cloud sync, RAW editing, AI classification, mobile apps, auto-update.

## Camera backup (USB)

### Known devices

| Device | Status | Notes |
| --- | --- | --- |
| Insta360 Ace Pro 2 | Verified | Developer hardware; DCIM is discoverable in USB storage mode |
| Other brands / models | Not systematically tested | In principle recognized if the camera mounts as **USB mass storage** with a `DCIM` folder at the volume root; full reads depend on that model’s export layout |

Camlib does **not** implement brand-specific camera protocols. Backup works on “DCIM trees the PC can read like a flash drive.” Cameras that only expose MTP or a vendor app may not appear — that is a design boundary, not a completed compatibility list.

### Typical flow (Insta360 Ace Pro 2)

1. Power on the camera and connect it over USB
2. On the camera, choose **USB storage / disk mode** (not charge-only or a vendor protocol)
3. A removable drive appears on the PC with a `DCIM` folder
4. Open Camlib → Backup panel → refresh; pick the source drive and target library
5. Preview counts, total size, duplicates/conflicts, and free space on the target
6. Run the copy: temp files + **size verification**, then commit; the source is read-only and never modified or deleted
7. Failed items can be retried; jobs can be cancelled; the index refreshes after backup

### Default ignored extensions

Backup **skips** these by default (change in **Settings → default ignored extensions**, or override once in the backup panel):

| Extension | Common meaning | Default |
| --- | --- | --- |
| `.dng` | RAW / DNG (often paired on action cams such as Ace Pro) | **Skip** |
| `.lrv` | Low-resolution preview video | **Skip** |

- Syntax: comma-separated, e.g. `.dng, .lrv`; case-insensitive; normalized to lowercase `.ext`
- Empty input falls back to the defaults above
- Preview reports ignored counts explicitly
- Types typically imported today: photos `.jpg` `.jpeg` `.png` `.heic` `.heif` and some RAW; videos `.mp4` `.mov` `.avi` `.m4v` `.mts` `.m2ts` `.3gp`

To import `.dng` / `.lrv`, remove those extensions in settings and run backup again.

### Source detection & safety

- Only **removable volumes** with a direct `DCIM` child are backup candidates
- The library records volume identity (not just drive letter); offline volumes reject dangerous writes
- Backup never modifies or deletes files on the camera; conflict policy is chosen before execution

## Getting started

### Requirements

| Dependency | Requirement |
| --- | --- |
| OS | Windows 10 / 11 |
| Node.js | 20+ with [pnpm](https://pnpm.io/) |
| Rust | stable ([rustup](https://rustup.rs/)) |
| ffmpeg (optional) | Video thumbnails; PATH or `CAMLIB_FFMPEG_PATH` |

### Run from source

```powershell
git clone git@github.com:LiuQingDo/Camlib.git
cd Camlib
pnpm install
pnpm tauri dev
```

On first launch, choose your media library root (for example a local backup of DCIM on an external drive).

### Tests & checks

```powershell
pnpm build

cd src-tauri
cargo test
cargo fmt --check
cargo check
```

### Build installers

```powershell
pnpm tauri build
```

Windows NSIS installers default to:

```text
src-tauri\target\release\bundle\nsis\
```

Before shipping, follow [`docs/release-checklist.md`](docs/release-checklist.md) (Chinese).

Published installers: [GitHub Releases](https://github.com/LiuQingDo/Camlib/releases).

## ffmpeg (video thumbnails)

First-frame video thumbnails need ffmpeg. Lookup order:

1. Environment variable `CAMLIB_FFMPEG_PATH`
2. Bundled resources `src-tauri/resources/ffmpeg/ffmpeg[.exe]`
3. Dev machine PATH / common WinGet locations

Before a release build, place the platform binary under `src-tauri/resources/ffmpeg/`:

```text
Windows:  src-tauri/resources/ffmpeg/ffmpeg.exe
macOS:    src-tauri/resources/ffmpeg/ffmpeg
Linux:    src-tauri/resources/ffmpeg/ffmpeg
```

**The Git repo does not ship third-party binaries** (see `README.txt` in that folder). Local `ffmpeg.exe` is gitignored. Release installers may bundle ffmpeg so video thumbnails work out of the box.

Without ffmpeg the app still starts, browses, filters, and backs up; only video thumbnails fail.

## Where data lives

| Content | Default location | If deleted |
| --- | --- | --- |
| SQLite index, settings | `%APPDATA%\com.camera.media-library\` | Index and settings lost; **originals unaffected** |
| Thumbnail cache | `%LOCALAPPDATA%\com.camera.media-library\` (custom SSD path optional) | Rebuildable |
| Original media | Your chosen library root | App is read-only by default; deletes go to the Recycle Bin |

Paths and ffmpeg detection are visible in **Settings → About**.

Uninstalling the app **does not** delete your media library directory.

## Security (summary)

Filesystem work stays in Rust; the frontend only sees DTOs and IDs:

- **CSP**: `default-src 'self'`; scripts `'self'`; `object-src 'none'`; `withGlobalTauri: false`
- **Capabilities**: main window keeps only what it needs (core, folder dialog, open path / reveal item)
- **Paths**: frontend sends `libraryId` / `mediaItemId`; backend resolves and validates, rejecting `..`, absolute paths, UNC, and device-prefix escapes
- **Delete**: precheck then Recycle Bin; partial success allowed; offline volumes reject writes
- **Backup**: read-only source; temp write + size verify then atomic commit; source volume changes fail the job immediately
- **Error contract**: commands return `{ code, message, retryable, details? }` — see `src-tauri/src/errors.rs` and `src/api/errors.ts`

## Project layout

```text
Camlib/
├─ src/                    # Frontend: UI, filters, invoke wrappers
├─ src-tauri/
│  ├─ src/
│  │  ├─ lib.rs            # Tauri commands, app state
│  │  ├─ scanner.rs        # Incremental scan
│  │  ├─ media.rs          # Thumbnails, ffmpeg, stream protocol
│  │  ├─ backup.rs         # Camera backup
│  │  ├─ deletion.rs       # Recycle Bin deletes
│  │  └─ db/               # SQLite migrations & queries
│  └─ resources/ffmpeg/    # Local ffmpeg placement (not in Git)
├─ docs/                   # Requirements, architecture, data model, notes (Chinese)
└─ package.json
```

## Documentation

| Doc | Contents |
| --- | --- |
| [`docs/requirements.md`](docs/requirements.md) | Product requirements & acceptance (Chinese) |
| [`docs/architecture.md`](docs/architecture.md) | Current architecture & module boundaries (Chinese) |
| [`docs/data-model.md`](docs/data-model.md) | SQLite model (migrations win on conflict) (Chinese) |
| [`docs/development-notes.md`](docs/development-notes.md) | Command API, errors, path safety, tests (Chinese) |
| [`docs/release-checklist.md`](docs/release-checklist.md) | Pre-release checklist (Chinese) |
| [`docs/usability-dev-sessions.md`](docs/usability-dev-sessions.md) | Usability session notes (Chinese) |
| [`docs/ux-style-plan.md`](docs/ux-style-plan.md) | UX/style plan draft (Chinese) |

Schema truth source: `src-tauri/src/db/migrations/`. If docs disagree with code, trust the migrations.

## Contributing

Early project (v0.1.x). Issues and PRs welcome:

1. Open an Issue first for large changes
2. Filesystem / delete / backup changes need tests
3. Schema changes require a new migration and an update to `docs/data-model.md`
4. Before commit: `pnpm build`, `cargo test`, `cargo fmt --check`

## License

[MIT](LICENSE) © 2026 LiuQingDo

Third-party components (e.g. FFmpeg) keep their own licenses. The repository does not vendor FFmpeg binaries; release artifacts may bundle ffmpeg for convenience.

## Acknowledgements

- [Tauri](https://tauri.app/) — desktop app framework
- [SQLite](https://sqlite.org/) / [rusqlite](https://github.com/rusqlite/rusqlite) — local index
- [FFmpeg](https://ffmpeg.org/) — video first-frame thumbnails
