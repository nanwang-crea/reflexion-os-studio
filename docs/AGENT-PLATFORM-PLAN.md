# Agent 主线实施规划

> 草案，待评审。本文编排 ROADMAP Phase 1A-2 → Phase 6 中"Agent 主线"的实施顺序与关键决策；
> 领域设计仍以 `AGENT-MODEL.md`、`MEMORY-SYSTEM.md`、`SKILL-SYSTEM.md`、`MULTI-AGENT.md`、
> `CONTEXT-MANAGEMENT.md`、`DELEGATION-AND-POLICY.md`、`PERMISSION-MODEL.md` 为准，本文不重复其内容，
> 只补"实施顺序、契约缺口和待决策项"。

## 1. 现状与差距

已落地：Chat Core（OpenAI-compatible 流式、SQLite canonical 状态、secret 纪律、取消/重试/恢复、
runtime-client 通道）。文档侧 Agent/Memory/Skill/Multi-Agent/权限模型均已定义。

进入 Agent 阶段前必须补齐的契约与实现缺口：

| #   | 缺口                                                    | 影响                                   |
| --- | ------------------------------------------------------- | -------------------------------------- |
| G1  | `provider.ts` 无 `tools` 参数、不解析 `tool_calls` 增量 | 无法进入工具循环                       |
| G2  | `Message.content` 只有 string                           | 装不下工具调用、图片、结构化内容       |
| G3  | Run 生命周期 = 一次模型调用                             | Agent 一次 Run 需要多轮模型/工具交替   |
| G4  | 无 token 预算与上下文组装管线                           | 工具输出与历史会撑爆上下文             |
| G5  | Rust System Runtime 只有 ping/shutdown                  | File/Shell 工具与 enforcement 尚不存在 |
| G6  | Provider 无能力元数据                                   | 选不了 embedding/vision/生图模型       |
| G7  | 审批无持久化状态机                                      | 审批等待、崩溃恢复、超时语义缺失       |

## 2. 阶段总览

```text
A0 契约升级 → A1 Agent Core(工具循环+文件/Shell) → A2 Memory → A3 Skills+MCP
→ A4 Multi-Agent → A5 Multimodal → A6 Automation → A7 计算机控制扩展
```

与 ROADMAP 映射：A1 ≈ Phase 1A-2；A2/A3 ≈ Phase 2；A4 ≈ Phase 3；A5 ≈ Phase 5；
A6 位于 Phase 2/4 之间；A7 为新增阶段。顺序即依赖：每一层是上一层的消费者
（工具循环依赖契约；记忆与技能寄生在循环上；委派是"task 工具"；多模态与自动化复用同一 Run 管线）。

## 3. A0：契约与消息模型升级（一切的地基）——已落地

- **Message 引入 content blocks**：新增 canonical `parts: Array<text | image>`（image 以
  `assetId` 引用 Asset，不内联数据）；`content` 保留为 text 块拼接的纯文本投影。工具调用
  **只在 `tool_calls` 表保存 canonical 记录**，消息块不重复存 tool_use/tool_result，避免双份
  表示漂移。旧数据已按"一次性迁移"回填（v3 → v4：content → 单 text part，协议版本递增）。
- **canonical 模型与 provider 方言分离**：DB 存 provider 无关的 blocks；provider 适配层负责投影成
  OpenAI wire format（`tools` function 数组 / tool_calls 增量按 index 聚合），为将来
  Anthropic 等方言留位。
- **新增 tool_calls 表**：`id / runId / messageId / toolName / args / result / status /
errorCode / grantId`；Run 增加 `agentId / parentRunId / delegationId`（兑现 AGENT-MODEL 的
  持久化预留）与 `awaiting_approval` 状态（同属进行中；启动恢复落 `interrupted`，不自动放行；
  未完结 tool_calls 一律 `cancelled`）。
- **ProviderProfile 能力声明**：provider 级 `capabilities`（chat / embedding / image / video），
  `provider.configure` 可选传入，编辑省略保留原值、新建缺省 `['chat']`。per-model 元数据
  （vision、contextWindow）推迟到 A5 实际需要时再加。
- **事件**：`tool.requested`、`tool.completed`、`approval.required`、`approval.resolved`
  （契约固定，A1 开始发出）。

## 3.1 多模态链式扩展：为什么图→视频能平滑接上

"文生图 → 图生视频"这类链式负载能否平滑扩展，取决于 A0 固定的四个不变量：

1. **媒体按引用流动，永不内联**：内容块里的 image part 只带 `assetId` + `mimeType`，原始媒体
   存 Asset Store（见 ASSET-AND-RESOURCE-MODEL）。生图产物落 Asset，图生视频的输入是同一
   `AssetRef`——链路上下游传的是引用，上下文、协议和数据库都不驮大文件。将来加 video part
   （`assetId` + 时长/分辨率元数据）只是给 discriminated union 加一个成员，一次迁移即可。
2. **能力类型可组合**：ProviderProfile.capabilities 已声明 chat / embedding / image / video；
   一个供应商可同时声明多种能力，"生图 Provider 的输出 → 生视频 Provider 的输入"在 Runtime
   内就是两次 capability 调用 + 一个 Asset 引用的传递，不需要新的通信机制。
3. **产物有归属**：每次 Run 的媒体产物记录 `runId / nodeRunId / createdBy`，下游步骤（Agent
   工具循环或 Workflow 节点）按引用取上游产物；这正是 WORKFLOW-ENGINE 里
   `Prompt → Text-to-Image → Review → Image-to-Video → Export` 预定义 DAG 的数据基础。
4. **两条执行路径共用同一表示**：Agent 循环里图作为 tool_result 回填（自迭代
   "生成→查看→修改"），Workflow 画布里图作为节点端口传递——两者都用同一 content part /
   AssetRef 模型，不会出现"聊天一套媒体协议、画布一套媒体协议"。

> **定位澄清**：图→视频这类链式负载的主要产品形态是 **Workflow 节点画布**——用户可拖拽
> 拼接节点的图编辑界面（网格/连线式，对标 ComfyUI），属 Phase 4 Workflow Engine，
> 届时提供独立入口，不与 Chat 入口混用。Agent 对话循环中的多模态只是复用同一套
> content part / AssetRef 表示，两条路径互不绑定、互不阻塞。

## 4. A1：Agent Core —— 工具循环 + 文件/Shell + 审批

> 进展：**A1 已完成**——`packages/agent-core`（runAgentLoop / ToolRegistry / compactMessages）+
> runtime `agent/` 拆分（prompts / context / permissions / tools / runner / 门面）+
> TS↔Rust 通道（方案 A）+ **Rust File/Shell Service 与 enforcement**（路径规范化/符号链接/
> 体量/超时/树杀/grant 存在性检查）+ 审批闭环（approval.required → 审批卡 → approval.resolve →
> ApprovalGrant；Run awaiting_approval 语义）+ 真实工具冒烟（提问 → 读工作区文件 → 汇报；
> 提问 → 审批 → 写文件 → 汇报）。

- **`packages/agent-core` 已落地**：
  - `AgentLoop`：模型调用 → tool_calls → 执行 → 结果回填 → 循环，直到模型不再请求工具
    （任务完成）或达到轮次上限（如实失败为 max_turns）；每轮可取消、可审计；
    流式事件穿透到 UI；循环不持有工具列表（工具声明由注入的模型调用方投影）。
  - `ToolRegistry`：工具以 JSON Schema 声明 + 注册表统一执行；未知工具/非法参数折叠为
    isError 结果回传模型自纠（unsupported / invalid_request / tool_error），
    不打断 Run；TS 工具与 Rust 工具同一接口。
  - `compactMessages`：长会话压缩（见下）。
- **长会话压缩（本轮已落地）**：Run 启动时从 canonical 存储重建历史（含工具方言），
  超出 token 预算（CJK≈1 token/字，其余 4 字符 1 token 估算）时把保留窗口之外的旧消息
  交给压缩 prompt 做一次摘要调用，摘要以"[历史摘要]"user 消息接在 system 后；
  摘要失败退化为截断，不阻塞对话。压缩只在 Run 启动时发生，Run 内不再重算；
  跨 Run 的摘要缓存与按模型 contextWindow 动态预算属 A2/Memory。
- **Prompt 管理（本轮已落地）**：`agent/prompts/` 一个 prompt 一个文件
  （primary-agent / compactor），新增 Agent 或 Skill 的 prompt 各自成文件。
- **待做——Rust System Runtime 实现 File/Shell Service**（G5）：
  workspace-relative 路径规范化、`..`/符号链接拒绝、shell cwd 锁定、超时、输出上限、
  进程树回收（Windows 用 Job Object 兜底，见第 12 节跨平台红线）。
- **待做——审批闭环**（PERMISSION-MODEL 全套）：`tool.requested → approval.required → 审批卡
(Allow once / Allow for session / Deny) → ApprovalGrant → 执行`；Policy Gateway 与 Rust
  Enforcement 职责分离。崩溃恢复策略：重启后遗留的 `awaiting_approval` Run 一律自动拒绝并
  记事件（宁可拒绝不自动放行；存储层已按 interrupted + tool_calls cancelled 落地）。
- **前端**：Tool Trace 卡片（数据已就绪：session.get 返回会话内全部 toolCalls）；
  纯工具轮次的空 assistant 消息已不在聊天流渲染。
- **验收（已通过）**：mock-provider tool_calls 回放走"提问 → 调工具 → 结果回填 → 汇报"全链路；
  Rust 工具接入后补"提问 → 读文件 → 汇报"场景。

## 5. A2：Memory —— mem0 式管线，完全本地化

> 进展：**A2 核心管线已落地**——`memories` 表（v5 迁移，FTS5 trigram 索引 + Float32 BLOB 向量）
>
> - Runtime `agent/memory/` 拆分（extractor / merge / recall / service / filter / similarity）
> - Provider `/embeddings` 客户端与 embedding 能力解析 + Run 完成后异步提取
>   （LLM 候选抽取 → 机密形态过滤 → 相似比对 + LLM 合并决策 ADD/UPDATE/SUPERSEDE/NOOP →
>   事务落库 → 向量补算 → `memory.written` 事件）+ ContextBuilder 混合召回注入
>   （FTS 关键词 + embedding 余弦 + recency 衰减，pinned 置顶，无 embedding 自动降级）
> - 记忆管理页（按 scope 分组、编辑/固定/删除、`memory.list/update/delete` 命令）。
>   待做：User(Long-term) 级 propose→confirm 流程（当前提取器不产出 user 候选）、
>   按模型 contextWindow 动态预算、召回效果调优、sqlite-vec 预留位评估。

采用 mem0 的"提取 → 合并 → 存储 → 召回"管线，但**不引入外部向量库或独立服务**，全部收敛在
Runtime + SQLite：

- **提取**：Run 完成后异步 LLM 抽取候选事实（不含 secret 纪律敏感内容；提取前过敏感词过滤）。
- **合并决策**：与既有记忆比对，产生 ADD / UPDATE / SUPERSEDE / NOOP；scope 决定确认策略——
  Session 级自动写入，Project 级自动写入但可在记忆页撤销，User(Long-term) 级先确认（对齐
  MEMORY-SYSTEM 的 propose→confirm）。
- **存储**：`memories` 表（id / scope: session|project|user / kind: fact|preference|procedure /
  content / sourceRunId / confidence / createdAt / expiresAt / status），附 FTS5 全文索引。
- **召回**：ContextBuilder 注入时混合排序：FTS5 关键词 + embedding 余弦 + recency 衰减，
  受 token 预算约束。
- **Embedding**：Provider 增加 embedding 能力（OpenAI-compatible `/embeddings`）；
  **无 embedding 模型时自动降级**为 FTS + recency，功能可用性不依赖向量。
- **向量规模**：桌面级数千条记忆直接内存余弦即可；预留 sqlite-vec 扩展位，不预先引入。
- **UI**：记忆管理页（按 scope 分组、编辑/删除/固定）；写入提示走事件而非弹窗打断。
- 与 mem0 生态的互操作（如 OpenMemory MCP）留待 MCP 阶段之后评估。

## 6. A3：Skills + MCP

- **Skill 采用 SKILL.md 目录格式**（对齐业界 Claude Agent Skills 的 progressive disclosure 实践，
  替代早期"manifest 校验"占位）：frontmatter（name / description / allowed-tools / 版本）+
  正文指令 + 可选资源文件。描述（短）常驻 system prompt，正文（长）按需加载。
- **两级发现**：用户级 `<数据目录>/skills/` 与项目级 `<workspace>/.reflexion/skills/`。
- **边界**：Skill 只能引用已注册 Tool，不得绕过 Tool/Policy 直访系统；Skill 自带脚本默认按
  `shell.execute` 同级权限走审批，MVP 可先禁脚本。
- **MCP Client（Runtime 内，stdio transport 优先）**：外部 MCP server 的 tools 注册进
  ToolRegistry，命名空间 `mcp__<server>__<tool>`；权限按 server 粒度映射 automatic/ask/denied。
  HTTP/SSE transport 后续再开。MCP 是第三方工具生态的标准适配器，不再自造协议。
- 生命周期命令（list / enable / disable / install）+ 管理页。

## 7. A4：Multi-Agent —— 委派即工具

- **`task` 委派工具**（subagent 模式而非 handoff 控制权转移，与 MULTI-AGENT.md 的
  delegationId 协议一致）：Primary Agent 调 `task(agentId, 任务包)` → 子 Run → 结构化结果返回。
- **Agent Registry**：内置 Primary / Worker / Research / Coding / Review 定义存 DB，可自定义；
  `AgentDefinition`（模型/工具/Skill/Memory/Permission/Delegation Policy）开始真实生效。
- **硬约束落地**：子 Agent 权限 = 父策略 ∩ 自身声明；独立 Context 只携带任务包；深度/并发/
  token 预算上限；父取消级联子取消。
- **UI**：委派树事件视图（delegation tree），展示每个子 Run 的工具调用与结果。

## 8. A5：Multimodal 与生图

A0 的 content blocks 与能力声明在此兑现：

- **图片输入**：聊天粘贴/上传 → Asset（复用 ASSET-AND-RESOURCE-MODEL）→ image part →
  vision 模型；Provider 侧投影 OpenAI `image_url` parts。
- **生图**：Provider image 能力（OpenAI-compatible images API 起步），异步任务事件化，
  产出 Asset → Artifact Card 进聊天流。
- **多模态工具循环**：图作为 tool_result 回填，Agent 可"生成 → 查看 → 修改"自迭代；
  ComfyUI Backend 与视频按 ROADMAP Phase 5 原计划。

## 9. A6：Automation（自动化任务）

- **任务模型**：`tasks` 表（触发器：一次性 / 间隔 / cron、prompt 或 agentId、启用状态、
  最后执行）。
- **调度器**：TS Runtime 内（纯 Node 计算 cron，无新依赖）。**诚实边界：应用打开时才调度**；
  错过的一次性任务在启动时提示是否补跑。系统级后台服务明确不做（与 sidecar 生命周期冲突）。
- **执行**：复用同一 Agent/Run 管线 headless 运行；完成走系统通知（Tauri notification）+
  应用内收件箱。
- 复杂编排类自动化交给 Phase 4 Workflow Engine，不在此阶段提前实现 DAG。

## 10. A7：计算机控制扩展（浏览器 / 屏幕）

平台成本高，单列阶段、逐平台交付：

- **浏览器控制先行**：CDP 驱动系统 Chrome/Edge（三平台行为一致），页面读取/点击/填表作为
  工具暴露，域名白名单进权限策略。
- **屏幕控制**：截图 + 无障碍树操作。三平台后端不同（macOS AX + 权限申请 / Windows UIA /
  Linux AT-SPI），必须显式分支实现，逐平台验收；审批语义独立于文件工具（更敏感）。

## 11. Agent 作为 SDK：两步走

1. **内部 SDK（A1 即达成）**：`packages/agent-core` = Agent 循环 + Tool 接口 + Context/
   Memory/Skill 接口。runtime 是第一个消费者；`apps/cli`（占位已留）做成第二个消费者——
   CLI 能跑通即证明 SDK 边界成立，也是无 GUI 冒烟的载体。对外 npm 发布等 API 稳定后再评估。
2. **扩展 SDK / 插件（A3 起成型）**：第三方扩展统一走 contracts + JSON Schema + MCP 适配器，
   不自造协议；`plugin-sdk` / `node-sdk` 占位届时再实装。

收益：Chat、CLI、自动化任务、Workflow 节点复用同一个 Agent 内核，避免"画布一套、聊天一套"。

## 12. 跨平台红线（每阶段的强制检查项）

- 路径一律 `Path::join` / `node:path`；工具参数中的路径以 workspace-relative 为准。
- 进程生命周期：Windows 无 SIGTERM，优雅关闭必须走协议/Job Object，信号只兜底。
- Shell 工具：POSIX sh 与 Windows（cmd/PowerShell）显式分支，命令转义规则分开写。
- 三平台各跑一次冒烟（macOS 开发，CI 矩阵补 Windows/Linux）。

## 13. 待决策清单

1. ~~content blocks 迁移：一次性迁移还是双读兼容~~ **已决策：一次性迁移（v4），已落地。**
2. 崩溃时 `awaiting_approval` Run 的恢复策略（推荐：重启自动拒绝 + 事件说明）——存储层已按
   `interrupted` + tool_calls `cancelled` 落地，审批拒绝事件随 A1 补齐。
3. 工具大输出的处理：截断阈值 + 落盘为文件/Asset 引用的界限。
4. 记忆默认写入策略：Project 自动+可撤销、User 需确认（推荐）是否成立。
5. Embedding 缺失时的降级体验是否可接受（推荐：FTS+recency 兜底）。
6. 跨 Session 并行 Run：放开 per-session idle 限制的时机与 UI 呈现。
7. 自动化任务是否需要在应用未开时补跑（推荐：仅提示，不自动补跑）。
8. Skill 脚本的 MVP 边界：禁用（推荐）还是按 shell 权限审批。
9. Per-Run token/费用硬上限（usage 已采集，何时开始生效）。
10. MCP server 安装来源与信任模型（本地配置 vs 内置市场）。
11. ~~TS↔Rust 通道归属~~ **已决策：方案 A——TS Runtime spawn 并监管 Rust**（握手、
    状态上报、有限重启、协议关停），Host 收窄为 spawn TS + 进程树兜底收割
    （POSIX 进程组 / Windows 树杀），二进制路径经 `REFLEXION_SYSTEM_RUNTIME_BIN`
    环境变量交接。已落地，见 M0-BOOTSTRAP。
12. ~~是否直接内置 mem0 内核替代自研管线~~ **已评估（A2 落地后）：暂不内置**。
    mem0 官方 TS OSS SDK（`mem0ai`）虽已支持本地模式，但：持久化向量存储全部
    需要外接服务（qdrant/pgvector/redis/milvus 等，唯一免服务选项是 in-memory，
    重启即丢记忆），与"完全本地化、无外部服务"红线冲突；LLM/embedder 的自定义
    OpenAI-compatible baseUrl 未见文档支持（我们的用户都配自有兼容端点）；其
    自带 history SQLite + 向量库会形成双库双 schema，scope/pin/编辑等管理语义
    均需桥接仿真。收益面（提取/合并的 prompt 工程）恰是已按其算法自实现的部分。
    接缝保留：MemoryService 已收在窄接口后；A3 MCP 阶段可经 OpenMemory MCP
    接入 mem0 生态，届时再评估。
