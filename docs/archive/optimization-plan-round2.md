# Camlib 优化计划 · 第二轮

> 承接 `docs/optimization-plan.md`（第一轮 8 个会话已全部执行完毕）
> 基线：v0.5.0 + 第一轮 14 个提交（本地 `ahead 14`，未推送）
> 实测基线：前端 63 测试全绿 / 后端 116 passed / `pnpm build` 通过 / `pnpm lint` 0 error 5 warning / `cargo clippy` **失败（59 个 error）**

---

## 0. 本轮要解决什么

第一轮遗留 5 项，归并成 4 个会话。核心判断是**把"清理"和"发版"隔开**：先清干净，发版锁定成果，再动大手术。

| 上一轮遗留                                             | 归入   | 为什么这么安排                               |
| ------------------------------------------------------ | ------ | -------------------------------------------- |
| clippy 59 个 error 未清                                | **T1** | 纯清理，风险最低，且卡着 CI 硬卡口           |
| 3 处 `no-unsafe-finally` + 2 处小 warning              | **T3** | 同属前端小清理，与 T1 并行做完再发版         |
| 版本仍 0.5.0、CHANGELOG 没记全、README/data-model 滞后 | **T2** | 必须在 T1/T3 之后，否则 0.6.0 带着红 CI 出去 |
| `main.ts` 8441 行、渲染层该独立                        | **T4** | 风险最高，不该卡发版，放到最后               |

**顺序：T1 → T3 → T2 → T4**

T2 是发版闸口。发完 0.6.0 再动 T4，出问题随时能回到一个干净的 tag。

---

## 1. 约束与红线

沿用第一轮，并新增一条：

1. 不改错误契约 `{ code, message, retryable, details? }`（`errors.rs` / `src/api/errors.ts`）。
2. 不改 Command 名与前端 invoke 的参数结构。
3. 不放宽 CSP、`capabilities/default.json`、路径校验；删除只进回收站。
4. Schema 变更必须新增迁移文件，并同步 `docs/data-model.md`——**包括文件头部的版本号**（上一轮就漏了这一处）。
5. 每个会话结束必须全绿：`pnpm build`、`pnpm test`、`cargo test`、`cargo fmt --check`，Rust 改动另加 `cargo clippy --all-targets -- -D warnings`。
6. 一个会话一个 commit，conventional 前缀。
7. **（新增）不允许用 `#[allow(...)]` 或 `@ts-ignore` 掩盖真实问题**——唯一的例外是 T1 里对既有命令函数签名的 `too_many_arguments` 豁免，且必须写明理由。

---

## 2. 会话总览

| 会话   | 名称                         | 依赖       | 体量           | 风险 | 产出                                               |
| ------ | ---------------------------- | ---------- | -------------- | ---- | -------------------------------------------------- |
| **T1** | clippy 清债 + CI 硬卡口      | 无         | 小（半天）     | 低   | 0 error 0 warning，删掉 `continue-on-error`        |
| **T3** | ESLint warning 清零          | 无         | 很小（1 小时） | 低   | `pnpm lint` 0 warning                              |
| **T2** | 发布 v0.6.0                  | T1、T3     | 小（半天）     | 低   | 版本收敛、CHANGELOG/README/data-model 同步、打 tag |
| **T4** | 前端渲染层拆分 `src/render/` | T2（建议） | 大（1–2 天）   | 高   | `main.ts` 8441 → < 4000 行                         |

```
T1 ──┐
     ├──► T2（发版 v0.6.0）──► T4
T3 ──┘
```

---

## 3. 会话详情

### T1｜clippy 清债 + CI 变硬卡口

**目标**：`cargo clippy --all-targets -- -D warnings` 真正通过，然后删掉 CI 里的 `continue-on-error`。

**为什么排第一**：现在 CI 里 `continue-on-error: true` 兜着，等于这道门禁形同虚设；而 clippy 抓的恰恰是"能跑但会咬人"的写法。

**现状（实测 59 个 error）**

| 类别                    | 数量 | 典型场景                                                                                                                  |
| ----------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------- |
| `useless_vec`           | 18   | 测试里 `&vec![...]` 传给切片参数                                                                                          |
| `too_many_arguments`    | 14   | 7 个 8/7、5 个 9/7、2 个 10/7、1 个 11/7                                                                                  |
| `needless_borrow`       | 6    | `&app_error` 立即被解引用                                                                                                 |
| `manual_is_multiple_of` | 3    | `x % 2 == 0`                                                                                                              |
| `useless_conversion`    | 2    | `AppError` 转成同类型                                                                                                     |
| `map_or` 可简化         | 2    |                                                                                                                           |
| 零散                    | 14   | `type_complexity`、`chunks_exact`、`assert_eq!` 布尔字面量、`needless_return`、`derivable_impls`、`redundant_field_names` |

文件分布：`library_merge.rs` 15、`backup.rs` 15、`scanner.rs` 5、`commands/editing.rs` 4、`infrastructure.rs` 3、`editing.rs` 3、`commands/ai.rs` 3，其余 1–2 个。**大头都在没被拆分的存量文件里，不是上一轮改坏的**。

**处理策略**

1. 先跑 `cargo clippy --fix --all-targets --allow-dirty --allow-staged`，让它自动修 `useless_vec` / `needless_borrow` / `manual_is_multiple_of` 这类机械问题，然后 `cargo fmt`。
2. 自动修完再重跑，看剩下什么，逐类处理。
3. `too_many_arguments`：**用 `#[allow(clippy::too_many_arguments)]` + 一行注释说明**，不要为过 lint 硬拆参数——这些是备份/合并流程的既有签名，拆成结构体反而增加认知成本。若某个函数确实该抽参数对象，再抽一个即可，不要批量改。
4. `useless_vec`：若被调函数签名就是 `&[T]`，测试里改成 `&[...]`；若签名要 `&Vec<T>`，**改签名**而不是加 allow。
5. 全部清零后删掉 `ci.yml` 里 clippy 步骤的 `continue-on-error: true` 与那段注释。

**验收**

- [ ] `cargo clippy --all-targets -- -D warnings` → 0 error 0 warning
- [ ] `cargo test` 仍 116 passed（数量不许减少）
- [ ] `cargo fmt --check` 通过
- [ ] `ci.yml` 里 clippy 已是硬卡口
- [ ] 列出每个 `#[allow]` 的位置与理由

**提示词**

```text
项目：Camlib，Tauri 2 + Rust 后端的本地相机媒体库。上一轮刚做完模块拆分（lib.rs 2025→165 行，db/mod.rs 3974→437 行，拆出 db/queries/ 与 commands/）。

## 现状
cargo test 116 passed、cargo fmt --check 通过，但：
cargo clippy --all-targets -- -D warnings 失败：36 个 error（lib）+ 55 个 error（lib test）。
.github/workflows/ci.yml 里 clippy 步骤目前是 continue-on-error: true，所以 CI 不会报红——这道门禁等于没有。

错误分布：
- useless_vec 18（多在测试里传 &vec![...] 给切片参数）
- too_many_arguments 14（7 个 8/7、5 个 9/7、2 个 10/7、1 个 11/7）
- needless_borrow 6
- manual_is_multiple_of 3
- useless_conversion 2（AppError 转同类型）
- map_or 可简化 2
- 其余零散 14：type_complexity、chunks_exact、assert_eq 布尔字面量、needless_return、derivable_impls、redundant_field_names
文件分布：library_merge.rs 15、backup.rs 15、scanner.rs 5、commands/editing.rs 4、infrastructure.rs 3、editing.rs 3、commands/ai.rs 3，其余 1–2。

## 任务
1. 先跑 cargo clippy --fix --all-targets --allow-dirty --allow-staged，让它自动修机械问题，然后 cargo fmt。
2. 重跑 clippy，逐类处理剩余项。
3. too_many_arguments：用 #[allow(clippy::too_many_arguments)] 显式豁免，并在上方加一行注释说明为什么保留（这些是备份/合并流程的既有签名，硬拆参数对象会伤可读性）。不要批量改成参数结构体。
4. useless_vec：优先改测试写法（&vec![..] → &[..]）；如果被调函数签名要求 &Vec<T>，改签名而不是加 allow。
5. 清零后删掉 ci.yml 里 clippy 的 continue-on-error: true 和上面那段"先跑通不卡口"的注释。

## 约束
- 不改任何运行行为，不改错误契约，不改 public API 语义。
- 不允许用 #[allow(...)] 掩盖真实问题；唯一例外是上面说的 too_many_arguments，且必须写理由。
- 不重命名模块、不调整文件结构（那是上一轮已经做完的事）。
- 每改完一批就 cargo test，别最后一次性验证。

## 验收
- cargo clippy --all-targets -- -D warnings → 0 error 0 warning
- cargo test → 116 passed，数量不许减少
- cargo fmt --check 通过
- ci.yml 中 clippy 已无 continue-on-error
- 输出：每个 #[allow] 的位置 + 理由清单，以及各类错误的修复方式说明

建议 commit：chore(rust): 清理 clippy 存量告警并启用硬卡口
```

---

### T3｜ESLint warning 清零

**目标**：`pnpm lint` 从 0 error 5 warning 变成 0 warning。

**为什么单独开一个会话**：改动都在 `main.ts`，但和 T1 是不同语言；混在一个 commit 里回滚粒度会变粗。

**现状（5 个 warning）**

| 位置                         | 规则                    | 实际情况                                                         |
| ---------------------------- | ----------------------- | ---------------------------------------------------------------- |
| `main.ts` 1698 / 1770 / 1816 | `no-unsafe-finally`     | 批量收藏 / 批量标签 / 批量评分三个函数在 `finally` 块里 `return` |
| `main.ts` 6607               | `no-useless-assignment` | `next` 赋值后未被使用                                            |
| `main.ts` 6846               | `prefer-const`          | `outMs` 从未重新赋值                                             |

**关键判断**：`no-unsafe-finally` 那三处**目前不是 bug**（函数返回 void，`finally` 里的 `return` 不会覆盖返回值），但 `finally` 中的 `return` 会**吞掉 `finally` 自身抛出的异常**，是 ESLint 明令禁止的模式。改法是把"提前退出"变成"置标志位 → 在 `finally` 外分支"，保持三条路径的行为完全一致。

**验收**

- [ ] `pnpm lint` → 0 problem
- [ ] `pnpm test` 63 全绿
- [ ] `pnpm build` 通过
- [ ] 批量收藏 / 标签 / 评分三条路径的手动行为与改前一致（成功、失败、筛选态自动移除三种场景）

**提示词**

```text
项目：Camlib，Tauri 2 + 原生 TypeScript 前端。pnpm lint 目前 0 error / 5 warning，要清零。

## 五个 warning 的位置
src/main.ts:1698、1770、1816 —— no-unsafe-finally。这是批量收藏、批量标签、批量评分三个函数，都在 finally 块里写了 `return`：
  finally {
    state.xxxBusy = false;
    if (<错误或筛选态已变>) { patchGrid(); patchToolbar(); return; }
    applySelectionChrome();
    showTransientNotice(...);
  }
函数返回 void，所以现在不是 bug，但 finally 里的 return 会吞掉 finally 自身抛出的异常，是 ESLint 禁止的模式。
src/main.ts:6607 —— no-useless-assignment，变量 next 赋值后未被使用。
src/main.ts:6846 —— prefer-const，outMs 从未重新赋值。

## 任务
1. 三处 no-unsafe-finally 改为「置标志位 → finally 外统一分支」：
   例如在 finally 里只做状态复位与标志计算，把 patchGrid/patchToolbar 的提前退出移到 finally 之后的 if 分支。
   必须保证三条路径（成功、失败、筛选态导致该项被移除）的行为与改前完全一致。
2. 修掉 no-useless-assignment 与 prefer-const 两处。
3. 不要用 eslint-disable 注释绕过。

## 约束
- 不改变任何用户可观察的行为（通知文案、网格刷新时机、选中态处理都要一致）。
- 不改 API 层、不改渲染结构。
- 不动 T1 范围内的 Rust 代码。

## 验收
- pnpm lint → 0 problem
- pnpm test → 63 passed
- pnpm build 通过
- 手动回归：批量收藏/标签/评分，分别在「正常成功」「接口报错」「当前处于对应筛选态导致条目被移除」三种场景下确认行为一致

建议 commit：fix(frontend): 消除 finally 内 return 等 5 处 lint 告警
```

---

### T2｜发布 v0.6.0

**目标**：把第一轮的成果落成一个干净的版本，并把三处文档滞后补齐。

**为什么必须在 T1/T3 之后**：0.6.0 是这一轮的对外交付，不能带着红 CI 和一堆告警出去。

**待办清单**

| 项                   | 现状                                     | 动作                                       |
| -------------------- | ---------------------------------------- | ------------------------------------------ |
| `package.json`       | `0.5.0`                                  | → `0.6.0`                                  |
| `Cargo.toml`         | `0.5.0`                                  | 跑 `scripts/sync-version.py` 同步          |
| `tauri.conf.json`    | 已指向 `../package.json`                 | 验证能正确读到 0.6.0                       |
| `CHANGELOG.md`       | `[Unreleased]` 只有深度校验一条          | 提升为 `[0.6.0]`，补全 5 项                |
| `docs/data-model.md` | 第 4 行仍写 `CURRENT_SCHEMA_VERSION = 7` | 改为 8（表格与字段已经补了，只有头部漏了） |
| `README.md`          | 第 58 行仍写"文件大小校验"               | 补一句深度校验可选                         |
| `README.en.md`       | 同上                                     | 同步                                       |
| tag                  | 无                                       | `v0.6.0`，推送触发 `release.yml`           |

**CHANGELOG 要补的 5 条**（第一轮成果）

1. 媒体网格改用固定行高虚拟滚动（5000 张库 DOM 节点封顶）
2. 卡片区与工具栏改用事件委托
3. `render()` 改为骨架 + 分区增量更新（缩略图不再随状态变化重建）
4. 启动时探测 ffmpeg，缺失给一行安装引导
5. 后端模块拆分：`db/queries/` 与 `commands/` 按实体组织；AI 网络命令移出命令线程并补齐 connect/read/total 三段超时

**验收**

- [ ] `package.json` / `Cargo.toml` / 构建产物三处版本一致为 0.6.0
- [ ] `CHANGELOG.md` 有 `## [0.6.0] - 2026-11-12` 段，含上述 5 条 + 已有的深度校验
- [ ] `docs/data-model.md` 头部版本号 8
- [ ] README 中英双版都提到深度校验
- [ ] `pnpm build` / `cargo test` / `cargo clippy` 全绿后再打 tag
- [ ] tag 推送后 `release.yml` 跑出 NSIS 安装包

**提示词**

```text
项目：Camlib，Tauri 2 桌面应用。发布 0.6.0，把第一轮优化的成果落成一个干净版本。发布前必须全绿：pnpm build、pnpm test、cargo test、cargo clippy --all-targets -- -D warnings、cargo fmt --check。任一不绿就停下来报告，不要带病发版。

## 任务
1. 版本号
   - package.json 0.5.0 → 0.6.0
   - 运行 scripts/sync-version.py 把 src-tauri/Cargo.toml 的 version 同步过去（该脚本已存在，先读一遍确认它的行为，幂等、只改那一行）
   - tauri.conf.json 的 version 已指向 "../package.json"，验证构建时能读到 0.6.0（可用 cargo tauri info 或看 pnpm tauri build 的产物名）
2. CHANGELOG.md
   把 [Unreleased] 提升为 ## [0.6.0] - 2026-11-12，保留已有的备份深度校验条目，并按仓库既有风格补全这几项：
   - 媒体网格改用固定行高虚拟滚动，长列表 DOM 节点封顶
   - 卡片区与粘性工具栏改用事件委托，监听器不再随渲染重建
   - render() 改为骨架 + 分区增量更新，缩略图不再随状态切换重建
   - 启动时探测 ffmpeg，缺失时给出安装引导
   - 后端按实体拆分 db/queries/ 与 commands/；AI 网络命令移出命令线程，补齐 connect / read / total 三段超时
   然后新建空的 [Unreleased] 段。
3. 文档同步（这两处是真的漏了，不要跳过）
   - docs/data-model.md 第 4 行写的是 CURRENT_SCHEMA_VERSION = 7，实际 src-tauri/src/db/mod.rs 里是 8；改过来。表格里 0008 的行和 backup_runs.deep_verify 字段已经补过了，只需改头部。
   - README.md 第 58 行左右仍写「临时文件写入 + 文件大小校验 后提交」，补充深度校验为可选项（默认关闭、SHA-256、能发现大小不变但内容损坏）。README.en.md 同步对应段落。
4. 打 tag v0.6.0 并推送（推送会触发 .github/workflows/release.yml 构建 NSIS 安装包）。如果当前有未推送的提交，先推 master 再打 tag。

## 约束
- 不夹带任何代码改动（除了版本号与文档）。如果发现必须改代码才能全绿，停下来报告。
- 不改 CHANGELOG 的历史段落。
- 中英 README 表述要对齐，不要只改中文。

## 验收
- 三处版本一致
- CHANGELOG 结构与既有条目风格一致
- docs/data-model.md 版本号与代码一致
- 给出最终 tag 名与 release workflow 的触发状态

建议 commit：chore(release): bump version to 0.6.0
```

---

### T4｜前端渲染层拆分 `src/render/`

**目标**：`main.ts` 从 8441 行降到 **4000 行以内**，渲染相关代码迁到 `src/render/` 与 `src/views/`。

**为什么最后做**：这是纯结构调整 + 高风险，必须在一个干净的 tag（0.6.0）之后进行，出问题能整体回退。

**当前结构（`main.ts` 里的既有分区注释）**

| 行号 | 分区                                                                               | 大致体量     |
| ---- | ---------------------------------------------------------------------------------- | ------------ |
| 3695 | 分区增量渲染（S3b：`renderShell` / `patchSidebar` / `patchToolbar` / `patchGrid`） | ~390 行      |
| 4084 | 固定行高虚拟滚动                                                                   | ~445 行      |
| 4529 | 分区事件绑定                                                                       | ~1600 行     |
| 6150 | 媒体编辑器（裁剪/旋转/视频剪辑）                                                   | **~1860 行** |
| 8013 | 事件委托（S3a）                                                                    | ~430 行      |

全文 336 个顶层函数，`state` 单例在第 370 行，`app` 元素是全局引用。

**目标目录**

```
src/
├─ state.ts              # AppState 接口 + state 单例
├─ render/
│  ├─ context.ts         # app 引用、region()、setText()、setRegionHtml()、bind()
│  ├─ shell.ts           # renderShell + patchSidebar
│  ├─ toolbar.ts         # patchToolbar + 筛选区
│  ├─ grid.ts            # patchGrid + renderCard
│  ├─ virtual.ts         # 已存在的 lib/virtual.ts 的 DOM 侧封装
│  └─ events.ts          # 事件委托
├─ views/
│  ├─ editor.ts          # 媒体编辑器（最大一块，单独迁）
│  ├─ settings.ts
│  └─ dialogs.ts         # 合并 / 标签管理 / 确认框
└─ main.ts               # 启动装配、数据流转、状态变更入口
```

**关键难点：循环依赖**

这些函数大量共享 `state`、`app`、`region()`、`escapeHtml`、`renderCard`。**必然会出现 A 依赖 B、B 又依赖 A**。解决顺序：

1. **先建共享层**（`state.ts` + `render/context.ts`），把被最多地方引用的东西先抽出来——它们是依赖树的叶子。
2. **再搬无依赖的叶子模块**（`virtual.ts` 的 DOM 封装、`renderCard`）。
3. **最后搬上层**（editor → dialogs → settings → shell/toolbar/grid）。
4. 如果仍出现循环，用**回调注入**打破（父模块把 handler 作为参数传下去），不要用 `any`、`@ts-ignore` 或把东西塞回全局。

**验收**

- [x] `main.ts` < 4000 行（实际 **84 行**）；每个新文件 ≤ 800 行（最大 624 行）
- [x] `pnpm test` 63 全绿，`pnpm build` 通过，`pnpm lint` 0 problem
- [x] 全项目 `any` 仍为 0（仅注释里的英文单词 any 命中 5 处）
- [x] 无新增 `eslint-disable` / `@ts-ignore`
- [ ] 手动回归：浏览/筛选/预览/编辑器/设置/备份面板/AI 抽屉七条主路径
- [x] 给出拆分前后行数对照表（见本节末尾「执行结果」）

**提示词**

```text
项目：Camlib，Tauri 2 + 原生 TypeScript 前端。src/main.ts 有 8441 行、336 个顶层函数，虽然上一轮已经做了增量渲染和虚拟滚动，但所有实现仍然堆在同一个文件里。本会话只做拆分，不改任何行为。

## 当前文件里的分区（源码里有现成的分区注释，按它们切）
- 约 185 行：AppState 接口；约 370 行：state 单例
- 约 3695 行：分区增量渲染（renderShell / patchSidebar / patchToolbar / patchGrid）
- 约 4084 行：固定行高虚拟滚动（含 grid 几何探测、行盒规划、spacer）
- 约 4529 行：分区事件绑定（~1600 行）
- 约 6150 行：媒体编辑器（照片裁剪/旋转/调色 + 视频剪辑，~1860 行，最大的一块）
- 约 8013 行：事件委托（卡片区 + 粘性工具栏）
全局共享的东西：state 单例、app 元素引用、region()、setText()、setRegionHtml()、bind()、escapeHtml()、renderCard()。

## 目标结构
src/state.ts                AppState 接口 + state 单例
src/render/context.ts       app 引用、region()、setText()、setRegionHtml()、bind()
src/render/shell.ts         renderShell + patchSidebar
src/render/toolbar.ts       patchToolbar + 筛选区
src/render/grid.ts          patchGrid + renderCard
src/render/virtual.ts       虚拟滚动的 DOM 侧封装（lib/virtual.ts 里已有纯几何计算，不要动它）
src/render/events.ts        事件委托
src/views/editor.ts         媒体编辑器（单独一块，优先迁，收益最大）
src/views/settings.ts
src/views/dialogs.ts        合并 / 标签管理 / 删除确认
main.ts                     只留启动装配、数据流转、状态变更入口

## 拆分顺序（必须按这个顺序，不要打乱）
1. 先建共享层：state.ts + render/context.ts。它们是被最多模块引用的叶子，先抽出来能大幅减少后续的循环依赖。
2. 再搬无依赖的叶子：renderCard、virtual 的 DOM 封装。
3. 然后搬 views/editor.ts（1860 行，一次搬完，因为它相对独立）。
4. 接着 views/settings.ts、views/dialogs.ts。
5. 最后搬 render/*。

## 每搬一块必须做的三件事
- pnpm build 通过（tsc 会抓出漏掉的 import 和类型不匹配）
- pnpm test 全绿（63 个）
- 手动打开一次受影响的界面确认没有白屏

## 处理循环依赖的原则
必然会出现 A 依赖 B、B 又依赖 A 的情况。正确做法：
- 把共享的东西下沉到 context.ts / state.ts；
- 用参数注入回调（父模块把 handler 传给子模块），而不是让子模块反向 import 父模块；
- 绝对不允许用 any、@ts-ignore、eslint-disable 或把变量挂回 window 来绕过。

## 约束
- 纯搬移：不改函数逻辑、不改 DOM 结构、不改 CSS 类名、不改事件行为。
- 不引入任何框架或运行时依赖。
- 不动 src/lib/ 下已有的纯函数模块（format/filters/selection/grid/virtual 的纯计算部分）。
- 不动后端。
- 允许把一个函数拆成"导出同名 + 内部辅助"，但不允许合并或重写逻辑。

## 验收
- main.ts < 4000 行；每个新建文件 ≤ 800 行
- pnpm test 63 全绿、pnpm build 通过、pnpm lint 0 problem
- 全项目 grep "any" 命中 0（排除注释与字符串）
- 无新增 eslint-disable / @ts-ignore
- 手动回归七条主路径：浏览、筛选、预览大图、图片编辑器、视频剪辑、设置页、备份面板
- 输出拆分前后行数对照表（文件 → 行数）

建议 commit：refactor(frontend): 渲染层拆分到 src/render 与 src/views
```

---

### 执行结果（2026-11-13，`ea8a0f9`）

**总量**：`main.ts` 8443 行 → **84 行**；拆出 36 个新文件，合计 9664 行（净增 1221 行，全部是 36 份 import 头、`export` 修饰符与 Prettier 排版展开）。顶层函数 336 → 465（新增的是门面转发与循环依赖拆出来的小助手）。

**文件 → 行数**

| 目录         | 文件                                                                                       |                                         行数 |
| ------------ | ------------------------------------------------------------------------------------------ | -------------------------------------------: |
| 入口         | `main.ts`                                                                                  |                                           84 |
| 状态         | `state.ts`                                                                                 |                                          407 |
| render       | `context.ts` / `paint.ts` / `shell.ts` / `text.ts`                                         |                         75 / 132 / 106 / 114 |
| render       | `grid.ts` / `virtual.ts` / `events.ts` / `toolbar.ts`                                      |                    312 / 413 / 209 / **589** |
| views        | `preview.ts` / `preview/meta.ts` / `preview/state.ts`                                      |                           **624** / 107 / 10 |
| views        | `editor.ts` / `editor/shared.ts` / `editor/photo.ts` / `editor/video.ts`                   |                        108 / 138 / 335 / 344 |
| views        | `settings.ts` / `dialogs.ts` / `ai-chat.ts` / `backup.ts`                                  |                        586 / 497 / 287 / 234 |
| app          | `library.ts` / `settings-ops.ts` / `media-ops.ts` / `media-query.ts`                       |                        546 / 548 / 333 / 215 |
| app          | `dialogs-ops.ts` / `orchestrate.ts` / `ui.ts`                                              |                               220 / 120 / 38 |
| app/bindings | `global` / `settings` / `shell` / `preview` / `toolbar` / `dialogs` / `editor` / `overlay` | 416 / 285 / 224 / 220 / 217 / 200 / 163 / 97 |
| media        | `cache.ts`                                                                                 |                                          111 |

**原分区 → 现落点**

| 原行号区间 | 原分区                                                                      | 落点                                                                  |
| ---------- | --------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| 185–369    | `AppState` 接口                                                             | `state.ts`                                                            |
| 370–800    | `state` 单例与派生配置                                                      | `state.ts`                                                            |
| 800–1880   | 格式化、缩略图缓存、筛选计算                                                | `render/text.ts`、`media/cache.ts`、`app/media-query.ts`、`app/ui.ts` |
| 1881–3695  | 卡片渲染 + 骨架 + 固定区（`renderShell` / `patchSidebar` / `patchToolbar`） | `render/grid.ts`、`render/shell.ts`、`render/toolbar.ts`              |
| 3696–4084  | 卡片增量渲染 `patchGrid` / `renderCard`                                     | `render/grid.ts`                                                      |
| 4085–4529  | 固定行高虚拟滚动（DOM 侧）                                                  | `render/virtual.ts`（`lib/virtual.ts` 未动）                          |
| 4530–6150  | 分区事件绑定（约 1600 行）                                                  | `app/bindings/*` 8 个文件，合计 1822 行                               |
| 6151–8012  | 媒体编辑器（约 1860 行）                                                    | `views/editor.ts` + `editor/{shared,photo,video}.ts`，合计 925 行     |
| 8013–8443  | 事件委托                                                                    | `render/events.ts`                                                    |

**循环依赖**：Tarjan SCC 检出 **0 个循环组**（48 个模块全参与）。入度最高的三个是 `state.ts`(32)、`render/context.ts`(27)、`render/paint.ts`(23)——都是设计上的叶子。手段三个：

1. **门面注入**：`render/paint.ts` 声明 `PaintHost`，`main.ts` 启动时 `installPaint()` 装配一次；视图层调 `render()` / `patchGrid()` 只依赖门面，不再反向 import 动作层。
2. **状态对象化**：原 18 个可变 `let` 收进 `editorUi` / `previewUi` / `searchUi` / `aiChatUi` 四个对象，`previewImmersive` 下沉 `state`，`gridEpoch` 改成 `bumpGridEpoch()`。这是唯一"看起来像改写"的地方，语义完全一致（TS2632 不允许跨模块给 import 赋值）。
3. **视图/动作分层**：筛选动作搬 `app/bindings/toolbar.ts`，`toggleToolbarTagPopover` / `toggleAdvancedFilters` 留在 `render/toolbar.ts`。

**纯搬移核验**：419 个原顶层符号一一对位，缺的 18 个全部是上面被并进状态对象的 `let`；48 个函数体 AST 哈希不同，逐条比对后差异只有三类——Prettier 对模板字符串内 `${}` 换行与引号风格归一、`export` 修饰符、以及状态对象化带来的标识符替换（如 `previewImmersiveOpen` → `state.previewImmersive`）。字符串/模板的字面量文本**无一处内容变化**。

---

## 4. 进度追踪

| 会话           | 状态   | 完成日期   | commit                        |
| -------------- | ------ | ---------- | ----------------------------- |
| T1 clippy 清债 | ☑ 完成 | 2026-11-12 | `6d91bc8`                     |
| T3 ESLint 清零 | ☑ 完成 | 2026-11-12 | `b24c1d3`                     |
| T2 发布 v0.6.0 | ☑ 完成 | 2026-11-12 | `db6ddc9` `a852a0a` `2f2d6ff` |
| T4 渲染层拆分  | ☑ 完成 | 2026-11-13 | `ea8a0f9`                     |

---

## 5. 风险与回滚

| 会话 | 主要风险                           | 缓解                                                      | 回滚                                       |
| ---- | ---------------------------------- | --------------------------------------------------------- | ------------------------------------------ |
| T1   | `clippy --fix` 自动改坏代码        | 自动修后立刻 `cargo test`，全绿再继续；分批修、分批验     | 单 commit revert                           |
| T3   | 改写 `finally` 分支时漏掉某条路径  | 先把三条路径在当前代码上的行为写成清单，改完逐条对照      | 单 commit revert，无数据影响               |
| T2   | 带红 CI 发版                       | 打 tag 前把五项检查跑一遍，任一不过就停                   | 删本地与远程 tag，回退版本号               |
| T4   | 循环依赖处理不当，引入隐性行为变化 | 严格按"共享层 → 叶子 → 上层"顺序；每搬一块就 build + test | 单 commit revert（0.6.0 tag 是干净回退点） |

---

## 6. 本轮之后可以看的（暂不给提示词）

这些不是遗留问题，是下一轮的候选，**先攒真实数据再决定做不做**：

- 虚拟滚动在真实 1 万张以上媒体库的实测（滚动帧率、缩略图请求数、内存）
- `facet` / `count` 聚合缓存——需要先量出筛选在多大库上开始有感知延迟
- 前端渲染层拆完后，评估是否还需要引入 Preact（如果 `patch*` 已经够用就不必）
- 视频打标（README 已列为后续增强）
