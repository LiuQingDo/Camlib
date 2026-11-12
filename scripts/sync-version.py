#!/usr/bin/env python3
"""Keep Cargo.toml's package version in step with package.json.

package.json is the single source of truth for the release version:
``src-tauri/tauri.conf.json`` points its ``"version"`` at that file, so the
Tauri bundle picks it up directly. Cargo has no equivalent "read an external
file" mechanism, hence this script.

Behaviour:

* Only the ``version = "..."`` line inside the ``[package]`` table is touched.
  Every other byte of Cargo.toml (comments, formatting, newline style) is
  preserved -- the file is rewritten only when the value actually differs.
* Idempotent: running it twice in a row is a no-op the second time.
* ``--check`` mode writes nothing and exits 1 on drift, for CI use.

Usage:
    python scripts/sync-version.py
    python scripts/sync-version.py --check
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path
from typing import NoReturn

# GitHub Actions 的 Windows runner 控制台默认是 cp1252，而本脚本的状态行是中文：
# 直接 print 会抛 UnicodeEncodeError，把 `--check` 的"版本一致"退出码 1 掉。
# 固定按 UTF-8 输出，errors="replace" 保证日志本身永不成为失败原因。
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(encoding="utf-8", errors="replace")

REPO_ROOT = Path(__file__).resolve().parent.parent
PACKAGE_JSON = REPO_ROOT / "package.json"
CARGO_TOML = REPO_ROOT / "src-tauri" / "Cargo.toml"

# `version = "1.2.3"` with optional surrounding spaces and trailing comment.
VERSION_LINE = re.compile(r'^(?P<lead>\s*version\s*=\s*")(?P<value>[^"]*)(?P<tail>".*)$')
SECTION_HEADER = re.compile(r"^\s*\[(?P<name>[^\]]+)\]\s*$")
SEMVER = re.compile(r"^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?$")


def fail(message: str) -> NoReturn:
    print(f"sync-version: {message}", file=sys.stderr)
    raise SystemExit(1)


def read_package_version() -> str:
    try:
        raw = PACKAGE_JSON.read_text(encoding="utf-8")
    except OSError as error:
        fail(f"无法读取 {PACKAGE_JSON}: {error}")
    try:
        version = json.loads(raw)["version"]
    except (ValueError, KeyError, TypeError) as error:
        fail(f"package.json 中缺少可用的 version: {error}")
    if not isinstance(version, str) or not SEMVER.match(version):
        fail(f'package.json 的 version 不是合法的语义化版本: {version!r}')
    return version


def rewrite_cargo_version(version: str, check_only: bool) -> int:
    # newline="" keeps CRLF/LF exactly as the file already uses.
    try:
        with CARGO_TOML.open("r", encoding="utf-8", newline="") as handle:
            lines = handle.readlines()
    except OSError as error:
        fail(f"无法读取 {CARGO_TOML}: {error}")

    section = ""
    for index, line in enumerate(lines):
        header = SECTION_HEADER.match(line)
        if header:
            section = header.group("name").strip()
            continue
        if section != "package":
            continue
        match = VERSION_LINE.match(line.rstrip("\r\n"))
        if not match:
            continue
        current = match.group("value")
        if current == version:
            print(f"sync-version: Cargo.toml 已是 {version}，无需修改")
            return 0
        if check_only:
            print(
                f"sync-version: Cargo.toml 版本 {current} 与 package.json {version} 不一致",
                file=sys.stderr,
            )
            return 1
        lines[index] = f'{match.group("lead")}{version}{match.group("tail")}'
        newline = "\r\n" if line.endswith("\r\n") else "\n"
        if not lines[index].endswith(newline):
            lines[index] += newline
        try:
            with CARGO_TOML.open("w", encoding="utf-8", newline="") as handle:
                handle.writelines(lines)
        except OSError as error:
            fail(f"无法写入 {CARGO_TOML}: {error}")
        print(f"sync-version: Cargo.toml {current} -> {version}")
        return 0

    fail("在 Cargo.toml 的 [package] 段中找不到 version 字段")


def main(argv: list[str]) -> int:
    check_only = "--check" in argv[1:]
    return rewrite_cargo_version(read_package_version(), check_only)


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
