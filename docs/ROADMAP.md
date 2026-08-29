# ReflexionOS Studio 分阶段路线图

## Phase 0：Architecture Foundation（已完成）

项目骨架、总体架构和协议边界文档。

## Phase 1A-0：Bootstrap

Tauri 启动页、TypeScript Runtime 和 Rust sidecar 启动/监控、JSON-RPC 握手、状态展示和优雅关闭。Rust 未 ready 不阻塞 Chat。

## Phase 1A-1：Chat Core（最小 MVP）

OpenAI-compatible Provider、Secret Store、Project/Session/Message/Run、Primary Agent、Session Context、SSE 流式 Chat、Stop、Retry、错误处理、SQLite 历史恢复。验收标准是冷启动、首配、流式回复、重启后历史仍在。

不包含 Tool Calling、文件/Shell、审批、Workspace、Browser、Asset、Skills、Memory pipeline、Multi-Agent、Workflow 或 CLI。

## Phase 1A-2：System Tools

Rust File/Shell Service、Workspace 边界、read-only/workspace Profile、Chat Approval、短期 ApprovalGrant、Tool Trace、超时、取消和工具恢复。

## Phase 1B：Workspace Surfaces

异步 Workspace Indexer、文件树和统计、代码/文档查看器、Git Diff、Asset/Artifact Card、ResourceLink、安全 URL 系统浏览器打开和可选只读内嵌 Browser。均不阻塞 Chat。

## Phase 2：Agent Platform

Memory、Context Pipeline、Skills、MCP、Provider/Tool Plugins、Browser Tool 和更完整的资产检索。

## Phase 3：Multi-Agent Orchestration

Agent Registry、Worker/Research/Coding/Review Agent、顺序/并行/层级委派、Context 隔离、结构化结果聚合、预算和恢复。

## Phase 4：Workflow Engine

Node SDK、Workflow Definition、DAG 校验、调度、checkpoint、React Flow 画布以及 Asset/File/Document/Browser 节点。

## Phase 5：Multimodal Workflow

Prompt → Text-to-Image → Review → Image-to-Video → Export，媒体 Asset、异步任务、预览、版本和 ComfyUI Backend。

## Phase 6：Desktop Hardening

平台级 Rust Sandbox、插件隔离、资源限制、激活码许可（离线优先、设备绑定、宽限期与撤销）、签名、公证、自动更新、崩溃诊断、版本回滚和备份恢复。

## 跨阶段约束

- Chat Core 不依赖 Rust ready；工具能力依赖 Rust；
- 不做账号登录（仅云功能阶段引入）；激活码许可属 Phase 6，之前不实现任何授权门禁，`license.*`/`licensing`/`activation-required` 为保留命名；
- Event Log 是审计/通知输入，MVP 以 canonical tables 为准；
- 新阶段不得把后续能力反向塞入前一阶段；
- 所有用户可见操作必须有错误、取消或恢复语义；
- 旧 `ReflexionOS` 仅作参考，新项目不依赖旧 Python 服务。
