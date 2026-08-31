# ReflexionOS Studio 分阶段路线图

## 当前状态（2026-08-31）

Phase 1A 全部完成；Phase 2 的技能（Skills）、记忆（Memory，会话/项目级）与 MCP 子集已完成，其余待办如下：
工具（`file.*`/`shell.execute`）、审批与权限 Profile、技能斜杠激活、记忆提取-合并-召回、MCP 工具桥（stdio,默认 ask 审批）均已接入对话链路与 UI。

## Phase 0：Architecture Foundation（已完成）

项目骨架、总体架构和协议边界文档。

## Phase 1A-0：Bootstrap（已完成）

Tauri 启动页、TypeScript Runtime 和 Rust sidecar 启动/监控、JSON-RPC 握手、状态展示和优雅关闭。Rust 未 ready 不阻塞 Chat。

## Phase 1A-1：Chat Core（已完成）

OpenAI-compatible Provider、Secret Store、Project/Session/Message/Run、Primary Agent、Session Context、SSE 流式 Chat、Stop、Retry、错误处理、SQLite 历史恢复。验收标准是冷启动、首配、流式回复、重启后历史仍在。

<span>注：上线范围已按后续阶段扩展——Tool Calling、文件/Shell、审批、Skills 与 Memory 均已实装（见 Phase 1A-2 / Phase 2）。</span>

## Phase 1A-2：System Tools（已完成）

Rust File/Shell Service、Workspace 边界、read-only/workspace Profile、Chat Approval、短期 ApprovalGrant、Tool Trace、超时、取消和工具恢复。

## Phase 1B：Workspace Surfaces（进行中）

- **已完成第一阶段（2026-08-31）**：异步 Workspace Indexer（纯 TS worker、progress/cancel/stale/failed 状态、忽略目录与符号链接、快照落库+版本号）、文件树（按需懒加载，经 Rust 侧 workspace 边界）、文件/文档查看器（行号、复制、跳转行、分段加载、Markdown/JSON 预览）、Git 变更面（`git.status`/`git.diff`：文件状态列表 + 单文件 diff 预览，只读查看与定位）、`workspace.*` 命令与白名单、工作区页面 UI。
- **已完成第二阶段（2026-08-31）**：Asset Store（数据目录隔离、sha256 元数据、导入/列表/预览/删除/复制引用，`asset.*` 命令）、ResourceLink（消息内 `workspace://`/`asset://`/https 引用渲染与点击分发——查看器定位行列、资产预览、系统浏览器安全打开）、Artifact 卡（Run 回复引用聚合展示）；导出/下载/系统应用打开留后续阶段（需权限）。
- **待完成**：安全 URL 系统浏览器打开（已就位，剩余只读内嵌 Browser 评估）。编辑、暂存、提交等 Git 写操作不在第一阶段,后续须经明确命令与权限策略。

## Phase 2：Agent Platform（进行中）

- **已完成子集**：Skills（内置技能注册表、斜杠激活、skill.use）、Memory（提取 → 合并 → 落库 → 召回注入、记忆管理页）、MCP（stdio 协议 client、管理服务、工具桥默认 ask 审批、设置页面板）。
- **待完成**：Provider/Tool Plugins、Browser Tool、user 级记忆写入确认流程、更完整的资产检索。

## Phase 3：Multi-Agent Orchestration（未开始）

Agent Registry、Worker/Research/Coding/Review Agent、顺序/并行/层级委派、Context 隔离、结构化结果聚合、预算和恢复。

## Phase 4：Workflow Engine（未开始）

Node SDK、Workflow Definition、DAG 校验、调度、checkpoint、React Flow 画布以及 Asset/File/Document/Browser 节点。

## Phase 5：Multimodal Workflow（未开始）

Prompt → Text-to-Image → Review → Image-to-Video → Export，媒体 Asset、异步任务、预览、版本和 ComfyUI Backend。

## Phase 6：Desktop Hardening（未开始）

平台级 Rust Sandbox、插件隔离、资源限制、激活码许可（离线优先、设备绑定、宽限期与撤销）、签名、公证、自动更新、崩溃诊断、版本回滚和备份恢复。

## 跨阶段约束

- Chat Core 不依赖 Rust ready；工具能力依赖 Rust；
- 不做账号登录（仅云功能阶段引入）；激活码许可属 Phase 6，之前不实现任何授权门禁，`license.*`/`licensing`/`activation-required` 为保留命名；
- Event Log 是审计/通知输入，MVP 以 canonical tables 为准；
- 新阶段不得把后续能力反向塞入前一阶段；
- 所有用户可见操作必须有错误、取消或恢复语义；
- 旧 `ReflexionOS` 仅作参考，新项目不依赖旧 Python 服务。
