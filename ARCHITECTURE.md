# ReflexionOS Studio 总体架构

## 1. 目标与非目标

ReflexionOS Studio 是对话驱动的桌面 Agent 平台。Primary 按目标自主规划、调用工具、动态委派并验证成果；角色模板预设职责与模型，协作 Skills 保存可复用的方法。独立 Workflow 编排已退役，历史实现保留在 codex/archive-workflow-2026-10-14。

第一阶段目标：可恢复的本地 Runtime、统一事件流、插件契约和安全工具边界。第一阶段非目标：复制 ComfyUI 全部节点、实现云端协作、一次性迁移所有旧功能。

## 2. 技术选型

| 层             | 技术                           | 职责                                                 |
| -------------- | ------------------------------ | ---------------------------------------------------- |
| UI             | React + TypeScript             | 对话、Plan、Tool Trace、Workspace 和 Agent 协作视图  |
| Desktop Host   | Tauri 2（第一阶段）            | 窗口、IPC、两个 sidecar 的 spawn/supervise、插件安装 |
| Agent Runtime  | Node.js + TypeScript           | Agent、Context、模型、工具编排、事件、恢复           |
| System Runtime | Rust（Phase 1）                | 文件、Shell、工具子进程和不可绕过的 enforcement      |
| Storage        | SQLite                         | canonical 业务状态、审计事件和资产/Workspace 索引    |
| Contracts      | TypeScript types + JSON Schema | 跨进程、插件和持久化协议                             |

Python 不进入新 Runtime 的核心路径，仅作为迁移期旧系统。

计划模式使用临时 Markdown 文档供审阅和编辑，审批绑定持久化正文快照；计划终态后按登记与内容摘要安全清理文件。详见 [计划模式设计](docs/PLAN-MODE.md)。

### 长文件写入与恢复

`file.write_stream` 的模型接口按文本块（`chunkIndex` / `title` / `content`）工作，
Runtime 管理 Rust staging 的 uploadId、字节偏移与 SHA-256。成功工具结果的 canonical
`ToolOutput.data` 保存版本化写入检查点；同一 Session、同一 workspace 内从历史恢复，
子 Agent 使用各自 Session，不共享上传句柄。检查点不依赖模型历史摘要，每轮任务上下文
投影活动写入的路径与下一块序号。重复 begin 返回现有进度；同序号同内容幂等，
不同内容或乱序拒绝；commit 后目标才原子可见。每次调用仍执行现有路径审批、mutation
coordinator 和 Rust revision 检查，恢复不恢复授权。macOS / Windows / Linux 复用同一
TS 状态机与既有 Rust 平台原子替换实现。进程崩溃在 Rust begin 成功与结果落库之间时，
可能留下未登记 staging；commit 成功但结果尚未落库时崩溃，也存在终态对账窗口，
不能声称跨 SQLite 与文件系统事务的 exactly-once。恢复仅使用已登记的成功检查点，
不通过扫描任意磁盘检查点接管其他 Session 的上传。模型接口适用于任意 UTF-8 文本，
不解析章节或文件格式；title 仅是可选进度标签。单块 ≤512KiB，单文件 ≤512MiB、
最多 4096 块；上下文只展示最近四块标签与下一序号，正文与句柄不回注。

文件编辑工具的 Provider schema 在顶层显式列出字段，同时保留由 Zod 派生的
批量/兼容分支校验；避免仅解析顶层 properties 的兼容服务把参数误认为空对象。
参数错误返回完整 JSON 结构示例，提示模型在 arguments 中实际传参；重复无效调用
仍由 Loop Guard 收敛：连续四次相同结果后先回传恢复提示，继续重放才终止；
成功的非幂等变更仍立即防重复执行。

### 聊天记录导入导出

用户从对话工具菜单导出当前会话到系统选择的目录，或选择 `.reflexion-chat.json`
备份导入为独立新会话、已有项目的新会话，或所选目录对应项目的新会话（未关联则建项目）。
版本化 `reflexion-chat` v1 JSON 最多 16MiB，包含消息、思考、消息图片和只读工具记录；
不包含工作区文件、子 Agent 独立会话、审批、Provider 配置、加密 continuation 或执行检查点。
导出拒绝运行中的会话；文件名为随机 UUID，Rust 侧独占新建，不覆盖文件。外部文件 IO 仅经
Rust `chat.archive`，限制后缀、大小、敏感目录与符号链接，三平台复用同一模块并显式处理
Unix nofollow 与 Windows reparse point。原始导出文件不作为任何执行授权。
导入先完整验证格式、消息与图片关联，再分配新 Session/Run/Message/ToolCall/Asset 标识；
工具结果重建为 canonical `ToolOutput` 的正文记录，不恢复工具私有 data、文件变更归属或权限。
会话历史在单个 SQLite 事务中恢复，图片失败时补偿删除本次会话与新建空项目；既有项目不删除。
两个 UI mutation 命令接入 operation receipt，超时不盲目重放。Windows/Linux 真机验收另列，
不把 macOS 验证推广为三平台已验收。

## 3. 进程与依赖关系

```text
Renderer (React)
   │ safe IPC: commands/events
Tauri Rust Host (Desktop Host / Supervisor)
   └── spawn/supervise → TypeScript Runtime
       （进程树监管：POSIX 进程组 / Windows Job Object 语义，兜底收割整棵树）

TypeScript Runtime
   ├── Agent / Context / Model / Tool orchestration
   ├── Product Policy Gateway
   ├── SQLite canonical state + minimal audit event log
   └── spawn/supervise → Rust System Runtime（JSON-RPC over stdio）
       ├── File Service
       ├── Shell Service
       ├── System Process Executor
       └── deny-by-default enforcement
```

进程归属：**TS Runtime 拥有 Rust System Runtime 的通道与生命周期**（spawn、握手、状态上报、
协议关停、有限重启）；Tauri Host 只 spawn TS，并在 env 中交接 Rust 二进制路径
（`REFLEXION_SYSTEM_RUNTIME_BIN`），保留进程树兜底收割权。TS 发出 `runtime.ready` 后向
Renderer 报告 Chat ready，Rust ready 不阻塞纯 Chat；系统可用性由 TS 以 `runtime.status`
事件第一手上报，Host 从协议流投影 `bootstrap:state` 快照给前端。Host 负责启动超时、
版本不兼容、TS 有限重启、关闭传播和 degraded 状态。Runtime 不依赖桌面宿主或 React。
Renderer 不直接访问 Provider、数据库或系统工具。TS Runtime 与 Rust 使用 JSON-RPC 2.0
over newline-delimited stdio；stdout 只传协议，stderr 只写日志。固定端口 HTTP 不是核心
通信方式，避免本机暴露面和端口冲突。

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
4. **协作 Skills 与角色模板**：声明式协作方法和可选角色指导；模型配置由用户决定，执行权限仍由 Runtime 强制。

每个插件使用 manifest 声明版本、能力、配置 schema 和权限。外部生成系统按 Provider/Tool 边界接入。

## 6. 事件与状态

`runtime_events` 是 append-only 的最小审计和 UI 通知日志，不是唯一事实源。sessions、runs、messages 等 MVP canonical 状态表直接由单一 Runtime 事务写入；MVP 不实现 outbox relay 或完整事件溯源。后续跨进程可靠投递时再增加 outbox。每个 Run 有稳定 ID；`message.delta` 只在内存/传输层流式发送，最终保存完整消息。

主要事件包括 `run.started`、`message.delta`、`tool.requested`、`approval.required`、`node.started`、`node.completed`、`run.failed` 和 `run.completed`。

## 7. 安全边界

工具/节点必须声明权限。TypeScript Policy Gateway 负责意图/风险分类、审批交互和一次/Session/Project 授权范围，但不是安全边界；它生成与 request、workspace、operation、资源 subjectDigest 和 TTL 绑定的授权上下文（权限模型 V2 见 `docs/PERMISSION-MODEL.md`）。Rust Enforcement 使用 deny-by-default 的严格 schema 校验 capability/approval token、实际路径、命令、cwd、环境和进程限制，并按实际请求重算 subjectDigest 复核；不接受任意 `authorized: true`，任何缺失、过期、范围不符或参数改变都拒绝。商业许可（激活码）与账号登录是独立的商业边界，不属于本 enforcement 体系，见 `docs/AUTH-AND-LICENSING.md`。

## 8. 存储边界

Runtime 的 SQLite 实现统一收敛在 `apps/runtime/src/store/`：根层负责连接、schema、迁移与共享设施，领域实现按 `chat/`、`agents/`、`integrations/`、`workspace/` 分组。业务层通过 `store/index.ts` 门面访问，避免 SQL 与具体 Store 路径扩散到 handler/agent。

- Definition：Agent 角色模板、Provider、Plugin 配置。
- Runtime：Session、Run、Node Run、Tool Call、Approval、Checkpoint。
- Event：不可变事件日志。
- WorkspaceFile：Workspace 中真实存在的文件实体，使用受保护的 workspace-relative path。
- Asset：Asset Store 中的内容存储实体，AI 生成媒体或导出内容使用 `AssetRef`。
- 多模态 Chat 的图片输入复用 Asset Store，并支持会话级资产与独立会话；消息仅持有 image 引用，Provider 调用边界才解析为原生图片块，设计见 [图片对话](docs/MULTIMODAL-CHAT.md)。
- Artifact：一次 Run 产生的面向用户的结果语义，可引用 Asset 或 WorkspaceFile。
- ResourceLink：UI 导航引用，不拥有内容，可指向 WorkspaceFile、Asset 或 ExternalUrl；由 Resource Router 决定查看器、Browser Surface 或系统打开方式。
- ToolOutput：工具结果的版本化 canonical envelope，同时保存回填模型的 `content`、结构化 `data`、`resourceLinks` 与 `changedFiles`。`tool_calls.result_json` 新记录统一写入该结构；旧任意 JSON 在 Store 读取边界按需包装，不做破坏性迁移。模型上下文与 Artifact UI 必须从同一 ToolOutput 投影，禁止各自猜测工具私有字段。
- Workspace：文件树、文件统计、代码/文档查看和 Git 摘要是按需/异步投影，不允许 UI 直接读取任意本地路径。

## 9. 依赖规则

允许：`contracts → all`、`SDK → plugins/runtime`、`runtime → contracts/SDK/storage`、`desktop → runtime-client`。

禁止：UI 直接调用 Provider；Agent 直接访问桌面宿主；Provider 管理 Session；Tool 自己决定审批；插件直接依赖数据库内部实现；领域模块通过全局可变状态通信。

## 10. 分阶段建设

新项目按产品能力逐阶段实现，而不是一次性铺开所有抽象。Phase 1A 以 TypeScript Runtime + Rust System Runtime 交付可用 Chat Core；Phase 1B 再增加不阻塞 Chat 的 Workspace Surfaces。后续依次建设 Agent Platform、Multi-Agent 协作与 Skills、多模态 Agent 和 Desktop Hardening。完整范围见 `docs/ROADMAP.md`。

Provider/Secrets、流式取消恢复、测试和分发边界分别见 `docs/PROVIDER-AND-SECRETS.md`、`docs/RELIABILITY-AND-RECOVERY.md` 和 `docs/TESTING-AND-DISTRIBUTION.md`。账号登录与商业许可（激活码）不在 MVP 范围，其阶段安排、验证位置和契约预留见 `docs/AUTH-AND-LICENSING.md`。

Agent、Memory、Skill、Context 和 Delegation/Policy 是一等领域，分别见 `docs/AGENT-MODEL.md`、`docs/MEMORY-SYSTEM.md`、`docs/SKILL-SYSTEM.md`、`docs/CONTEXT-MANAGEMENT.md`、`docs/MULTI-AGENT.md` 和 `docs/DELEGATION-AND-POLICY.md`。

旧 `../ReflexionOS` 仅作为参考，不是新项目的运行时依赖。新项目不为下线旧系统而设计兼容层；只有在复用已有经验能降低风险时才参考旧实现。

## 11. 架构验收标准

任何新能力都必须能说明：所属层、输入输出 schema、权限、事件、取消/重试语义、持久化边界和测试方式。核心模块超过约 300–500 行时应重新审视职责切分。详细协议见 `docs/`。

## 12. Agent Loop 内核与终态收敛（2026-09）

`packages/agent-core` 是纯 TypeScript 循环内核（不依赖 SQLite/Provider/Tauri）：完成状态机（finish reason × toolCalls 判定，protocol_error 不得假成功）、length 限次续写、Atomic Context Frames（工具轮不可拆）、请求前序列校验与 Loop Guard 指纹属于内核；持久化、副作用调度、资源冲突、预算执行和事件通知由 Runtime 承担。全部 Run 终态经唯一入口 `run-finalizer.ts` 在单事务内收敛（pending 消息、未终态 ToolCall、活动 Plan、Run 终态、失败事件、memory job 幂等入队），回调最多执行一次。Context 压缩走增量 Checkpoint（`context_checkpoints`，source hash 失效）+ 最近 Frame 保留；Memory 写入走持久化 `memory_jobs`（空闲 worker、可抢占、可恢复）。详见 `docs/CONTEXT-MANAGEMENT.md` 与 `docs/RELIABILITY-AND-RECOVERY.md`。

## 13. Terminal Surface（集成终端，Phase 2 · macOS 已验证，Windows/Linux 待真机）

项目级、多标签、跨页面保活的用户终端（xterm + portable-pty），设计规格见 `docs/superpowers/specs/2026-09-12-integrated-terminal-design.md`。与 Workspace/Asset 同属产品 Surface，但终端会话不落 SQLite、无历史回放承诺。

| 层                  | 职责                                                                       |
| ------------------- | -------------------------------------------------------------------------- |
| Rust System Runtime | PTY 与 shell 进程、输入队列、输出缓冲与受管理进程回收                      |
| TS Runtime          | 项目归属、终端元数据与幂等、资源额度、事件路由、输出公平调度               |
| 前端                | 标签、xterm 实例、面板状态（实例宿主在页面条件渲染之外，导航仅切换可见性） |
| Tauri Host          | 协议转发 + 进程树兜底监管，不承载终端业务                                  |

权限边界：用户终端与 Agent `shell.execute` 完全隔离——`terminal.*` 不注册为 Agent 工具，终端输入输出不进上下文、记忆或工具轨迹。

当前状态：**W0–W4 macOS 已验证**（切片/服务/面板/故障矩阵/性能门槛/打包冒烟，证据见 `docs/TERMINAL-SPIKE-REPORT.md`）；GUI 人工清单待执行（`docs/TERMINAL-GUI-ACCEPTANCE.md`）；Windows/Linux 待对应环境真机验收，不得宣称三平台完成。发布入口开关：构建期 `VITE_TERMINAL_DISABLED=1` 或运行期 localStorage `terminal.forceDisabled='1'`（重启生效）禁用新建终端入口，已打开的终端不受影响。

工作区 UI 的覆盖保存绑定具体读取快照：Runtime 为每次读取发放不透明 readToken，按工作区根目录、相对路径与完整读取状态校验。保存使用该快照的 revision，成功后返回新 token；其他预览或分页读取不能更新编辑器的保存凭据。凭据簿有界，淘汰或 Runtime 重启后须重新加载。Rust 仍执行磁盘 revision 校验，无 token 只可走新文件创建路径。

单次解除 Shell 沙箱：用户显式批准 `require_unsandboxed` 后，Rust 以当前用户身份直接执行命令；精确绑定、过期及一次性消费校验仍生效。该模式解除文件、敏感路径与网络的 OS 隔离，不受 preset、Danger 或会话规则自动授权。三平台执行方式及安全承诺例外见 `docs/PERMISSION-MODEL.md` §7.0。

## 14. CEF Browser Surface 与 Playwright Agent（2026-10-17）

Tauri 2 保留应用 Renderer 和宿主。macOS / Windows 默认构建将外部网页放进
CEF 原生子视图，页面不注册 Tauri IPC、应用协议或宿主脚本处理器。
Linux 暂不启用嵌入，明确回退系统浏览器；Windows 实现仍须真机验收。
开发依赖 CMake / Ninja；CEF 引擎、沙箱 helper / bootstrap 和许可随安装包分发。
产品只保留 CEF 一条网页嵌入路径：旧 WKWebView / WebView2 / WebKitGTK
网页适配器及其 registry、下载和弹窗实现已移除，旧 `browser-spike` feature
不再存在。无 CEF 构建明确返回 unavailable，不创建另一个网页引擎。
Tauri/Wry 的应用 Renderer 和原生密码界面继续保留；它们不承担外部网页浏览。

工作区、浏览器和协作共用右侧 Surface，放大/还原属于公共容器。
原生网页随测量到的视口、活动标签和弹层显隐；后台 WebView 暂停动画帧时也必须
继续同步页面状态和尺寸。事件合并采用有界一次性定时器，无空闲轮询。
CEF 消息泵由原生调度回调触发，并有有界延迟任务排空。

普通标签支持临时 / 独立持久存储。清理网站数据关闭普通标签并轮换存储，
同时重置其缓存；旧存储下次启动清除，Agent 标签不受影响。本地历史单独清理。
下载使用临时文件安全发布，拒绝覆盖及跨来源重定向。媒体权限当前拒绝；
旧 WKWebView 适配器已移除，其媒体能力不代表 CEF 已支持。macOS 凭据迁移和手动填充
仍是原生用户能力，凭据不进入 Runtime、Agent 或应用 IPC。

Agent 继续使用受管官方 Playwright MCP 与既有逐次审批、会话标签归属与快照引用、
正常网页请求、网页注入提示和受限脚本编译。页面快照不再进行整页凭据正则扫描，
不会因关键词匹配而拒绝正文或自动关闭浏览器。登录路径、输入内容、密码/验证码控件
不再按凭据特征拒绝；截图按当前网页可见内容捕获，不再遮罩输入控件与 iframe。浏览器沿用 Chromium 的系统网络配置，
不再通过应用本地出口代理或额外 DNS 公网检查；允许的域名可能解析到本机网络，
因此不提供仅公网隔离保证。web.fetch 的独立公网策略保持不变。CEF 可用时 Runtime 通过现有 stdio
的私有宿主请求取得会话专属临时页面租约；动态本机 CDP 端点不交给前端或模型。
MCP 只暴露租约页，禁止跨会话页面及上下文凭据访问。用户在同一标签接管时
断开 Agent 控制；交还后按原 TargetId 重新连接并刷新身份，保留人工修改。
关闭、Runtime 重启与应用退出会回收租约和子进程。

实现、构建方法和验收边界见 [CEF 接入](docs/CEF-BROWSER-INTEGRATION.md)。
旧 [B4 设计](docs/BROWSER-AGENT.md) 的独立 Chromium worker 保留为无 CEF
平台或无宿主 Runtime 的受控自动化后端，不承担用户 Browser Surface。
CEF 构建的 Runtime 固定连接宿主桥，即使 CEF 初始化失败也明确报错，不切换独立 Chromium。

协作 Surface 的成果优先试用边界见 [围绕成果的协作体验试用](docs/COLLABORATION-RESULTS-PILOT-2026-10-16.md)。

当前角色模型、作用范围与协作 Surface 设计见 [对话驱动的 Agent 协作](docs/AGENT-COLLABORATION-2026-10-14.md)。

### 角色库的分页与批量配置

角色库以可用容器宽度自适应排列卡片（至少一列），筛选结果每页最多 10 个。可选择本页自定义角色或当前筛选结果中的全部自定义角色；跨页保留选择，变更筛选时重置选择及页码。内置角色先复制后配置，单次批量最多 500 个。

`agent_template.bulk_update` 接收目标身份与 `updatedAt` 快照，以及仅包含显式修改字段的 patch。Runtime 从当前记录合并修改，在单个 SQLite 事务内校验全部目标、内置角色边界、并发变更与目标项目，再统一写入；任何错误整批回滚。项目可用范围和执行工作区继续保持原语义：角色可用项目并不授予文件权限，执行目录由当前任务决定。批量改动不会直接改变已有运行实例的权限快照。

角色库的单角色编辑和批量修改按需显示在右侧非模态面板，默认不占位。列表与编辑区分别滚动，卡片列数根据剩余可用宽度重新排列；不足以并排操作的窄窗口使用整宽编辑区，并隐藏左侧列表，防止键盘焦点落到被覆盖的控件。保存、取消或关闭后移除面板，单角色未保存修改与跨角色/模式切换保留丢弃确认；批量目标使用打开时的快照，筛选变化不会静默替换目标。

### 显式取消 Agent 累计预算

AgentSettings 保留数字/null 的默认语义，通过可选 `unlimitedLimits` 枚举列表明确取消 8 项应用级预算（详见 `docs/AGENT-RUNTIME-LIMITS.md`）。不限额配置不改变并发、深度、网络保护、权限审批、取消传播和 Loop Guard。Runtime 内部比较可用 Infinity，无运行总时长限制时不安装定时器；JSON、数据库和委派执行快照仅保存有限数字、null 与标志列表。委派树累计创建数和子任务 token/超时均在实际执行与展示快照中使用相同解析结果。

会话备份入口位于项目/独立会话行的右键菜单（同时支持键盘上下文菜单）。导出绑定右键会话 id，不切换当前会话；导入默认选中该会话所属项目并新建会话，不覆盖现有记录。无会话时在侧栏提供直接导入入口，顶栏面板工具菜单不再承载导入/导出。

### 角色关联技能与完整角色包

角色以技能 id 和加载方式关联统一技能库：按需优先提示模型通过 skill.use 加载，启动加载在创建执行实例时注入说明并冻结版本与指令。技能不可扩大工具权限，作用域与启用状态在保存及执行时校验。完整分享使用包含 role.json 与完整 skills/ 目录的 ZIP，预览确认后安装；同内容复用、冲突拒绝覆盖，失败清理本次新增技能。轻量 JSON 继续可用，模型绑定仍由接收方本地配置。范围与限制见 [角色技能设计](docs/AGENT-ROLE-SKILLS.md)。

角色批量删除与批量修改共用目标快照（id/updatedAt，最多 500 个）。前端列出名单并确认，Runtime 在单事务内先检查全部目标，再删除；内置角色、失效快照或任一失败均拒绝整批。仅删除模板，保留技能包、历史执行及运行中实例快照。

安装包在 beforeBundleCommand 阶段运行无窗口、无用户数据访问的二进制资源自检，缺失首页或入口 JS/CSS 时阻止打包。前端重建与宿主编译不得通过两条构建链并行操作同一输出目录，验收见 [安装包资源验收](docs/PACKAGING-ACCEPTANCE.md)。

### 可见浏览器操作语义（2026-10-18）

按用户明确决定，Agent 网页操作改为可见、可接管的正常浏览器行为。稳定 tabId 表示会话归属，pageVersion 表示一次观测而非整页冻结；read 原地更新快照和实际来源，不因异步 DOM 更新要求重导航。跨站导航、资源、重定向、POST 和 WebSocket 交给 Chromium；同一会话保留临时上下文。主页面仍只进入 HTTP(S)，应用自身内部来源与宿主文件/进程能力不开放。工具审批、会话隔离、用户接管、取消、时间/截图资源预算保留。导航失败保留已有标签，返回分类原因；失败后通过 read 或再次导航恢复，不自动重放操作。
