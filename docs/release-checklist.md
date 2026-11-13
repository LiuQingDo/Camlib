# Camlib 发布检查清单

> 适用于 Windows NSIS 安装包与本地分发。执行 `pnpm tauri build` 前后逐项确认。

## 1. 版本号

- `package.json` 是**唯一**版本来源（当前 `0.5.0`）。`src-tauri/tauri.conf.json` 的 `version` 已指向 `../package.json`，不需要手改。
- 改完 `package.json` 后运行 `python scripts/sync-version.py` 同步 `src-tauri/Cargo.toml`（幂等，只改 `[package]` 里那一行）；`--check` 只校验不写，CI 用。
- 策略：`MAJOR.MINOR.PATCH`
  - **PATCH**：修 bug、文案、安全加固，无数据迁移
  - **MINOR**：新功能、索引/设置向后兼容扩展
  - **MAJOR**：破坏性变更（需迁移或重新扫描）
- SQLite 迁移版本见 `CURRENT_SCHEMA_VERSION`（`src-tauri/src/db/mod.rs`，当前为 6）；升级后首次启动自动迁移。表结构说明见 `data-model.md`。

## 2. 安全与权限

- [ ] `tauri.conf.json` 中 `app.security.csp` **非 null**，且与前端资源一致
- [ ] `withGlobalTauri` 为 `false`
- [ ] `capabilities/default.json` 仅保留主窗口必需权限（core:default、dialog:allow-open、opener open-path/reveal、窗口 show/hide/focus/unminimize）
- [ ] 确认前端未使用 `window.__TAURI__` 全局对象
- [ ] `cargo test` 中路径安全用例全部通过（兄弟目录、UNC、绝对路径、`..`）

## 3. ffmpeg sidecar

CI（`release.yml`）会自动补齐，本地构建才需要手动放：

- [ ] **CI 发布**：无需人工介入。`Fetch ffmpeg sidecar` 步骤按钉死的 URL 下载固定版本（BtbN `autobuild-2026-11-12-15-40` / n9.0.2 win64-gpl 静态构建），先用 `FFMPEG_SHA256` 校验再解压到 `src-tauri/resources/ffmpeg/ffmpeg.exe`；校验和不符直接失败。升级 ffmpeg 时同时更新 URL 与哈希两个常量
- [ ] **本地构建**：将 **Windows 版** `ffmpeg.exe` 复制到 `src-tauri/resources/ffmpeg/ffmpeg.exe`
- [ ] 确认 `resources/ffmpeg/README.txt` 仍在（说明布局，且**不提交**第三方二进制到 Git）
- [ ] `.gitignore` 继续忽略 `ffmpeg.exe`；仅本地/构建机放置，CI 靠下载步骤补
- [ ] `Verify installer bundles ffmpeg` 步骤通过（安装包 < 20 MB 视为 sidecar 丢失，构建即失败）
- [ ] 在干净机器安装后：设置 → 关于 中 ffmpeg 状态为「可用」
- [ ] 无 ffmpeg 时应用可启动、可浏览、可备份；仅视频缩略图失败并提示（0.6.0 起启动后在顶部给一行安装引导）

打包后资源路径通常为：

```text
<install-dir>\resources\ffmpeg\ffmpeg.exe
```

查找顺序运行时为：`CAMLIB_FFMPEG_PATH` → 打包资源 → PATH。

## 4. 图标与产品信息

- [ ] `productName` 为 `Camlib`，`identifier` 为 `com.camera.media-library`
- [ ] `bundle.icon` 列表包含 ico/png/icns；Windows 安装后任务栏与托盘图标正确
- [ ] 窗口标题为「Camlib」

## 5. 安装 / 卸载语义

- [ ] 安装到默认 Program Files 或用户目录均可；无需要求管理员权限的路径假设
- [ ] **卸载不得删除用户媒体库目录**（`H:\DCIM-local` 等）
- [ ] 卸载默认可保留应用数据目录（SQLite + settings）；如清空需在安装器/文档中明确提示
- [ ] 重装同一 identifier 不损坏已有索引
- [ ] 单实例：双开第二次激活原窗口

## 6. 索引与数据位置（写入用户文档/关于页）

| 数据 | 默认位置 |
| --- | --- |
| SQLite `camlib.sqlite3` | `%APPDATA%\com.camera.media-library\` |
| `settings.json` | 同上 |
| 缩略图缓存 | `%LOCALAPPDATA%\com.camera.media-library\`（或设置中的自定义 SSD 路径） |
| 原始媒体 | 用户选择的媒体库根，不在安装目录 |

- [ ] 关于页路径可打开资源管理器
- [ ] 删除缩略图缓存后可重建，不触碰媒体库

## 7. 构建与冒烟

```powershell
python scripts/sync-version.py --check
pnpm build
pnpm lint
pnpm test
cd src-tauri
cargo test
cargo fmt --check
cargo clippy --all-targets
cd ..
pnpm tauri build
```

`cargo clippy` 目前有存量告警（CI 里用 `continue-on-error` 只报告，见 `ci.yml`）；清完后 CI 改回 `-- -D warnings` 卡口。

也可以只推 tag 让 CI 代劳：`git tag v0.5.0 && git push origin v0.5.0` 会触发 `release.yml`，在 `windows-latest` 上构建 NSIS 并自动挂到 GitHub Release（tag 与 `package.json` 版本不一致会直接失败）。

安装包产物目录（NSIS）：

```text
src-tauri\target\release\bundle\nsis\
```

安装后冒烟：

- [ ] 首次启动无崩溃；未配置库时引导清晰
- [ ] 选择临时媒体库目录 → 扫描 → 网格出现缩略图
- [ ] 收藏 / 标签 / 评分可写
- [ ] 删除走预览确认并进回收站
- [ ] 备份临时 DCIM 源 → 预览 → 完成或可控失败
- [ ] 断开库目录后危险操作禁用且文案可读
- [ ] 通知与托盘不影响主窗口启动

## 8. 分发注意

- 仓库**不包含** ffmpeg 二进制与用户媒体；构建机需单独放置 sidecar。
- 若分发 zip/便携版，说明数据目录仍写在用户 AppData。
- 自动更新与崩溃上报未实现（后续可选）。
- 发布后同步更新 [`CHANGELOG.md`](../CHANGELOG.md)（把 `Unreleased` 内容落到新版本小节）。

## 9. 开源仓库卫生（可选但推荐）

- [ ] GitHub 描述与 Topics 仍符合当前产品定位
- [ ] CI 在该 tag / 分支上为绿
- [ ] Release notes 与 CHANGELOG 一致
- [ ] 安装包已挂到 GitHub Release，并标明 Windows x64
