# 编辑器 UX 优化设计（缩放自适应 / 脏标识 / 关闭拦截 / 快捷键 / 编辑器 UI）

日期：2026-09-12
状态：已与用户逐项确认

## 背景与问题

用户观察并经代码核实的问题（全部属实）：

1. **消息区不自适应**：聊天列宽为固定值 `--chat-col: 760px`（`style.css:26`），窗口最大化时消息区不变宽。
2. **无脏文件标识**：`MonacoSurface` 内部已跟踪 `dirty` 并经 `onStateChange` 上抛（`MonacoSurface.tsx:139`），但仅用于编辑器头部"保存"按钮显隐；标签页拿不到该状态，`OpenFileTab` 无 dirty 字段。
3. **无关闭拦截**：`closeTab`（`useWorkspacePanel.ts:117`）直接关闭，未保存修改静默丢弃；`ConfirmDialog` 组件已存在可复用。切项目（`resetWorkspaceFiles`）同样静默丢弃。
4. **无快捷键**：全前端除 `ConfirmDialog` 的 Esc/Enter 外无任何全局键盘处理。
5. **既有数据丢失缺陷（本次发现）**：`FileViewerPanel` 仅渲染激活标签内容（`FileViewerPanel.tsx:417`，`key={path}`），**切换标签即卸载编辑器、未保存内容静默丢失**——比关闭丢数据更易踩中。
6. **编辑器 UI 观感**：标签条生硬（边框分隔 + 方块高亮），编辑器头部按钮平铺（× 在最左、保存按钮脏时插入导致布局跳动），字号 13px 偏小。

## 设计决策（用户已确认）

| 决策点 | 结论 |
| --- | --- |
| 缩放语义 | 非 WebView 缩放；指窗口拖大后消息区自适应 → 列宽上限加宽 |
| 聊天列宽 | `--chat-col` 由 `760px` 改为 `min(1200px, 85%)`，全部 6 处使用点自动跟随 |
| 脏状态归属 | 方案 A：上收至 `useWorkspacePanel`（`dirtyPaths: Set<string>`） |
| 切换标签丢数据 | 文本类标签保活（非激活 `display:none`），修复数据丢失 |
| 关闭确认 | 三键弹窗：保存并关闭（主）/ 不保存 / 取消；`ConfirmDialog` 扩展可选第三键 |
| 切项目确认 | 保存全部并切换 / 放弃并切换 / 取消 |
| 快捷键 | `Cmd/Ctrl+S` 保存；`Cmd+Shift+W`（macOS）/ `Ctrl+W`（Win·Linux）关标签；不绑 Esc；macOS 不用 `Cmd+W`（原生菜单优先，让路需改 Tauri 菜单，不做） |
| 关窗口拦截 | 本批最后实现；前端 `onCloseRequested` 拦截，做不完如实留到下批 |
| 编辑器 UI | 头部重排 + 头部脏圆点 + 标签条 VS Code 风格重构 + 字号微调（13→14）+ 顺带简化冗余样式 |

## 详细设计

### 1. 聊天列宽加宽

`styles/style.css`：

```css
--chat-col: min(1200px, 85%);
```

`chat.css` 中 6 处使用（transcript / composer / 悬浮卡对齐）无需改动；`calc((100% - var(--chat-col)) / 2 + 12px)` 类表达式对 `min()` 值仍然合法。具体数值实现时可微调。

### 2. 脏状态上收 + 标签保活

**状态**：`useWorkspacePanel` 新增：

- `dirtyPaths: Set<string>`；
- `setTabDirty(path: string, dirty: boolean)`：增删项，值不变时 no-op（防键击级重渲染）；
- `closeTab` / `resetWorkspaceFiles` 内清对应脏标记。

**通知链**（延长现有链路）：`MonacoSurface.onStateChange`（已有）→ `MonacoEditor` 新增 `onDirtyChange?: (path: string, dirty: boolean) => void` → `FileViewerPanel` 新增同名 prop → `App` 接线 `setTabDirty`。Markdown 预览（源码即编辑模式，同样基于 `MonacoSurface`）走同一链路。

**保活规则**：

- 文本类标签（Monaco + Markdown 预览）：全部保持挂载，非激活标签容器 `display:none` 隐藏；未保存内容跨切换存活，后台脏标签可保存，圆点对后台标签有意义。
- diff / binary 标签：无脏状态，维持现状仅渲染激活项。
- 保活后 Monaco 实例随 `display:none`→`block` 由 `automaticLayout`（ResizeObserver）重排，实现时验证。
- 命令句柄：`FileViewerPanel` 内部持有 `Map<path, MonacoSurfaceHandle>`（保活使其始终可用），经 ref 上抛 `saveDirty(path): Promise<boolean>` / `saveAllDirty(): Promise<{ saved: string[]; failed: string[] }>`。

### 3. 脏圆点 + 关闭拦截 + 三键弹窗

**圆点**：标签文件名旁渲染 `·`（`workspace.css` 新增 `.file-tab-dirty`）；按第 6 节 VS Code 行为，脏时圆点**替代**关闭 ×，hover 标签时圆点变回 ×。编辑器头部文件名旁同样显示圆点（头部关闭按钮独立，不受影响）。

**ConfirmDialog 扩展**（向后兼容）：`ConfirmDialogState` 增加可选 `tertiaryLabel?: string`，组件新增 `onTertiary?: () => void`；按钮顺序 `[取消] [tertiary ghost] [confirm primary]`。

**关闭脏标签流程**（App 层持有 `pendingClosePath` 状态）：

1. 点 × 且该标签脏 → 弹「有未保存的修改」三键弹窗；
2. 保存并关闭 → `saveDirty(path)`，成功后 `closeTab`，失败保持打开并提示错误；
3. 不保存 → 直接 `closeTab`；取消 → 关闭弹窗。

**切换项目流程**：目标项目切换前若 `dirtyPaths` 非空 → 弹「N 个文件未保存」三键弹窗；保存全部并切换 → `saveAllDirty()` 成功项清除、存在失败项则中止切换并提示；放弃并切换 → 清脏标记 + `resetWorkspaceFiles()`。

### 4. 快捷键（新 hook `hooks/useAppHotkeys.ts`）

- 平台分支显式：macOS `Meta`，Win/Linux `Ctrl`（`navigator.platform` / `userAgent` 判定，收敛在 hook 内）。
- `Cmd/Ctrl+S`：保存激活脏文件。编辑器内经 Monaco `addCommand(KeyMod.CtrlCmd | KeyCode.KeyS, save)` 绑定（Monaco 吞 keydown，全局监听收不到）；编辑器外全局 keydown 兜底，两者汇到同一 `MonacoSurfaceHandle`。
- 关标签：macOS `Cmd+Shift+W` / Win·Linux `Ctrl+W`，走第 3 节拦截流程。
- 不绑 Esc（与 Monaco 内建 Esc 语义冲突）。
- 快捷键提示：按钮 `title` 注明快捷键。

### 5. 关窗口拦截（本批最后）

- 前端经 `@tauri-apps/api/window` 的 `getCurrentWindow().onCloseRequested` 拦截：`dirtyPaths` 非空时 `event.preventDefault()`，弹「放弃修改并退出 / 取消」双键弹窗，确认后 `destroy()`。
- 预期无需 Rust 改动；实现时验证 `capabilities` 对 `core:window` 相关权限的放行，不满足再补 capability。
- 此项工作量最大，允许留到下一批（如实记录）。

### 6. 编辑器 UI 优化

**标签条（VS Code 风格重构）**：

- 激活标签背景与编辑器内容区同色（`#1e1e1e` / 主题 editor.background），视觉上"融入"内容区；标签条整体底色用 `--bg-sidebar`；
- 去掉标签间竖向 `border-right` 分隔与方块高亮的生硬感，改为间距 + 微妙背景差；激活标签顶部或底部以细线/无边界方式区分（以实现后视觉评审为准）；
- 脏圆点与关闭按钮按 VS Code 行为：脏时显示圆点，hover 标签时圆点变回 ×。

**编辑器头部重排**（`MonacoEditor.tsx` + `workspace.css`）：

- 布局改为三段：左侧文件名 + 脏圆点（title 显示完整路径）；右侧操作组（复制 / 编辑切换 / 保存 / 关闭×）右对齐；
- 保存按钮常驻（非脏时 disabled），消除脏时插入导致的布局跳动；
- 错误提示位置保持头部右侧。

**字号**：`DEFAULT_EDITOR_OPTIONS.fontSize` 13 → 14，`lineHeight` 20 → 21（或按视觉评审微调）。

**样式简化**：重构过程中合并冗余选择器（如 `.content-close` 与 `.file-tab-close` 重复的关闭按钮样式、`.content-head .ghost` 覆盖链），不改变其余区域视觉。

## 错误处理

- 保存失败：编辑器保持打开，头部错误提示（现有 `surface.error` 机制）+ Toast；
- `saveAllDirty` 部分失败：中止切换项目，Toast 列出失败文件；
- 关闭弹窗期间的并发操作（连点 ×）：弹窗打开期间忽略后续关闭请求（`pendingClosePath` 单值互斥）。

## 影响文件（预估）

| 文件 | 变更 |
| --- | --- |
| `styles/style.css` | `--chat-col` |
| `hooks/useWorkspacePanel.ts` | `dirtyPaths` / `setTabDirty` / 清理 |
| `hooks/useAppHotkeys.ts` | 新增 |
| `features/workspace/FileViewerPanel.tsx` | 先拆分再改造（见下） |
| `features/workspace/FileTabs.tsx` | 新增（自 `FileViewerPanel` 拆出：标签条 + 拖拽排序 + 自绘滚动条 + 脏圆点） |
| `features/workspace/editor/MonacoEditor.tsx` | 头部重排 / onDirtyChange / 句柄上抛 |
| `features/workspace/editor/MonacoSurface.tsx` | Monaco Cmd+S addCommand |
| `features/workspace/editor/monaco.ts` | 字号 |
| `components/ConfirmDialog.tsx` | 第三键 |
| `App.tsx` | 接线（关闭拦截弹窗 / 快捷键 / dirty 链路）；若超行数上限，同步拆出关闭确认编排 hook |
| `features/workspace/workspace.css` | 标签条 / 头部样式重构 |
| `App.tsx` / `main.tsx` | 关窗口拦截（第 5 节） |

**拆分纪律**：`FileViewerPanel.tsx` 现 454 行（硬上限 500），本次必拆：`FileTabs.tsx`（标签条含拖拽与滚动条）+ `FileViewerPanel.tsx`（布局宿主 + 保活渲染 + 句柄聚合）。

## 跨平台

- 快捷键 Meta/Ctrl 显式分支；`Cmd+W` 不绑（原生菜单冲突），Win/Linux `Ctrl+W` 无冲突；
- 关窗口拦截走 Tauri `onCloseRequested`，三平台行为一致，无 POSIX/WinAPI 假设；
- 聊天列宽为纯 CSS，平台无关。

## 验证

1. 标准流程：`pnpm format:check` / `pnpm lint` / `pnpm typecheck`（根 + desktop）/ `pnpm build:packages` / `cargo fmt --check` / `cargo test` / `cargo check`；
2. dev 模式手动冒烟：最大化窗口消息区变宽；编辑→切换标签→切回内容仍在；圆点出现/消失；脏标签关闭三键弹窗各路径；保存失败路径；Cmd+S（编辑器内外）/ Ctrl+W；切项目弹窗；
3. 性能（红线 10）：保活后多标签 + 空闲状态 `top -l 4 -s 3 -stats pid,cpu,mem` 采样，三进程 CPU ≈0%、与基线对比；
4. 事件接线无新增高频订阅（dirty 回调为低频、去重），无定时器新增。
