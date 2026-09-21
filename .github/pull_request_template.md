## Summary

<!-- What does this PR change and why? Link related issues: Fixes #… -->

## Type of change

- [ ] Bug fix
- [ ] New feature
- [ ] Refactor / docs / chore
- [ ] Schema / migration

## Checklist

- [ ] Large change discussed in an Issue first (or this is a small fix)
- [ ] `pnpm build` passes locally
- [ ] `cd src-tauri && cargo test` passes
- [ ] `cd src-tauri && cargo fmt --check` passes
- [ ] Filesystem / delete / backup changes include or update tests
- [ ] Schema changes add a migration under `src-tauri/src/db/migrations/` and update `docs/data-model.md`
- [ ] Command API / error codes / DTO changes also update `docs/development-notes.md` and `src/api/*`
- [ ] No real media library paths in tests (temp dirs only)
- [ ] No ffmpeg binary or user media committed
