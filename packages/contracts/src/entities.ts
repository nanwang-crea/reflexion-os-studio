import { z } from 'zod'

export const IsoDateTimeSchema = z.iso.datetime()
export type IsoDateTime = z.infer<typeof IsoDateTimeSchema>

/** JSON 动态值：工具参数/结果等不预设结构的负载。 */
export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
)

/** 消息内容块：canonical 表示；媒体以引用进入，不内联原始数据。 */
export const TextPartSchema = z.object({
  type: z.literal('text'),
  text: z.string(),
})
export type TextPart = z.infer<typeof TextPartSchema>

export const ImagePartSchema = z.object({
  type: z.literal('image'),
  // 指向 Asset Store 的引用；原始媒体不进协议、数据库或上下文。
  assetId: z.string().min(1),
  mimeType: z.string().min(1),
})
export type ImagePart = z.infer<typeof ImagePartSchema>

export const ContentPartSchema = z.discriminatedUnion('type', [
  TextPartSchema,
  ImagePartSchema,
])
export type ContentPart = z.infer<typeof ContentPartSchema>

export const ProjectSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  // 项目对应的本地文件夹绝对路径；历史数据允许为空字符串。
  folderPath: z.string(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
})
export type Project = z.infer<typeof ProjectSchema>

export const SessionStatusSchema = z.enum(['active', 'archived'])
export type SessionStatus = z.infer<typeof SessionStatusSchema>

export const SessionSchema = z.object({
  id: z.string().min(1),
  // null 表示不关联任何项目的独立会话。
  projectId: z.string().min(1).nullable(),
  // 项目 Git 会话绑定的本地分支；独立会话或旧数据为 null。
  gitBranch: z.string().min(1).nullable(),
  title: z.string().min(1),
  status: SessionStatusSchema,
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
})
export type Session = z.infer<typeof SessionSchema>

export const MessageRoleSchema = z.enum(['user', 'assistant', 'system'])
export type MessageRole = z.infer<typeof MessageRoleSchema>

export const MessageStatusSchema = z.enum([
  'pending',
  'streaming',
  'completed',
  'interrupted',
  'failed',
])
export type MessageStatus = z.infer<typeof MessageStatusSchema>

export const MessageSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  runId: z.string().min(1).nullable(),
  role: MessageRoleSchema,
  content: z.string(),
  // canonical 内容块；content 是其中 text 块拼接的纯文本投影，仅供 UI 显示。
  parts: z.array(ContentPartSchema),
  // 推理模型的思考内容；非思考模型或旧数据为空字符串。
  reasoning: z.string(),
  status: MessageStatusSchema,
  createdAt: IsoDateTimeSchema,
  completedAt: IsoDateTimeSchema.nullable(),
})
export type Message = z.infer<typeof MessageSchema>

export const RunStatusSchema = z.enum([
  'created',
  'running',
  // Run 暂停等待用户审批工具调用；崩溃重启后恢复为 interrupted，不自动放行。
  'awaiting_approval',
  'completed',
  'failed',
  'cancelled',
  'interrupted',
])
export type RunStatus = z.infer<typeof RunStatusSchema>

/** 一次模型调用的 token 用量（Run/事件共用；历史 Run 可为 null）。 */
export const UsageSchema = z.object({
  promptTokens: z.number().int().nonnegative(),
  completionTokens: z.number().int().nonnegative(),
})
export type Usage = z.infer<typeof UsageSchema>

export const RunSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  status: RunStatusSchema,
  providerId: z.string().min(1).nullable(),
  model: z.string().min(1).nullable(),
  startedAt: IsoDateTimeSchema.nullable(),
  completedAt: IsoDateTimeSchema.nullable(),
  errorCode: z.string().nullable(),
  retryOfRunId: z.string().min(1).nullable(),
  // 执行该 Run 的 Agent；多 Agent 委派链路字段，Primary Agent 为 null。
  agentId: z.string().min(1).nullable(),
  parentRunId: z.string().min(1).nullable(),
  delegationId: z.string().min(1).nullable(),
  // 本次 Run 激活的 Skill（斜杠命令或显式传入）；未激活为 null。
  skillId: z.string().min(1).nullable(),
  // 全轮合计 token 用量（各模型轮累加）；进行中/旧数据为 null。
  usage: UsageSchema.nullable(),
})
export type Run = z.infer<typeof RunSchema>

export const ToolCallStatusSchema = z.enum([
  'pending',
  'awaiting_approval',
  'running',
  'completed',
  'failed',
  'cancelled',
])
export type ToolCallStatus = z.infer<typeof ToolCallStatusSchema>

export const ToolCallSchema = z.object({
  id: z.string().min(1),
  runId: z.string().min(1),
  // 发出该调用的 assistant 消息；无关联消息时为 null。
  messageId: z.string().min(1).nullable(),
  toolName: z.string().min(1),
  args: JsonValueSchema,
  result: JsonValueSchema.nullable(),
  status: ToolCallStatusSchema,
  errorCode: z.string().nullable(),
  // 关联的短期审批授权引用；不进事件 payload，不落审计日志。
  approvalGrantId: z.string().nullable(),
  createdAt: IsoDateTimeSchema,
  completedAt: IsoDateTimeSchema.nullable(),
})
export type ToolCall = z.infer<typeof ToolCallSchema>

/** Agent 可见工具操作类型；与 PERMISSION-MODEL 的审批维度一致。 */
export const ToolOperationSchema = z.enum([
  'file.read',
  'file.list',
  'file.glob',
  'file.grep',
  'file.write',
  'file.edit',
  'file.delete',
  'file.move',
  'file.mkdir',
  'shell.execute',
])
export type ToolOperation = z.infer<typeof ToolOperationSchema>

/** Agent 侧工具声明的 canonical 形式；provider 适配层投影为方言格式。 */
export const ToolSpecSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  // JSON Schema 形式的参数声明。
  parameters: JsonValueSchema,
})
export type ToolSpec = z.infer<typeof ToolSpecSchema>

/**
 * Skill manifest（元数据，不含 instructions 正文）。
 * Phase 1A 只允许内置 Skill；第三方安装/启停/Registry 属 Phase 2。
 * tools 为该 Skill 约定使用的工具名（信息性；实际可用性仍由 Run 装配与权限策略决定）。
 */
export const SkillManifestSchema = z.object({
  // 稳定引用：斜杠命令与 skill.use 都用它；小写字母/数字/连字符。
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  name: z.string().min(1),
  version: z.string().min(1),
  description: z.string().min(1),
  tools: z.array(z.string().min(1)),
  // 斜杠命令的参数占位提示；无参技能为 null。
  argumentHint: z.string().min(1).nullable(),
})
export type SkillManifest = z.infer<typeof SkillManifestSchema>

export const ProviderCapabilitySchema = z.enum([
  'chat',
  'embedding',
  'image',
  'video',
])
export type ProviderCapability = z.infer<typeof ProviderCapabilitySchema>

export const ProviderProfileSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  baseUrl: z.url(),
  // 该供应商下可选的模型列表；对话时可指定其中一个。
  models: z.array(z.string().min(1)).min(1),
  // 供应商提供的能力类型；决定该 Provider 可参与的负载（对话/向量/生图/生视频）。
  capabilities: z.array(ProviderCapabilitySchema),
  secretRef: z.string().min(1),
  enabled: z.boolean(),
  // 对话默认采样参数；null 表示未配置（沿用服务端默认）。
  temperature: z.number().min(0).max(2).nullable(),
  maxTokens: z.number().int().positive().nullable(),
  // 模型上下文窗口（token 数）；null 表示未知，Runtime 用保守默认预算。
  contextWindow: z.number().int().positive().nullable(),
  // 上下文预算上限（token 数）；null 表示用默认(64k)。
  contextBudget: z.number().int().positive().nullable(),
  updatedAt: IsoDateTimeSchema,
})
export type ProviderProfile = z.infer<typeof ProviderProfileSchema>

/** 记忆归属范围：session/project 绑定 scopeId，user 为跨项目长期记忆（null）。 */
export const MemoryScopeSchema = z.enum(['session', 'project', 'user'])
export type MemoryScope = z.infer<typeof MemoryScopeSchema>

export const MemoryKindSchema = z.enum(['fact', 'preference', 'procedure'])
export type MemoryKind = z.infer<typeof MemoryKindSchema>

export const MemoryStatusSchema = z.enum(['active', 'pinned', 'archived'])
export type MemoryStatus = z.infer<typeof MemoryStatusSchema>

/**
 * 记忆条目（A2 mem0 式管线）。embedding 向量不进协议：
 * 召回在 Runtime 内完成，协议只携带可读内容。
 */
export const MemorySchema = z
  .object({
    id: z.string().min(1),
    scope: MemoryScopeSchema,
    // scope=session 时为会话 id，scope=project 时为项目 id，scope=user 时为 null。
    scopeId: z.string().min(1).nullable(),
    kind: MemoryKindSchema,
    content: z.string().min(1),
    sourceRunId: z.string().min(1).nullable(),
    confidence: z.number().min(0).max(1),
    status: MemoryStatusSchema,
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
    // null 表示不过期；到期条目召回时跳过并可被清理。
    expiresAt: IsoDateTimeSchema.nullable(),
  })
  .superRefine((memory, ctx) => {
    // 交叉校验：session/project 必须可回溯到具体范围，user 必须全局。
    if (memory.scope === 'user' && memory.scopeId !== null) {
      ctx.addIssue({
        code: 'custom',
        path: ['scopeId'],
        message: 'user 级记忆的 scopeId 必须为 null',
      })
    }
    if (memory.scope !== 'user' && memory.scopeId === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['scopeId'],
        message: 'session/project 级记忆必须携带 scopeId',
      })
    }
  })
export type Memory = z.infer<typeof MemorySchema>

// ---------------- Workspace Surface (Phase 1B) ----------------

/** 文件树条目（Rust file.list 透传）：路径为 workspace 相对形状。 */
export const WorkspaceEntrySchema = z.object({
  path: z.string().min(1),
  kind: z.enum(['file', 'dir']),
  sizeBytes: z.number().int().nonnegative(),
})
export type WorkspaceEntry = z.infer<typeof WorkspaceEntrySchema>

export const WorkspaceIndexStatusSchema = z.enum([
  'idle',
  'scanning',
  'completed',
  'stale',
  'failed',
])
export type WorkspaceIndexStatus = z.infer<typeof WorkspaceIndexStatusSchema>

/** 按扩展名统计：ext 带点（.ts），无扩展名归 .bin 无法区分时归 "（无）"。 */
export const WorkspaceExtStatsSchema = z.object({
  ext: z.string().min(1),
  files: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative(),
})
export type WorkspaceExtStats = z.infer<typeof WorkspaceExtStatsSchema>

/**
 * 每项目一份的索引快照：version 单调递增，staleAt 表示"与磁盘不再一致"的时间
 * （按工作区根目录 mtime 推断），仅查询时计算、不落盘。
 */
export const WorkspaceIndexSnapshotSchema = z.object({
  projectId: z.string().min(1),
  status: WorkspaceIndexStatusSchema,
  version: z.number().int().nonnegative(),
  startedAt: IsoDateTimeSchema.nullable(),
  completedAt: IsoDateTimeSchema.nullable(),
  staleAt: IsoDateTimeSchema.nullable(),
  fileCount: z.number().int().nonnegative(),
  dirCount: z.number().int().nonnegative(),
  totalBytes: z.number().int().nonnegative(),
  extStats: z.array(WorkspaceExtStatsSchema),
  truncated: z.boolean(),
  error: z.string().nullable(),
})
export type WorkspaceIndexSnapshot = z.infer<
  typeof WorkspaceIndexSnapshotSchema
>

/** workspace.read_file 结果（Rust file.read 透传）。 */
export const WorkspaceReadResultSchema = z.object({
  content: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  totalLines: z.number().int().nonnegative(),
  offset: z.number().int().nonnegative(),
})
export type WorkspaceReadResult = z.infer<typeof WorkspaceReadResultSchema>

/** Git 变更类别：porcelain XY 聚合后的语义（Rust git.status 透传）。 */
export const GitChangeStatusSchema = z.enum([
  'modified',
  'added',
  'deleted',
  'renamed',
  'untracked',
  'conflicted',
])
export type GitChangeStatus = z.infer<typeof GitChangeStatusSchema>

/** Git 变更条目：path 为工作区相对路径；oldPath 仅 renamed 时存在（原路径）。 */
export const GitChangeEntrySchema = z.object({
  path: z.string().min(1),
  oldPath: z.string().optional(),
  status: GitChangeStatusSchema,
  staged: z.boolean(),
})
export type GitChangeEntry = z.infer<typeof GitChangeEntrySchema>

// ---------------- Asset / Artifact / ResourceLink（Phase 1B 第二阶段） ----------------

/** Asset 内容类别；mime 未知时归 file。 */
export const AssetKindSchema = z.enum([
  'image',
  'text',
  'audio',
  'video',
  'file',
])
export type AssetKind = z.infer<typeof AssetKindSchema>

/**
 * Asset 引用与元数据：内容存受控 Asset Store（数据目录 assets/<projectId>/，
 * 按项目隔离），库与事件只保存引用与元数据；大文件不进协议。
 */
export const AssetRefSchema = z.object({
  assetId: z.string().min(1),
  projectId: z.string().min(1),
  uri: z.string().min(1),
  kind: AssetKindSchema,
  mimeType: z.string().min(1),
  size: z.number().int().nonnegative(),
  hash: z.string().min(1),
  fileName: z.string().min(1),
  /** 导入时无 Run；Run 产出的 Asset 挂其 id。 */
  runId: z.string().nullable(),
  /** 多 Agent 阶段预留；当前恒 null。 */
  nodeRunId: z.string().nullable(),
  createdBy: z.enum(['user', 'agent']),
  createdAt: IsoDateTimeSchema,
  metadata: z.record(z.string(), z.unknown()),
  preview: z.enum(['ready', 'unsupported', 'failed']),
})
export type AssetRef = z.infer<typeof AssetRefSchema>

/**
 * 消息内资源导航引用（kind 判别联合）：不拥有内容，渲染为可点击卡片；
 * 目标类型决定分发——workspaceFile 进查看器定位行列、asset 进预览、
 * externalUrl 仅 https 进系统浏览器。
 */
export const ResourceLinkSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('workspaceFile'),
    uri: z.string().min(1),
    projectId: z.string().min(1),
    path: z.string().min(1),
    line: z.number().int().positive().optional(),
  }),
  z.object({
    kind: z.literal('asset'),
    uri: z.string().min(1),
    assetId: z.string().min(1),
  }),
  z.object({
    kind: z.literal('externalUrl'),
    uri: z.string().min(1),
  }),
])
export type ResourceLink = z.infer<typeof ResourceLinkSchema>

/** 一次 Run 的面向用户成果卡：聚合该 Run 消息中出现的资源引用。 */
export const ArtifactSchema = z.object({
  runId: z.string().min(1),
  title: z.string().min(1),
  links: z.array(ResourceLinkSchema),
  createdAt: IsoDateTimeSchema,
})
export type Artifact = z.infer<typeof ArtifactSchema>

/** 会话发送队列项：等待上一条回复结束时按 FIFO 自动发送。 */
export const QueueEntrySchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  content: z.string().min(1),
  providerId: z.string().min(1).nullable(),
  model: z.string().min(1).nullable(),
  permissionMode: z.enum(['workspace', 'read-only']).nullable(),
  skillId: z.string().min(1).nullable(),
  /** 0 起位置；出队发送时该项即消失。 */
  position: z.number().int().nonnegative(),
})
export type QueueEntry = z.infer<typeof QueueEntrySchema>

/** Agent 运行时全局设置：null 表示使用内置默认值。 */
export const AgentSettingsSchema = z.object({
  // 单次 Run 的最大模型调用轮次；超限如实失败。
  maxTurns: z.number().int().positive().max(64).nullable(),
  // 工具失败累计次数达到该值注入反思消息；0=禁用反思。
  reflectionThreshold: z.number().int().min(0).max(10).nullable(),
  // Provider 请求建立阶段失败(429/5xx/网络)自动重试次数。
  requestRetries: z.number().int().min(0).max(5).nullable(),
  // Provider 请求超时(秒)。
  requestTimeoutSec: z.number().int().min(10).max(600).nullable(),
})
export type AgentSettings = z.infer<typeof AgentSettingsSchema>

/** MCP server 配置与运行状态(enabled 开关;tools 为最新一次握手结果)。 */
export const McpServerSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  command: z.string().min(1),
  args: z.array(z.string()),
  env: z.array(z.object({ key: z.string().min(1), value: z.string() })),
  enabled: z.boolean(),
  /** 当前可用工具;未就绪为 []。 */
  toolCount: z.number().int().nonnegative(),
  status: z.enum(['disabled', 'ready', 'failed']),
  lastError: z.string().nullable(),
  updatedAt: IsoDateTimeSchema,
})
export type McpServer = z.infer<typeof McpServerSchema>

/** MCP 工具在协议层的声明(含来源 server,便于 UI 呈现)。 */
export const McpToolSchema = z.object({
  serverId: z.string().min(1),
  name: z.string().min(1),
  description: z.string().default(''),
  inputSchema: JsonValueSchema,
})
export type McpTool = z.infer<typeof McpToolSchema>
