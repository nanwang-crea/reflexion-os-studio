## 目标

把聊天界面改成 ChatGPT 桌面版风格：

1. **去除头像**：删除助手消息左侧的 `assistant-avatar`（Spark 图标方块），消息正文与工具轨迹直接左对齐铺满。
2. **工具轨迹聚合为一组**：一条 assistant 消息的所有工具调用合并成一个可折叠组：
   - 有工具在**进行中**（pending/running/awaiting_approval）→ 组自动展开，内部每条调用一行（`• 写入文件 src/x.ts`、`• 执行命令 npm test`），单行点击展开参数/结果详情（保留现有 `<details>` 行）；组头显示当前进行中的那条调用。
   - 工具**全部结束**（completed/failed/cancelled）→ 组自动折叠成**一行摘要**，如 `编辑了 2 个文件 · 执行了 1 条命令`（失败时追加 `· 1 个失败`），点击可再展开看明细；此时正文流式输出，最终消息干净无干扰。
   - 折叠时机与 `ThinkingPanel` 一致（思考中展开、回答开始后收起），用户手动开合在下一次状态切换前有效。
3. 思考面板、用户气泡、复制/重试操作行、审批卡保持现状。

## 文件改动

### 1. `features/chat/ToolTraceCard.tsx`（核心改造）
- 结构改为：`<div className="tool-group">` + 组头按钮（`tool-group-toggle`） + 条件渲染的 `.tool-trace` 列表。
- 新增状态推导：
  - `activeCall` = 首个 in-flight 调用（pending/running/awaiting_approval，与现有 `inFlight` 判断一致）。
  - `open` state：`useEffect(() => setOpen(active), [active])`，完全套用 ThinkingPanel 的"状态切换覆盖手动开合"模式。
- 组头文案：
  - 进行中：`{当前调用的名称} {summarizeArgs(args)}`（如 `写入文件 src/x.ts`），带脉冲圆点。
  - 已完成：聚合摘要——按调用分类计数：`file.edit/file.write` → "编辑了 N 个文件"；其余 `file.*` → "读取了 N 个文件"；`shell.execute` → "执行了 N 条命令"；其他工具 → "N 个操作"；任一项失败追加 `失败 N 个`。用 ` · ` 连接，空类别不显示。
- 行项目 `ToolTraceItem` 保留现状（一行 + `<details>` 展开参数/结果），仅移入组内；`runActive` 仍用于行内脉冲。
- 导出名 `ToolTraceCard` 与 props 签名不变，`AssistantMessage` 调用点无改动。

### 2. `features/chat/AssistantMessage.tsx`
- 删除 `<div className="assistant-avatar">…SparkIcon…</div>` 与对应的 flex 包裹；`SparkIcon` 移出 import（仅头像用到），保留 `CheckIcon/CopyIcon`。

### 3. `features/chat/chat.css`
- `.msg-assistant` 改为块级布局（去掉 flex + gap）；`.assistant-main` 去掉 flex:1，改为 width:100%。
- 删除 `.assistant-avatar` 规则。
- 新增 `.tool-group` / `.tool-group-toggle` / `.tool-group-label` / `.tool-group-dot` / `.tool-group-chevron`（复用 `.thinking-*` 的视觉语言：边框、圆角、12~13px 灰字、hover 提亮、chevron 旋转）。
- `.tool-trace` 保留原列表样式（内部行样式不动）。

## 验证

- `pnpm --filter @reflexion-os-studio/desktop typecheck`
- `pnpm format:check`
- `pnpm --filter @reflexion-os-studio/desktop build:frontend`

无 Rust/契约改动，跳过 cargo 验证。

## 明确的取舍

- 折叠时机选"工具全部结束即折叠"，而不是"整条回答完整才折叠"：与思考面板行为一致，且更贴近 ChatGPT 的观感（步骤做完即收起，正文流式期间界面干净）。若你更想要"回答流式完成后才折叠"，只需把推导条件换成"消息面 runActive 结束"，改动很小，可随时调。