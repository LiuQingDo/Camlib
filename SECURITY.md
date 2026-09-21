# Security Policy

Camlib touches local filesystems: media libraries, camera backup sources, and Recycle Bin deletes. We take path safety and data-loss issues seriously.

## Supported versions

| Version | Supported |
| --- | --- |
| Latest GitHub Release (currently v0.1.x) | Yes |
| Older releases | Best effort only — please upgrade first |

## Reporting a vulnerability

**Please do not open a public GitHub Issue for security vulnerabilities.**

Preferred channel:

1. Open a private report via [GitHub Security Advisories](https://github.com/LiuQingDo/Camlib/security/advisories/new)
2. Include: affected version, OS, impact (e.g. write outside library root, silent data loss), and minimal reproduction steps
3. Avoid attaching personal photos/videos or full paths that identify real users

You should receive an acknowledgement when the maintainer is available. Once fixed, we will credit the report in the release notes if you want attribution.

## What counts as a security issue

- Path traversal or escapes outside the registered library root (`..`, UNC, absolute paths, sibling-directory tricks, volume identity bypass)
- Deletes that bypass Recycle Bin / preflight, or that touch files outside the library
- Backup that modifies or deletes camera (source) media
- Capability / CSP regressions that expose filesystem commands to untrusted content
- Index or settings corruption that leads to destructive actions on the wrong volume

## Non-security issues

Use regular Issues for crashes, UI bugs, missing features, and device compatibility reports. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Hard safety rules (for contributors)

- Automated tests must never write to a real media library — use temp directories only
- Originals stay read-only by default; deletes go to the Windows Recycle Bin
- Backup sources are read-only; never delete or rewrite camera files
- Frontend never constructs physical paths; the Rust backend validates library / media IDs
