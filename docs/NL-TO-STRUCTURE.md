# 自然语言生成结构化定义（NL → Structure）

> 草案，待评审。设计"用自然语言生成结构化节点 / Agent 定义"的契约、管线、存储与验收标准。
> 领域依赖：`AGENT-MODEL.md`（AgentDefinition）、`MULTI-AGENT.md` 与 `DELEGATION-AND-POLICY.md`
> （委派与策略）、`WORKFLOW-ENGINE.md`（Workflow DAG）、`PLUGIN-SYSTEM.md`（节点插件）、
> `PERMISSION-MODEL.md`（权限模型）。本文件**不改变各阶段范围边界**（见 `ROADMAP.md`），
> 只是把"到 Phase 3/4 实现时才补 Schema"的风险提前收敛为可评审的契约设计。

## 1. 问题与定位

产品目标：用户用自然语言描述任务（例如"把这个目录下的中文文档逐个翻译成英文，再让另一个
Agent 复审"），系统生成**可校验、可人工审阅、可运行**的结构化执行定义：

- 一个或多个 `AgentDefinition`——每个节点作为一个 Agent，具备显式的输入/输出 schema、
  工具、Skill、权限与委派策略；
- 可选的一个 `WorkflowDefinition`——把上述 Agent 作为 AgentNode 编排为 DAG。

关键原则：**生成 ≠ 执行，生成 ≠ 授权**。自然语言生成的定义必须先通过结构校验与人工审阅
才能保存运行；生成物不自动获得任何超出声明的权限。

非目标：不实现自由格式的"AI 改代码自举"；不做生成物的自动运行与自动放行；不引入外部
生成服务（生成调用复用既有 Provider 配置，secret 纪律不变）。

## 2. 契约先行（contracts 唯一真源）

全部 schema 以 zod 定义在 `packages/contracts/src/`，TS 类型用 `z.infer` 派生，JSON Schema
用 `z.toJSONSchema` 导出（供生成时的 constrained decoding 与前端校验复用）；禁止在 schema
之外手写平行接口。跨平台无需平台分支（纯 JSON/TS）。

```ts
// 字段级 JSON Schema（draft 2020-12 子集），用于节点端口与生成目标结构
const JsonSchemaValue = z.record(z.unknown())

const IOPortSchema = z.object({
  key: z.string(),
  title: z.string(),
  required: z.boolean().default(false),
  schema: JsonSchemaValue,
})

const NodeIOSchema = z.object({
  inputs: z.array(IOPortSchema).default([]),
  outputs: z.array(IOPortSchema).default([]),
})

const AgentDefinitionSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().default(''),
  systemPrompt: z.string(), // 长文本 prompt 落定义文件/库，不内联进事件
  model: z.object({
    capability: z.literal('chat'),
    model: z.string().optional(), // 省略 = 会话缺省模型
  }),
  tools: z.array(z.string()), // 只能引用已注册工具命名（含 mcp__server__tool）
  skills: z.array(z.string()),
  io: NodeIOSchema,
  permissionPolicy: PermissionPolicySchema, // operation → automatic | ask | denied
  delegationPolicy: DelegationPolicySchema, // allowedAgentTypes / maxDepth / maxChildren / budgets / resultFormat
  memoryPolicy: MemoryPolicySchema,
  origin: z.enum(['builtin', 'nl-generated', 'manual']),
  version: z.number().int().positive(),
})

const NodeDefinitionSchema = z.discriminatedUnion('kind', [
  AgentNodeSchema, // { kind: 'agent', agentRef: agentDefinitionId, io }
  ToolNodeSchema, // { kind: 'tool', toolName, argsSchema }
  ProviderNodeSchema, // { kind: 'provider', capability, model }
  // 条件 / 人工审批 / 子工作流等控制节点枚举由 Phase 4 Workflow Node Plugin 决定，
  // Schema 留 discriminated union 扩展位，不在此提前固定。
])

const EdgeSchema = z.object({
  from: z.object({ node: z.string(), port: z.string() }),
  to: z.object({ node: z.string(), port: z.string() }),
})

const WorkflowDefinitionSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().default(''),
  nodes: z.array(NodeDefinitionSchema),
  edges: z.array(EdgeSchema),
  permissionPolicy: PermissionPolicySchema,
  budgets: BudgetsSchema, // 时长 / token / 工具调用数，沿用 Run 预算口径
  origin: z.enum(['builtin', 'nl-generated', 'manual']),
  version: z.number().int().positive(),
})
```

`PermissionPolicySchema` / `DelegationPolicySchema` 的字段取值以 `PERMISSION-MODEL.md` 与
`DELEGATION-AND-POLICY.md` 为准，本文件不重复定义。Agent 节点端口的 input/output schema
即该 Agent 的任务包输入与结构化结果输出——**端口的 Schema 校验就是 Agent 的结果契约**。

## 3. 生成管线（五段式，全部可取消、可审计）

```text
意图(utterance) → 生成(draft) → 结构校验 → 人工审阅 → 保存为新版本(落库)
```

1. **意图**：用户消息（或自动化任务描述）作为 `utterance`，可选约束（目标类型
   agent/workflow/auto、命名、语言等）。生成请求本身是一次普通 Run——复用既有 Run 的
   预算、取消、事件与恢复语义，不新造执行通道。
2. **生成**：模型按 `z.toJSONSchema` 导出的目标 schema 输出严格 JSON。Provider 支持
   structured output / JSON mode 则直接约束；不支持则降级为"文本 → 解析 → zod 校验 →
   失败携带错误重试（上限 2 次）→ 仍失败如实 `validation_failed`"，不假成功。
3. **结构校验**（确定性代码，不是模型判断）：
   - Schema 校验：zod parse + 未识别字段拒绝；
   - 引用校验：tools / skills / agentRef / provider capability 必须在注册表中存在；
   - DAG 校验：连通性、环检测、端口类型兼容（按 JsonSchemaValue 做结构兼容子集判定）；
   - 权限归一化：未显式声明的 operation 落 `denied`；定义中出现 `automatic` 声明时，
     保存阶段强制降级为 `ask`（见待决策项 D2），模型不得自授能。
4. **人工审阅**：前端以结构化卡片呈现生成物（节点列表、边、权限表、预算），允许编辑后
   再保存；未审阅通过的定义不落库、不可运行。
5. **保存**：写入 definition 表为新版本（单事务），状态 `draft → active`；旧版本转
   `archived` 保留，支持回看与恢复（对齐"删除、导出和重放均需保留审计语义"）。

## 4. 节点即 Agent：运行时映射

每个 AgentNode 的运行时实例 = 一次受控子 Run，完全复用 Phase 3 delegation 语义，
不新造第二套执行模型：

| 画布概念      | Runtime/存储对应                                                  |
| ------------- | ----------------------------------------------------------------- |
| AgentNode     | `delegations` 一行 + `runs` 子 Run（`agent_id` = 节点 agentRef）  |
| 输入端口      | 任务包（独立 Context，只携带任务所需信息，见 MULTI-AGENT）        |
| 输出端口      | 结构化 result，按端口 output schema 校验后传递给下游              |
| 根 Run        | Workflow 触发产生的 Run，`parent_run_id` 串出执行树               |
| 节点事件      | 沿用 `run.*` / `node.started` / `node.completed` / `delegation.*` |
| 取消/失败策略 | 父取消级联子取消；子失败按 DelegationPolicy 重试/降级/转人工      |

边界硬约束继续生效：子 Agent 权限 = 父策略 ∩ 自身声明，不可扩大；不默认继承全部工具与
长期记忆；深度/并发/token 预算上限；所有委派与结果进入事件日志。

## 5. 存储与迁移（schema v22，加法迁移）

延续 `apps/runtime/src/store/schema.ts` 的加法模式（参照 v17 agents/delegations、
v20 checkpoint/memory_jobs 的先例），v22 新增三表，升级只推进版本号、无回填：

```sql
CREATE TABLE agent_definitions (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,  -- NULL = 用户级（后开）
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  definition_json TEXT NOT NULL,   -- canonical AgentDefinition（schema 校验后落库）
  origin TEXT NOT NULL,            -- builtin | nl-generated | manual
  version INTEGER NOT NULL,
  status TEXT NOT NULL,            -- draft | active | archived
  source_generation_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE workflow_definitions (
  -- 同构：definition_json 存 canonical WorkflowDefinition（nodes/edges）。
);

CREATE TABLE definition_generations (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  session_id TEXT,
  run_id TEXT,                     -- 生成请求所在 Run（取消/恢复/预算的锚点）
  utterance TEXT NOT NULL,
  target TEXT NOT NULL,            -- agent | workflow | auto
  result_json TEXT,
  status TEXT NOT NULL,            -- validated | validation_failed | saved | discarded
  validation_errors_json TEXT,
  model TEXT NOT NULL,
  created_at TEXT NOT NULL
);
```

- canonical 状态 = definition 表；`definition_generations` 是生成过程的审计记录，可按
  保留策略裁剪，不承担恢复职责。
- 与现存 `agents` 表（v17，委派实验遗留）的关系见待决策项 D1。

## 6. 命令与事件

- 命令（经 runtime-client，白名单同步）：`definition.generate`（utterance + target +
  约束 → generationId + 校验结果）、`definition.save`（审阅后的定义 → 新版本）、
  `definition.list` / `definition.get` / `definition.delete`。生成与保存分离，
  中间强制人工审阅。
- 事件：`definition.validated` / `definition.saved` / `definition.discarded`，进入既有
  append-only 事件流（`protocolVersion`/`eventId`/`runId`/`seq` 语义不变）。utterance
  与定义正文不进事件 payload，事件只带 id 与摘要。

## 7. 安全边界

- 生成模型只能产出"声明"，产不出"权力"：即使定义声明 `automatic`，保存时降级 `ask`；
  运行期仍由 Policy Gateway（意图/审批）与 Rust Enforcement（deny-by-default 硬边界）
  双层把关，与 `PERMISSION-MODEL.md` 完全一致。
- `origin` 字段永久记录定义来源（`nl-generated`），供 UI 标注与审计。
- 生成 prompt 放 `agent/prompts/definition-generator.ts`（一个 prompt 一个文件）；
  utterance 按敏感内容纪律处理，不落日志正文、不进事件。

## 8. 分步计划（严格随 Phase 3 / Phase 4，不提前）

| 步骤 | 内容                                                                                                           | 阶段归属     |
| ---- | -------------------------------------------------------------------------------------------------------------- | ------------ |
| S1   | 契约：Agent/Permission/Delegation/Workflow Definition schema 进 contracts + JSON Schema 导出（纯契约，无行为） | Phase 3 前置 |
| S2   | Agent Registry：定义落库/启停/版本；`agents` 表演进或迁移（D1）                                                | Phase 3      |
| S3   | `task` 委派工具 + delegation 全套语义（权限交集/预算/级联取消）                                                | Phase 3      |
| S4   | Node SDK + WorkflowDefinition 校验/调度/checkpoint                                                             | Phase 4      |
| S5   | `definition.*` 命令 + 定义管理 UI（人工创建/编辑优先）                                                         | Phase 4      |
| S6   | NL 生成层：`definition.generate` + 生成 prompt + 审阅卡                                                        | Phase 4      |

依赖顺序即 S1 → S6；S6 是小步骤（生成层只是"LLM 按 contracts schema 产出 Definition +
走既有校验/审批链路"），因为地基（统一内核、node 事件、delegation 契约）在 S1–S4 已就位。
A6 自动化若需要"一句话建任务"，复用同一生成层，不另起炉灶。

## 9. 验收标准（对齐 ARCHITECTURE 第 11 节）

| 维度       | 要求                                                                                         |
| ---------- | -------------------------------------------------------------------------------------------- |
| 所属层     | Agent 平台扩展层；不碰 Rust 边界，不绕 runtime-client                                        |
| 输入输出   | utterance → Definition JSON；全部经 zod schema，JSON Schema 导出有单测锁定                   |
| 权限       | 未声明 → denied；automatic → ask 降级；审批语义与 Phase 1 权限模型一致                       |
| 事件       | definition.* 事件入流，payload 无正文                                                        |
| 取消/重试  | 生成是普通 Run：可取消、受预算约束、崩溃恢复落 interrupted；校验失败如实 `validation_failed` |
| 持久化边界 | definition 表为 canonical；generations 可裁剪；版本 archived 可回看                          |
| 测试       | schema 单测 + mock-provider 生成冒烟 + 校验失败路径 + 权限降级断言 + 三平台打包冒烟照常      |

## 10. 待决策清单

- **D1**：现存 `agents` 表（v17）是演进为 `agent_definitions`（迁移旧数据）还是并列新表、
  旧表只读保留一个版本。推荐：新表 + 一次性迁移，旧表只读退役。
- **D2**：`automatic` 是否允许出现在生成/人工定义中。推荐：不允许，保存时统一降级 `ask`。
- **D3**：生成入口用独立 `definition.generate` 命令还是 `message.send` 特殊 skillId。
  推荐：独立命令（生成是普通 Run，天然复用预算/事件/取消，且不污染对话语义）。
- **D4**：生成用模型：当前会话已配置 chat 模型起步；是否允许指定生成专用模型待评估。
- **D5**：定义 scope：项目级先行；用户级随 user 级记忆确认流程一并开放。
- **D6**：Workflow 节点首个枚举集合：推荐 agent + provider(chat) + tool 起步，媒体节点随 Phase 5。

## 11. 风险

- **生成质量**：靠确定性校验 + 人工审阅兜底，失败如实呈现，不做静默重试放宽。
- **提前实现诱惑**：S1 纯契约可先落，S2 起严格随 Phase 3；S6 之前不出现任何生成 UI。
- **Schema 漂移**：contracts 唯一真源 + `z.toJSONSchema` 导出单测，防止"文档一套、代码一套"。
