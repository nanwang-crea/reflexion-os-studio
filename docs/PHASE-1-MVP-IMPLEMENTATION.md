# Phase 1 MVP 实施步骤

> **状态：已完成（2026-08-30）**。本文档是 M1–M5 阶段的实施记录，M5 验收通过后
> 扩展范围已由 Phase 1A-1 / 1A-2 与 Phase 2 子集（Skills、Memory）接管；
> 其中的"MVP 明确不做"清单已是历史约束，不代表当前能力边界。
> 当前阶段与能力边界见 `ROADMAP.md` 与 `AGENTS.md` §1。

## 目标

先交付一个可以启动、配置模型并正常流式沟通的桌面 Chat MVP。MVP 不包含 Tool Calling、文件操作、审批、Workspace、浏览器、插件、Memory、Multi-Agent 或 Workflow。

## 里程碑

### M0：工程与启动骨架

创建实际 package：`apps/desktop`、`apps/runtime`、`packages/contracts`、`packages/runtime-client`、`packages/model-sdk`、`packages/storage` 和 `crates/system-runtime`。补充 `dev`、`build`、`typecheck`、`test` 脚本。

Tauri Host 显示启动页并启动两个 sidecar。Rust sidecar 先实现 `system.ready`、`system.ping`、`system.shutdown`；TypeScript Runtime 实现 `runtime.ready`、`runtime.get_status`。Rust 异常不阻塞 Chat，但 UI 显示 Tools unavailable。

### M1：Contracts 与最小传输

实现 MVP 所需 TypeScript 类型、JSON Schema 和 validator：ProtocolEnvelope、Handshake、Project、Session、Message、Run、ProviderConfig、ChatCommand、RuntimeEvent、RuntimeError、CancelCommand。

Transport 固定为 JSON-RPC 2.0 over newline-delimited stdio：stdout 只传协议，stderr 只写日志；request/response 使用 JSON-RPC id，事件使用 notification。发送失败必须返回可见错误，不允许静默丢弃。

### M2：Runtime Chat Core

Runtime 实现 Project/Session/Message/Run 最小服务、单一固定 Primary Agent、Session Context 和 Provider 调用。首版只支持 OpenAI-compatible Chat Provider，支持 SSE delta、finish reason、timeout、可重试错误和 AbortSignal。

纯 Chat 只要求 TypeScript Runtime ready；Rust 未 ready 时不影响模型对话。

### M3：Desktop Chat UI

实现启动状态页、Provider 首次配置引导、Project/Session 空状态、消息列表、流式消息、Stop、Retry、错误状态和 Runtime/System 状态徽标。无 API Key 时应用仍可启动，并引导进入设置。

### M4：最小 SQLite

使用单 Runtime 写入 SQLite。首版表：`projects`、`sessions`、`messages`、`runs`、`provider_profiles`。消息完成时事务保存完整内容；流式中断时保存 partial 内容并将 Run/Message 标记为 `interrupted`。暂不实现 outbox、复杂 replay、Workspace projection。

### M5：MVP 验收

#### Happy path

```text
冷启动
→ 启动页
→ runtime.ready
→ 进入 Chat
→ 配置 Provider
→ 创建 Project/Session
→ 发送消息
→ 流式显示 delta
→ 完整回复
→ 重启应用
→ 历史仍存在
```

#### Negative path

- 无 API Key：显示配置引导，不阻塞启动；
- Provider 认证/网络/限流错误：显示稳定错误类别和重试入口；
- 流式中途断开：消息显示 interrupted，不假装完成；
- 用户 Stop：Abort 传播，Run 标记 cancelled；
- Runtime 未 ready：发送按钮禁用并显示原因；
- Rust 未 ready：Chat 仍可用，工具能力显示 unavailable；
- sidecar 崩溃：Host 显示错误并按有限策略重启；
- 未连接发送：返回错误，不静默丢消息。

## MVP 明确不做

Tool Calling、Rust 文件/Shell、ApprovalGrant、Permission Profile、outbox、Workspace Indexer、文件树、代码查看器、Asset、ResourceLink、Browser、Skills、Memory pipeline、MCP、Multi-Agent、Workflow、CLI 和完整插件系统。

## 后续进入 Phase 1A-2 的条件

MVP 的冷启动、Provider 配置、流式 Chat、Stop、错误、持久化和重启恢复全部通过测试后，才开始 Rust 文件/Shell和审批实现。任何工具实现不得回填为 Chat Core 的隐式依赖。
