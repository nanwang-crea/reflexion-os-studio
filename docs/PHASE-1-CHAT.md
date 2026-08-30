# Phase 1：Chat Agent

Phase 1 采用 Chat-first，拆为 **1A-0 Bootstrap**、**1A-1 Chat Core**、**1A-2 System Tools** 和 **1B Workspace Surfaces**。最小 MVP 是 1A-0 + 1A-1，目标是启动界面、Provider 配置和正常流式沟通。

## Phase 1A-0：Bootstrap

- Tauri Host 启动页；
- 启动并监控 TypeScript Runtime 和 Rust sidecar；
- JSON-RPC 2.0、newline-delimited stdio；
- `runtime.ready`、`system.ready`、`runtime.get_status`、`system.ping`、`system.shutdown`；
- stdout 只传协议，stderr 只写日志；
- Runtime ready 后 Chat 可用；Rust 未 ready 显示 Tools unavailable，不阻塞 Chat；
- sidecar 崩溃、启动超时和版本错误显示可恢复状态并按有限策略重启。

## Phase 1A-1：Chat Core（最小 MVP）

- OpenAI-compatible Provider；
- 首次 Provider 配置和系统 Secret Store；
- Project、Session、Message、Run 最小模型；
- 单一固定 Primary Agent；
- Session Context 和 Run-local Working Memory；
- SSE 流式响应、delta、finish reason；
- Stop、Retry、Provider 错误和断线错误；
- SQLite 保存 projects/sessions/messages/runs/provider_profiles；
- 重启读取历史；
- 没有 API Key 时仍可进入应用并显示配置引导。

1A-1 不实现 Tool Calling、ApprovalGrant、文件/Shell、outbox、Workspace、Browser、Asset、Skill、Memory pipeline、Multi-Agent、Workflow 或 CLI。

## Phase 1A-2：System Tools

在 1A-1 稳定后加入 Rust File/Shell Service、Workspace 边界、`read-only`/`workspace` Profile、`automatic`/`ask`/`denied`、短期内存 ApprovalGrant、Tool Trace、超时、取消和最小恢复。`process.spawn` 仅为 Rust 内部实现，不作为 Agent Tool。

## Phase 1B：Workspace Surfaces

再加入异步 Workspace Indexer、文件树/统计、代码/文档查看器、Git Diff、Asset/Artifact Card、ResourceLink、系统浏览器打开和可选只读内嵌 Browser。它们不得阻塞 Chat。

## UI 原则

不做常驻 Run Inspector。MVP 主界面只常驻 Project/Session Sidebar、Chat Transcript、Composer 和 Runtime/Provider 状态，整体采用 Codex 式深色布局：左侧栏分"项目"与"对话"两个分区（新建入口在各分区标题右侧与项目行尾），主区为居中消息流和圆角 Composer。

Composer 底部控制条（参照主流 Agent 形态）：左侧为权限 Profile 选择器（`workspace` 工作区读写 / `read-only` 只读，取自 Permission Model 文档命名，UI 偏好存 localStorage，工具能力上线后接入策略网关）；右侧为模型选择器（启用供应商 × 其模型列表，`message.send` 携带 `providerId`/`model`）和发送/停止按钮。

设置页为"供应商列表 + 详情编辑"双栏：支持多供应商的增删改、启用/禁用、名称/Base URL/模型列表编辑；编辑时无需重输 API Key（沿用已存 `secretRef`），仅输入新 Key 时覆盖。

会话分两类，入口都是直接在 Composer 输入：

- **独立对话**：不关联项目；侧栏"对话"分区"＋"或未选项目时在落地页输入即创建。
- **项目对话**：项目与本地文件夹一一对应（`tauri-plugin-dialog` 让用户选择文件夹，三平台原生对话框）；选中项目后在落地页输入即在项目内创建会话，项目行尾"＋"新建项目内会话，项目节点展开显示其下会话。

启动页状态：`starting`、`runtime-ready`、`system-degraded`、`provider-required`、`ready`、`error`。Plan、Tool Trace、Approval、Artifact 和 Git 内容在对应阶段按需加入。

## MVP Done Definition

```text
冷启动 → 启动页 → runtime.ready → Chat 可用
→ 配置 Provider → 创建 Project/Session → 发送消息
→ 看到连续 delta → 完整回复 → 重启应用 → 历史仍存在
```

负向场景：无 Key 显示配置引导；Provider 认证/网络/限流错误可见且可重试；中途断开标记 interrupted；Stop 标记 cancelled；Runtime 未 ready 禁止发送；Rust 未 ready 不影响 Chat；未连接发送不可静默丢失。
