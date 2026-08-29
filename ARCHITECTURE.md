# ReflexionOS Studio 总体架构

## 1. 目标与非目标

ReflexionOS Studio 是桌面端 Agent Runtime 与可插拔图执行平台。它同时支持对话 Agent 和节点式 Workflow：前者是动态决策图，后者是预定义 DAG。

第一阶段目标：可恢复的本地 Runtime、统一事件流、插件契约和安全工具边界。第一阶段非目标：复制 ComfyUI 全部节点、实现云端协作、一次性迁移所有旧功能。

## 2. 技术选型

| 层             | 技术                           | 职责                                                   |
| -------------- | ------------------------------ | ------------------------------------------------------ |
| UI             | React + TypeScript             | 对话、Plan、Tool Trace、Workspace 和后续 Workflow 画布 |
| Desktop Host   | Tauri 2（第一阶段）            | 窗口、IPC、两个 sidecar 的 spawn/supervise、插件安装   |
| Agent Runtime  | Node.js + TypeScript           | Agent、Context、模型、工具编排、事件、恢复             |
| System Runtime | Rust（Phase 1）                | 文件、Shell、工具子进程和不可绕过的 enforcement        |
| Storage        | SQLite                         | canonical 业务状态、审计事件和资产/Workspace 索引      |
| Contracts      | TypeScript types + JSON Schema | 跨进程、插件和持久化协议                               |

Python 不进入新 Runtime 的核心路径，仅作为迁移期旧系统。

## 3. 进程与依赖关系

```text
Renderer (React)
   │ safe IPC: commands/events
Tauri Rust Host (Desktop Host / Supervisor)
   ├── spawn/supervise → TypeScript Runtime
   └── spawn/supervise → Rust System Runtime

TypeScript Runtime
   ├── Agent / Context / Model / Tool orchestration
   ├── Product Policy Gateway
   ├── SQLite canonical state + minimal audit event log
   └── JSON-RPC over stdio → Rust System Runtime

Rust System Runtime
   ├── File Service
   ├── Shell Service
   ├── System Process Executor
   └── deny-by-default enforcement
```

Tauri Host 创建启动页并分别启动 Rust 与 TypeScript Runtime；TypeScript Runtime 发出 `runtime.ready` 后向 Renderer 报告 Chat ready，Rust 发出 `system.ready` 后启用工具能力。两个 sidecar 都由 Host 监控，但 Rust ready 不阻塞纯 Chat。Host 负责启动超时、版本不兼容、有限重启、关闭传播和 degraded 状态。Runtime 不依赖桌面宿主或 React。Renderer 不直接访问 Provider、数据库或系统工具。TS Runtime 与 Rust 使用 JSON-RPC 2.0 over newline-delimited stdio；stdout 只传协议，stderr 只写日志。固定端口 HTTP 不是核心通信方式，避免本机暴露面和端口冲突。

## 4. 统一执行模型

所有可执行能力都以 Node 暴露：显式输入 schema、显式输出 schema、权限声明、可取消的异步执行和结构化事件。Graph Runner 负责拓扑校验、调度、并行、重试、checkpoint 与恢复。

Agent 是一种特殊节点。其内部可以动态选择下一个 Tool/Model 节点，但外部仍遵循相同的 Run/Node Run 生命周期。Agent、Memory、Skill、Context 和 Delegation/Policy 是一等领域；第一阶段运行单一 Primary Agent，后续阶段增加受控多 Agent 委派。因此 Chat 与以下工作流共享执行内核：

```text
Prompt → Text-to-Image → Review → Image-to-Video → Export
```

## 5. 扩展层次

1. **Provider Plugin**：Chat、Image、Video、Embedding 等模型能力。
2. **Tool Plugin**：文件、Shell、Git、Browser、MCP 等系统/外部能力。
3. **Skill/MCP Plugin**：可复用提示、工具集合和外部协议适配。
4. **Workflow Node Plugin**：面向画布的产品化节点，调用 Provider 或 Tool，但不与 Provider 混为一谈。

每个插件使用 manifest 声明版本、能力、配置 schema 和权限。ComfyUI 等系统先作为外部 Provider/Workflow Backend 接入。

## 6. 事件与状态

`runtime_events` 是 append-only 的最小审计和 UI 通知日志，不是唯一事实源。sessions、runs、messages 等 MVP canonical 状态表直接由单一 Runtime 事务写入；MVP 不实现 outbox relay 或完整事件溯源。后续跨进程可靠投递时再增加 outbox。每个 Run 有稳定 ID；`message.delta` 只在内存/传输层流式发送，最终保存完整消息。

主要事件包括 `run.started`、`message.delta`、`tool.requested`、`approval.required`、`node.started`、`node.completed`、`run.failed` 和 `run.completed`。

## 7. 安全边界

工具/节点必须声明权限。TypeScript Policy Gateway 负责意图/风险分类、审批交互和一次/Session/Project 授权范围，但不是安全边界；它生成与 request、workspace、operation 和 TTL 绑定的授权上下文。Rust Enforcement 使用 deny-by-default 的严格 schema 校验 capability/approval token、实际路径、命令、cwd、环境和进程限制；不接受任意 `authorized: true`，任何缺失、过期、范围不符或参数改变都拒绝。

## 8. 存储边界

- Definition：Agent、Workflow、Node、Provider、Plugin 配置。
- Runtime：Session、Run、Node Run、Tool Call、Approval、Checkpoint。
- Event：不可变事件日志。
- WorkspaceFile：Workspace 中真实存在的文件实体，使用受保护的 workspace-relative path。
- Asset：Asset Store 中的内容存储实体，AI 生成媒体或导出内容使用 `AssetRef`。
- Artifact：一次 Run 产生的面向用户的结果语义，可引用 Asset 或 WorkspaceFile。
- ResourceLink：UI 导航引用，不拥有内容，可指向 WorkspaceFile、Asset 或 ExternalUrl；由 Resource Router 决定查看器、Browser Surface 或系统打开方式。
- Workspace：文件树、文件统计、代码/文档查看和 Git 摘要是按需/异步投影，不允许 UI 直接读取任意本地路径。

## 9. 依赖规则

允许：`contracts → all`、`SDK → plugins/runtime`、`runtime → contracts/SDK/storage`、`desktop → runtime-client`。

禁止：UI 直接调用 Provider；Agent 直接访问桌面宿主；Provider 管理 Session；Tool 自己决定审批；插件直接依赖数据库内部实现；领域模块通过全局可变状态通信。

## 10. 分阶段建设

新项目按产品能力逐阶段实现，而不是一次性铺开所有抽象。Phase 1A 以 TypeScript Runtime + Rust System Runtime 交付可用 Chat Core；Phase 1B 再增加不阻塞 Chat 的 Workspace Surfaces。后续依次建设 Agent Platform、Multi-Agent Orchestration、Workflow Engine、Multimodal Workflow 和 Desktop Hardening。完整范围见 `docs/ROADMAP.md`。

Provider/Secrets、流式取消恢复、测试和分发边界分别见 `docs/PROVIDER-AND-SECRETS.md`、`docs/RELIABILITY-AND-RECOVERY.md` 和 `docs/TESTING-AND-DISTRIBUTION.md`。

Agent、Memory、Skill、Context 和 Delegation/Policy 是一等领域，分别见 `docs/AGENT-MODEL.md`、`docs/MEMORY-SYSTEM.md`、`docs/SKILL-SYSTEM.md`、`docs/CONTEXT-MANAGEMENT.md`、`docs/MULTI-AGENT.md` 和 `docs/DELEGATION-AND-POLICY.md`。

旧 `../ReflexionOS` 仅作为参考，不是新项目的运行时依赖。新项目不为下线旧系统而设计兼容层；只有在复用已有经验能降低风险时才参考旧实现。

## 11. 架构验收标准

任何新能力都必须能说明：所属层、输入输出 schema、权限、事件、取消/重试语义、持久化边界和测试方式。核心模块超过约 300–500 行时应重新审视职责切分。详细协议见 `docs/`。
