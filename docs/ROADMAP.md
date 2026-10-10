# ReflexionOS Studio 分阶段路线图

## 当前状态（2026-10-07）

Phase 1A 全部完成；Phase 2 的技能（Skills）、记忆（Memory V2，文件即记忆）与 MCP 子集已完成，其余待办如下：
工具（`file.*`/`shell.execute`）、审批与权限 Profile、技能斜杠激活、文件即记忆注入与 remember、MCP 工具桥（stdio,默认 ask 审批）均已接入对话链路与 UI。

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
- **已完成第二阶段（2026-08-31）**：Asset Store（数据目录隔离、sha256 元数据、导入/列表/预览/删除/复制引用，`asset.*` 命令）、ResourceLink（消息内 `workspace://`/`asset://`/https 引用渲染与点击分发——查看器定位行列、资产预览、系统浏览器安全打开）、会话变更文件列表（2026-10-07 收敛：仅汇总成功工具变更，文件/资产引用保留在正文，移除独立 Artifact 卡）；导出/下载/系统应用打开留后续阶段（需权限）。
- **待完成**：安全 URL 系统浏览器打开（已就位，剩余只读内嵌 Browser 评估）。Git 写操作已交付方案 A 子集（编辑器保存 + stage/unstage/commit/fetch/push/pull(--ff-only)/分支创建与切换，UI 直接动作免审批、内存脏 buffer 三键守卫），提交历史浏览（分页 log/commit 文件/diff/基于 commit 建分支与分离切换）与远程管理（remote 增删列表、远程分支检出为本地跟踪、发布=推送）已随增补批交付；剩余 discard/amend/stash/force-push/删远程分支/revert-reset 仍待后续,须经明确命令与权限策略（集成终端已作为 Phase 2 Terminal Surface 交付，见下）。

## Phase 2：Agent Platform（进行中）

- **已完成子集**：Skills（4 个内置技能、斜杠激活、skill.use）；Plugin Foundation（标准 `SKILL.md` 包 + 可选 `plugin.json` v1 扩展契约、能力/权限/兼容范围声明、本地文件与目录/工作区/Git HTTPS 安装、拖拽、预览确认、版本更新、原子替换与回滚、启停/卸载/隔离/状态持久化与管理 UI；旧 `<dataDir>/skills` 包启动迁移）；MCP（stdio 协议 client、管理服务、工具桥默认 ask 审批、设置页面板）。
- **已完成（2026-09，Memory V2 文件即记忆）**：AGENTS.md/MEMORY.md 四层注入 + memory.remember 免审批工具 + 指令页；A2 自动提取-合并-召回链路整体移除（v23 迁移删 memories/FTS/memory_jobs 表，不搬迁数据）；检索式记忆（mem0 直连原始对话数据）列为候选后续项。
- **已完成（2026-09，Agent Loop Hardening 与 Context Engine V2）**：完成状态机（只有 stop 且无工具才算完成；length 限次续写；provider_protocol 如实失败）、Atomic Run Finalizer（单事务终态收敛）、Atomic Frames 与请求前校验、副作用感知调度（read 并行/mutation 串行/ToolCall 批量预建）、Loop Guard（重复/无进展拦截）、Run 预算（时长/token/工具数/续写）、增量 Context Checkpoint（source hash/single-flight）、AgentSettings 新预算字段与设置页循环分组。
- **Terminal Surface（集成终端）**：设计与范围见 `docs/superpowers/specs/2026-09-12-integrated-terminal-design.md`，架构定位见 `ARCHITECTURE.md` §13。**W0–W4 macOS 已验证**（事件信封 1.1 与 terminal 契约冻结；portable-pty 纵向切片；后端多会话服务 + attach/ack/窗口背压/公平调度；前端多标签保活面板 xterm v6；故障矩阵 26/26、性能门槛 P0/P1/P2 实测全 PASS——见 `docs/TERMINAL-SPIKE-REPORT.md` §9/§11；打包冒烟见 §12）。**GUI 人工清单待执行**（`docs/TERMINAL-GUI-ACCEPTANCE.md`）；**Windows/Linux 待对应环境真机验收，不得宣称三平台完成**。发布入口开关：构建期 `VITE_TERMINAL_DISABLED=1`，或运行期 localStorage `terminal.forceDisabled='1'`（逃生舱，重启后生效）——禁用新建终端入口（顶栏按钮隐藏、create/recreate 拒绝），已打开的终端不受影响。`terminal.*` 不注册为 Agent 工具。
- **已完成（2026-09，权限模型 V2 / Codex 风格）**：`permissionMode + trusted` 双轨合并为三档 `PermissionPreset`（谨慎模式 / 工作区读写 / 工作区完全允许）+ 会话级 `ask-everything` 覆盖项 + 两段确认的 Danger 租约（capability fail-closed）；文件审批绑定"操作 + 工作区相对路径"精确资源、Shell 按 token 前缀会话规则（复合命令只允许一次）、工作区外走显式提权（escalated 档 + 提权根 digest 绑定）、网络授权收敛到 shell rule 维度；grant 升级 ApprovalGrantV2（source/subjectDigest/sandbox），Rust 按实际请求重算 digest 复核并落实 read-only/workspace-write/escalated 三档沙箱（macOS 真机验证，Linux 渲染完成待真机、Windows 提权沿用受限令牌待真机）；审批 UI 重构为单焦点队列 + choice 驱动（Runtime 下发 choices，前端只回传 choiceId）。协议 1.1→1.2（握手 fail-closed，legacy message.send 字段兼容一个版本）。设计见 `docs/PERMISSION-MODEL.md`。**Windows/Linux 运行时边界待对应真机验收；Danger 在 Linux（待真机）与 Windows（无可验证凭据守卫）保持 fail-closed，不得宣称三平台完成。**
- **待完成**：Provider/Tool Plugins（动态代码隔离模型确定后开放）、Browser Tool、检索式记忆（mem0 候选）、更完整的资产检索；权限规则持久化（当前刻意 session-only）与 Windows Danger credential guard spike。

## Phase 3：Multi-Agent Orchestration（进行中）

- **动态受控委派子集已完成**：Primary 通过 `task` 动态创建独立 Agent 实例；支持模板收窄、最大 4 层递归、整棵树共享的数量/并发/时间/token 预算、独立上下文与 Session、取消/恢复、结构化结果（摘要、资源链接、Changed Files、usage）及观测 UI。父 Run 可委派可写子 Agent，但权限、工具集和审批边界只能收窄；契约见 `docs/MULTI-AGENT.md`。
- **写入协调已完成**：根级 mutation coordinator 串行化兄弟写入；Rust 侧以 `mtime + size + sha256` revision 拒绝陈旧写；冲突返回 `file_revision_conflict`，成功变更记录 receipt 并聚合到 Changed Files。
- **仍待完成**：跨层树的完整续跑 checkpoint、更丰富的变更归属/冲突解决体验，以及更完整的撤销/preimage 治理；外部 delegation 生命周期写命令仍保持拒绝。

> 设计延伸：「自然语言生成结构化节点（每个节点作为一个 Agent）」的契约、生成管线、存储
> 与分步安排见 `docs/NL-TO-STRUCTURE.md`（草案，待评审）；其 S1–S3 随本阶段落地。

> 委派创建/终态写入仍只允许 Runtime 内部 `task` 链路，外部 `delegation.create/update/attach_child_run` 保持 unsupported；UI 仅可调用受控 `delegation.cancel`。`enableChildRuns=false` 是全局逃生开关。

## Phase 4：Workflow Engine（未开始）

Node SDK、Workflow Definition、DAG 校验、调度、checkpoint、React Flow 画布以及 Asset/File/Document/Browser 节点。NL 生成结构化定义（节点/Agent 的自然语言生成）按 `docs/NL-TO-STRUCTURE.md` 的 S4–S6 随本阶段落地。

## Phase 5：Multimodal Workflow（图片 Chat 子集已接入，Workflow 未开始）

图片 Chat 子集（2026-10-09 用户明确请求）：图片选择/粘贴、Asset 会话存储、消息预览、OpenAI Chat/Responses 与 Anthropic 原生视觉输入、历史/队列/重试/编辑重发；边界与验收见 [多模态 Chat](MULTIMODAL-CHAT.md)。

仍未开始：Prompt → Text-to-Image → Review → Image-to-Video → Export，媒体生成、音频/视频输入、异步任务、版本和 ComfyUI Backend。

## Phase 6：Desktop Hardening（未开始）

平台级 Rust Sandbox、插件隔离、资源限制、激活码许可（离线优先、设备绑定、宽限期与撤销）、签名、公证、自动更新、崩溃诊断、版本回滚和备份恢复。

## 跨阶段约束

- Chat Core 不依赖 Rust ready；工具能力依赖 Rust；
- 不做账号登录（仅云功能阶段引入）；激活码许可属 Phase 6，之前不实现任何授权门禁，`license.*`/`licensing`/`activation-required` 为保留命名；
- Event Log 是审计/通知输入，MVP 以 canonical tables 为准；
- 新阶段不得把后续能力反向塞入前一阶段；
- 所有用户可见操作必须有错误、取消或恢复语义；
- 旧 `ReflexionOS` 仅作参考，新项目不依赖旧 Python 服务。

计划模式支持临时 Markdown 方案、工作区审阅入口、审批快照与终态安全清理，属于现有 Chat 的交互与恢复能力，详见 [计划模式设计](PLAN-MODE.md)。
