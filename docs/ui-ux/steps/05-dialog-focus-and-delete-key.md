# 步骤 05 · 弹窗焦点管理 + 删除键位安全

| 项           | 内容                                                                                                                         |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| 阶段         | P0（安全 + 可访问性）                                                                                                        |
| 覆盖诊断编号 | 13.1 / 13.6 / 5.5                                                                                                            |
| 依赖         | `01 反馈三通道`（删除后的撤销提示用 toast 动作位；未做 01 时跳过 Undo 部分）                                                 |
| 预估         | 1 个会话                                                                                                                     |
| 主要文件     | `src/app/focus.ts`（新建）、`src/app/orchestrate.ts`、`src/app/bindings/global.ts`、`src/views/dialogs.ts`、`src/styles.css` |

---

## 1. 目标

1. **弹窗真的有模态语义**：打开时焦点进入弹窗、Tab 在弹窗内循环、背景 `inert`、关闭后焦点返还触发元素。目前所有 dialog 都有 `aria-modal="true"`，但没有一条兑现。
2. **`Enter` 不再等于「执行删除」**：删除确认框默认聚焦「取消」，`Enter` 只是激活当前聚焦的按钮。危险动作必须由用户明确指向。
3. **删除后可撤销（5 秒）**：文件进的是系统回收站，撤销成本很低，应该给。

---

## 2. 现状与证据（v0.6.0 已核实）

- 全仓搜 `focus-trap` / `inert` 无结果：没有任何焦点约束实现。
- `src/app/bindings/global.ts:43` 起是一个全局 `window.addEventListener("keydown")`，按 `state.editorOpen / state.deleteConfirm / tagPopoverOpen / previewIndex` 分派 `Esc`；层级靠 if 顺序维护。
- 同文件约 82–92 行：

  ```ts
  if (state.deleteConfirm && !state.deleting) {
    if (event.key === "Escape") {
      cancelDeleteConfirm();
      return;
    }
    if (event.key === "Enter") {
      void runConfirmedDelete();
      return;
    } // ← 危险
  }
  ```

  用户按回车"想确认弹窗已弹出"，直接开始删除。

- `src/views/dialogs.ts:330` `renderDeleteConfirm()`：`.confirm-dialog` 有两个取消按钮（`#cancel-delete-confirm`、`#cancel-delete-confirm-footer`）和一个危险按钮（`#confirm-delete`，`.danger-button.confirm-danger`）。渲染完成后**没有人设置初始焦点**，所以焦点留在触发按钮上或被清到 `body`。
- `src/app/orchestrate.ts:65` `patchOverlay()` 负责插入/移除 overlay DOM，`leaveOverlay()` 负责退场动画——焦点返还应该挂在这里，而不是各弹窗各写一遍。
- 遮罩样式：`.modal-backdrop` 已有 blur，但背景内容仍可被 Tab/读屏访问。

---

## 3. 改动清单

| #   | 文件                                       | 位置                  | 改什么                                                                                                                                                                                             |
| --- | ------------------------------------------ | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `src/app/focus.ts`（新建）                 | —                     | `trapDialogFocus(container, { initialFocus?, onClose })`：记录 `document.activeElement`；`Tab/Shift+Tab` 在容器内可见可聚焦元素间循环；`Esc` 调 `onClose`；返回 `release()`（移除监听 + 焦点返还） |
| 2   | 同上                                       | —                     | `setBackgroundInert(on: boolean)`：对 `.shell` 与 `#toast-host` 之外的兄弟节点设置 `inert`；同一时刻只保留一个活动弹窗的 inert 状态（用栈计数，避免嵌套弹窗关闭时误解锁）                          |
| 3   | `src/app/orchestrate.ts`                   | `patchOverlay`        | 插入 HTML 后：找到 `[role="dialog"]` 容器 → `trapDialogFocus`；移除（或退场动画结束）后 `release()`；用 `overlayFocusStack` 管理前后顺序                                                           |
| 4   | `src/views/dialogs.ts`                     | `renderDeleteConfirm` | 给「取消」按钮加 `data-autofocus`；危险按钮不加；文案不变                                                                                                                                          |
| 5   | `src/app/bindings/global.ts`               | 删除确认分支          | **删除** `Enter → runConfirmedDelete()` 整段；只保留 `Esc → cancelDeleteConfirm()`。`Enter` 交还给浏览器（激活当前聚焦按钮）                                                                       |
| 6   | 同上                                       | 全局 `keydown`        | 若焦点在 input/textarea/contenteditable 内，除 `Esc` 外不拦截；避免弹窗内输入时被全局快捷键劫持                                                                                                    |
| 7   | `src/app/media-ops.ts`（或删除成功回调处） | 删除完成              | `showToast("已移入回收站", { action: { label: "撤销", run: restoreLastDelete } })`；若回收站恢复能力需要后端支持，先只做「在回收站中打开」动作，Undo 留 TODO 并说明                                |
| 8   | `src/styles.css`                           | 焦点样式              | `:focus-visible` 改为 `outline: 2px solid var(--focus-ring); outline-offset: 2px`；浅色 `--focus-ring: #111`、深色 `#fff`；删除现有 `rgba(0,0,0,.2)` 3px 环                                        |
| 9   | `src/app/bindings/global.ts`               | `previewIndex` 分支   | 预览器也走同一套 `Esc` 关闭 + 焦点返还（由 `trapDialogFocus` 统一，删掉这里的特判）                                                                                                                |

---

## 4. 实现要点

1. **焦点陷阱的正确做法**：不要监听整个 document 捕 Tab（会和现有全局 keydown 打架）。在 `container` 上加 `keydown` 监听，只处理 `Tab`；用 `querySelectorAll` 取可聚焦元素并过滤 `disabled`/`offsetParent === null`/`inert`。
2. **初始焦点**：优先 `[data-autofocus]`；否则第一个可聚焦元素；再否则容器本身（`tabindex="-1"`）。删除确认框的 `data-autofocus` 必须在「取消」上。
3. **`inert` 的范围**：`.shell` 整体 `inert` 是最省事的做法，但要注意 toast 在 `#toast-host`（`body` 级），不受影响；预览器叠编辑器时，预览 overlay 也应 `inert`，只有最上层可交互。
4. **嵌套层级**：用栈而不是布尔值。`open(confirm)` → `open(editor)` → 关 editor 时只能解锁 editor 那层，shell 仍应 inert。
5. **不要顺手改 `Esc` 语义**。`Esc` 仍是「关闭当前最上层」。改的是 `Enter`。
6. **Undo 的真实成本**：删除是移入系统回收站 + 索引标记，恢复需要「从回收站还原文件 + 取消索引标记」。若后端没有 `restore` command，本步**不要新造**，改为 toast 动作「打开回收站」(`revealPath`/`openPath` 已有能力)，并在 `10.5` 的统一撤销模型里再评估。
7. **测试**：`focus.ts` 的 Tab 循环与栈计数可以纯函数化测试（给一组元素模拟 `focusable()` 结果），不必启动 DOM 环境以外的东西；项目已有 vitest。

---

## 5. 验收标准

- [ ] 打开任一弹窗（设置/预览/编辑器/标签管理/删除确认/合并），焦点落在弹窗内第一个控件。
- [ ] 连续按 `Tab` 20 次，焦点始终在弹窗内循环，不会跑到背后网格。
- [ ] 弹窗打开时，用鼠标点背景的侧栏/网格：无响应（`inert` 生效）。
- [ ] `Esc` 关闭弹窗后，焦点回到打开它的按钮。
- [ ] 删除确认框打开后直接按 `Enter`：**不删除**，等同于点「取消」。
- [ ] 想删除必须点「移入回收站」或用 Tab 移过去再按 `Enter`/`Space`。
- [ ] 编辑器和预览叠加时，关闭编辑器后预览仍可交互，背景仍不可交互。
- [ ] 焦点环在浅色/深色下都清晰可辨。
- [ ] `pnpm test` / `pnpm lint` / `pnpm build` 全绿；新增焦点栈单测。

---

## 6. 自包含提示词

```text
你是 Camlib 项目的前端工程师。项目在 D:\code-collect\camlib：
Tauri 2 + Vite + 原生 TypeScript（strict，禁止 any）+ Rust + SQLite，Windows 优先的本地相机媒体库。
弹窗集中在 #overlay-host 的 7 个 [data-overlay] 槽位里（preview / confirm / tag-manager / editor / merge / settings / ai-chat），
由 src/app/orchestrate.ts 的 patchOverlay(id, signature, produce) 负责插入与退场动画。

## 任务
1）给所有弹窗补上真正的模态焦点管理（焦点进入、Tab 循环、背景 inert、关闭返还焦点）。
2）把「删除确认框里按 Enter 直接执行删除」改成「Enter 只激活当前聚焦的按钮」，默认焦点在取消。

## 已核实的现状
1. 全仓没有 focus-trap / inert 的实现；所有 dialog 都写了 aria-modal="true"，但没有兑现。
2. src/app/bindings/global.ts 有一个全局 window keydown 监听（约 43 行起），按 state.editorOpen / state.deleteConfirm / tagPopoverOpen / state.previewIndex 的顺序分派 Esc。
3. 同文件约 82-92 行：
   if (state.deleteConfirm && !state.deleting) {
     if (event.key === "Escape") { cancelDeleteConfirm(); return; }
     if (event.key === "Enter") { void runConfirmedDelete(); return; }   // 危险
   }
4. src/views/dialogs.ts 的 renderDeleteConfirm()（约 330 行）：.confirm-dialog 内有 #cancel-delete-confirm（右上 ×）、#cancel-delete-confirm-footer（底部取消）、#confirm-delete（危险按钮，class="danger-button confirm-danger"）。渲染完成后没有任何初始焦点设置。
5. src/app/orchestrate.ts 的 patchOverlay()（约 65 行）负责插入 HTML，关闭时走 leaveOverlay() 做退场动画。
6. src/styles.css 里焦点环是 outline: 3px solid rgba(0,0,0,.2)，在玻璃底上对比不足。

## 要做的事
1. 新建 src/app/focus.ts：
   - trapDialogFocus(container: HTMLElement, opts: { initialFocus?: string; onClose?: () => void }): () => void
     记录 document.activeElement；优先 [data-autofocus]，否则第一个可聚焦元素，否则 container（临时 tabindex="-1"）；
     在 container 上监听 keydown，只处理 Tab/Shift+Tab 做循环；Esc 调 onClose；
     返回 release()，移除监听并把焦点还给打开前的元素。
   - setBackgroundInert(push: boolean)：用栈计数，对 .shell 设置/移除 inert；嵌套弹窗时只有最上层可交互，关闭一层不能误解锁。
2. src/app/orchestrate.ts：patchOverlay 插入 DOM 后，若存在 [role="dialog"] 就 trapDialogFocus；overlay 被移除或退场动画结束后 release()；用栈管理多个 overlay 的顺序。
3. src/views/dialogs.ts：给 renderDeleteConfirm 的「取消」按钮加 data-autofocus；危险按钮不加。
4. src/app/bindings/global.ts：删除确认分支里删掉 Enter 触发 runConfirmedDelete 的整段，只保留 Esc → cancelDeleteConfirm；Enter 交还给浏览器激活当前聚焦按钮。
5. 同文件：全局 keydown 里，如果焦点在 input/textarea/contenteditable 内，除 Esc 外不拦截全局快捷键。
6. 删除完成后的提示：若 src/app/toast.ts（步骤 01 产出）已存在，用 showToast 提供「打开回收站」动作（复用现有 opener 能力）；如果没有恢复能力，不要新造 restore command，也不要写假的「撤销」。
7. src/styles.css：:focus-visible 改为 2px 实色 + 2px offset，新增 --focus-ring（浅色 #111、深色 #fff），替换现有 rgba(0,0,0,.2) 的 3px 环。
8. 预览器的 Esc 特判并入统一机制，删除重复分支。

## 约束
- 不改 Rust；不新增依赖。
- 不改变 Esc 的语义（仍是关闭最上层）；本步只改 Enter 与焦点。
- 不重构全局 keydown 的整体结构，只做必要收敛。
- 不碰虚拟滚动、卡片节点池、缩略图队列。
- TS strict，禁止 any；文案中文。

## 验收
- 任一弹窗打开后焦点在弹窗内；Tab 20 次不逃逸；背景点击无响应。
- Esc 关闭后焦点回到触发按钮。
- 删除确认框打开后直接按 Enter 不删除，等同取消。
- 编辑器叠在预览上时，关闭编辑器后预览仍可交互、背景仍不可交互。
- 浅色/深色下焦点环都清晰。
- pnpm test / pnpm lint / pnpm build 全绿，并补焦点栈的单测。

## 交付方式
先给改动清单（文件 + 函数），再改代码；最后报告三绿结果与键盘手动验证步骤（Tab/Esc/Enter 各一遍）。
```

---

## 7. 风险与回滚

| 风险                         | 表现                           | 处理                                                                        |
| ---------------------------- | ------------------------------ | --------------------------------------------------------------------------- |
| 与全局 keydown 抢事件        | Tab 被拦两次、Esc 触发关闭两次 | Tab 只在容器级监听并 `preventDefault`；Esc 只在全局一处处理，容器不重复处理 |
| `inert` 导致预览器内部无法点 | 关闭弹窗后忘了解除             | 用栈计数 + `release()` 幂等，确保关闭路径（含退场动画）都调用               |
| 焦点返还到已被移除的节点     | 焦点落到 `body`                | `release()` 检查 `isConnected`，否则退回 `.content`                         |
| 用户习惯按 Enter 删          | 抱怨"变慢了"                   | 这是有意为之；按钮 hover 文案可加「Enter 确认」提示，但不恢复全局 Enter     |
| 回滚                         | 低                             | 新增文件 + 两处分支改动，单独回滚不影响其他步骤                             |
