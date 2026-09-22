# Camlib 发布检查清单

> 适用于 Windows NSIS 安装包与本地分发。执行 `pnpm tauri build` 前后逐项确认。

## 1. 版本号

- `package.json`、`src-tauri/Cargo.toml`、`src-tauri/tauri.conf.json` 的 `version` 保持一致（当前 `0.1.2`）。
- 策略：`MAJOR.MINOR.PATCH`
  - **PATCH**：修 bug、文案、安全加固，无数据迁移
  - **MINOR**：新功能、索引/设置向后兼容扩展
  - **MAJOR**：破坏性变更（需迁移或重新扫描）
- SQLite 迁移版本见 `CURRENT_SCHEMA_VERSION`（`src-tauri/src/db/mod.rs`，当前为 5）；升级后首次启动自动迁移。表结构说明见 `data-model.md`。

## 2. 安全与权限

- [ ] `tauri.conf.json` 中 `app.security.csp` **非 null**，且与前端资源一致
- [ ] `withGlobalTauri` 为 `false`
- [ ] `capabilities/default.json` 仅保留主窗口必需权限（core:default、dialog:allow-open、opener open-path/reveal、窗口 show/hide/focus/unminimize）
- [ ] 确认前端未使用 `window.__TAURI__` 全局对象
- [ ] `cargo test` 中路径安全用例全部通过（兄弟目录、UNC、绝对路径、`..`）

## 3. ffmpeg sidecar

- [ ] 将 **Windows 版** `ffmpeg.exe` 复制到 `src-tauri/resources/ffmpeg/ffmpeg.exe`
- [ ] 确认 `resources/ffmpeg/README.txt` 仍在（说明布局，且**不提交**第三方二进制到 Git）
- [ ] `.gitignore` 继续忽略 `ffmpeg.exe`（若已配置）；仅本地/构建机放置
- [ ] 在干净机器安装后：设置 → 关于 中 ffmpeg 状态为「可用」
- [ ] 无 ffmpeg 时应用可启动、可浏览、可备份；仅视频缩略图失败并提示

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
pnpm build
cd src-tauri
cargo test
cargo fmt --check
cd ..
pnpm tauri build
```

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
