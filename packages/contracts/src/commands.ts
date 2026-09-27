import { z } from 'zod'
import {
  MessageSchema,
  RunEventSchema,
  ProviderCapabilitySchema,
  ProviderProfileSchema,
  ProjectSchema,
  RunSchema,
  SessionSchema,
  SkillManifestSchema,
  PluginRecordSchema,
  ToolCallSchema,
  WorkspaceEntrySchema,
  WorkspaceIndexSnapshotSchema,
  WorkspaceReadResultSchema,
  GitChangeEntrySchema,
  GitChangeStatusSchema,
  ChangedFileSchema,
  AssetRefSchema,
  QueueEntrySchema,
  AgentSettingsSchema,
  McpServerSchema,
  McpToolSchema,
  PlanSchema,
  AgentDefinitionSchema,
  AgentTemplateSchema,
  MutationReceiptSchema,
  DelegationSchema,
  TerminalSchema,
  PermissionPresetSchema,
  ApprovalOverrideSchema,
  ExecutionModeSchema,
  ApiFormatSchema,
} from './entities.js'
import { PluginTaskSchema } from './plugins.js'
import {
  DangerAccessLeaseSchema,
  DangerCapabilitySchema,
} from './permissions.js'
import { RuntimeStatusSchema } from './handshake.js'
import {
  UserInteractionResponseSchema,
  UserInteractionSchema,
} from './interactions.js'

export const RequestIdSchema = z.string().min(1)
export type RequestId = z.infer<typeof RequestIdSchema>

const PluginInstallParamsSchema = z.discriminatedUnion('source', [
  z.object({
    requestId: RequestIdSchema,
    source: z.literal('dir'),
    projectId: z.string().min(1),
    path: z.string().min(1),
  }),
  z.object({
    requestId: RequestIdSchema,
    source: z.literal('local'),
    path: z.string().min(1),
  }),
  z.object({
    requestId: RequestIdSchema,
    source: z.literal('git'),
    url: z.string().url(),
  }),
])

export const MessageSendParamsSchema = z.object({
  requestId: RequestIdSchema,
  sessionId: z.string().min(1),
  content: z.string().min(1),
  // 不传则使用启用的 Provider 及其第一个模型。
  providerId: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  // 本次回复的模型采样参数；缺省用 Provider 配置的默认值。
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().positive().optional(),
  // 本次发送的权限预设快照；缺省 workspace-read（保守回落，不静默扩大写权限）。
  permissionPreset: PermissionPresetSchema.optional(),
  // @deprecated 兼容一个协议版本：legacy `permissionMode`/`trusted` 双轨。
  // 新前端不再发送；Runtime 按下表映射（workspace/read-only→workspace-read、
  // trusted=true→workspace-full），冲突时新字段优先。下一协议版本删除。
  permissionMode: z.enum(['workspace', 'read-only']).optional(),
  trusted: z.boolean().optional(),
  // 显式激活的 Skill；内容以 /<skillId> 开头时也可隐式激活（显式优先）。
  skillId: z.string().min(1).optional(),
  // 用户显式指定本次根 Run 的默认子 Agent 模板；优先于模型在 task 中的选择。
  agentTemplateId: z.string().min(1).optional(),
})
export type ChatCommand = z.infer<typeof MessageSendParamsSchema>

/** 消息编辑重发命令参数。 */
export const MessageEditResendParamsSchema = z.object({
  requestId: RequestIdSchema,
  sessionId: z.string().min(1),
  messageId: z.string().min(1),
  content: z.string().min(1),
  // 可选覆盖 Provider/模型/参数（与 message.send 同义）。
  providerId: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().positive().optional(),
  permissionPreset: PermissionPresetSchema.optional(),
  skillId: z.string().min(1).optional(),
  agentTemplateId: z.string().min(1).optional(),
})
export type MessageEditResendParams = z.infer<
  typeof MessageEditResendParamsSchema
>

/** 消息编辑重发结果。 */
export const MessageEditResendResultSchema = z.object({
  queued: z.boolean(),
  messageId: z.string().min(1).nullable(),
  runId: z.string().min(1).nullable(),
  queueId: z.string().min(1).nullable(),
  position: z.number().int().nonnegative().nullable(),
})
export type MessageEditResendResult = z.infer<
  typeof MessageEditResendResultSchema
>

/**
 * 审批裁决：只接受 toolCallId + choiceId。choiceId 必须属于当前 pending
 * approval，Runtime 据此查服务端保存的真实 effect；旧的 decision + scope
 * 不再作为权威输入。
 */
export const ApprovalResolveParamsSchema = z.object({
  requestId: RequestIdSchema,
  toolCallId: z.string().min(1),
  choiceId: z.string().min(1),
})
export type ApprovalResolveCommand = z.infer<typeof ApprovalResolveParamsSchema>

export const RunCancelParamsSchema = z.object({
  requestId: RequestIdSchema,
  runId: z.string().min(1),
})
export type CancelCommand = z.infer<typeof RunCancelParamsSchema>

export const RunRetryParamsSchema = z.object({
  requestId: RequestIdSchema,
  runId: z.string().min(1),
})

export const CommandSchemaRegistry = {
  'runtime.get_status': {
    params: z.object({ requestId: RequestIdSchema }),
    result: RuntimeStatusSchema,
  },
  'project.list': {
    params: z.object({ requestId: RequestIdSchema }),
    result: z.object({ projects: z.array(ProjectSchema) }),
  },
  'project.create': {
    params: z.object({
      requestId: RequestIdSchema,
      // 项目必须绑定一个本地文件夹（由宿主文件夹选择器提供）。
      folderPath: z.string().min(1),
      name: z.string().min(1).optional(),
    }),
    result: z.object({ project: ProjectSchema }),
  },
  'session.list': {
    params: z.object({
      requestId: RequestIdSchema,
      // 省略 → 全部会话；null → 独立会话；具体 id → 该项目下的会话。
      projectId: z.union([z.string().min(1), z.null()]).optional(),
    }),
    result: z.object({ sessions: z.array(SessionSchema) }),
  },
  'session.create': {
    params: z.object({
      requestId: RequestIdSchema,
      // null / 省略 → 独立会话（不关联项目）。
      projectId: z.union([z.string().min(1), z.null()]).optional(),
      title: z.string().min(1).optional(),
      // Deprecated legacy input: accepted by the wire schema for old clients,
      // then rejected by Runtime so new sessions cannot claim a branch switch.
      gitBranch: z.string().min(1).nullable().optional(),
    }),
    result: z.object({ session: SessionSchema }),
  },
  'session.rename': {
    params: z.object({
      requestId: RequestIdSchema,
      sessionId: z.string().min(1),
      title: z.string().min(1),
    }),
    result: z.object({ session: SessionSchema }),
  },
  'session.execution_mode.set': {
    params: z.object({
      requestId: RequestIdSchema,
      sessionId: z.string().min(1),
      mode: ExecutionModeSchema,
    }),
    result: z.object({ session: SessionSchema }),
  },
  'session.delete': {
    params: z.object({
      requestId: RequestIdSchema,
      sessionId: z.string().min(1),
    }),
    result: z.object({ removed: z.boolean() }),
  },
  'project.delete': {
    params: z.object({
      requestId: RequestIdSchema,
      projectId: z.string().min(1),
    }),
    // 项目删除级联其下会话（会话再级联消息与 Run）。
    result: z.object({ removed: z.boolean() }),
  },
  'session.get': {
    params: z.object({
      requestId: RequestIdSchema,
      sessionId: z.string().min(1),
    }),
    result: z.object({
      session: SessionSchema.nullable(),
      messages: z.array(MessageSchema),
      runs: z.array(RunSchema),
      // 会话内全部工具调用（跨 Run 汇总），供 UI 呈现工具轨迹。
      toolCalls: z.array(ToolCallSchema),
      // 会话内全部计划（跨 Run 汇总），供 UI 呈现计划轨迹。
      plans: z.array(PlanSchema),
      // 运行事件（重试/失败）。旧版 Runtime snapshot 缺该字段：默认空数组，
      // 避免响应校验失败导致整个会话数据被丢弃（前端消息消失）。
      runEvents: z.array(RunEventSchema).default([]),
    }),
  },
  'message.send': {
    params: MessageSendParamsSchema,
    // 会话空闲时立即发送(queued=false,带 messageId/runId);
    // 会话忙碌时自动入队(queued=true,带 queueId/position)。
    result: z.object({
      queued: z.boolean(),
      messageId: z.string().min(1).nullable(),
      runId: z.string().min(1).nullable(),
      queueId: z.string().min(1).nullable(),
      position: z.number().int().nonnegative().nullable(),
    }),
  },
  'message.edit_resend': {
    params: MessageEditResendParamsSchema,
    result: MessageEditResendResultSchema,
  },
  'queue.list': {
    params: z.object({
      requestId: RequestIdSchema,
      sessionId: z.string().min(1),
    }),
    result: z.object({
      items: z.array(QueueEntrySchema),
      // 队列是否处于暂停待确认态；可选：旧版 runtime 缺该字段。
      paused: z.boolean().optional(),
    }),
  },
  'queue.update': {
    // 修改排队中消息的内容(斜杠技能随新内容重新解析)。
    params: z.object({
      requestId: RequestIdSchema,
      sessionId: z.string().min(1),
      queueId: z.string().min(1),
      content: z.string().min(1),
    }),
    result: z.object({ item: QueueEntrySchema.nullable() }),
  },
  'queue.remove': {
    params: z.object({
      requestId: RequestIdSchema,
      sessionId: z.string().min(1),
      queueId: z.string().min(1),
    }),
    result: z.object({ removed: z.boolean() }),
  },
  'queue.send_now': {
    // 立即发送:移该项到队首,当前空闲则立刻开始执行。
    params: z.object({
      requestId: RequestIdSchema,
      sessionId: z.string().min(1),
      queueId: z.string().min(1),
    }),
    result: z.object({ accepted: z.boolean() }),
  },
  'queue.resume': {
    // 解除用户停止 Run 后的队列暂停；若会话空闲且队列非空则立即出队发送。
    params: z.object({
      requestId: RequestIdSchema,
      sessionId: z.string().min(1),
    }),
    result: z.object({ resumed: z.boolean() }),
  },
  'agent.list': {
    params: z.object({ requestId: RequestIdSchema }),
    result: z.object({ agents: z.array(AgentDefinitionSchema) }),
  },
  'agent.set_enabled': {
    params: z.object({
      requestId: RequestIdSchema,
      agentId: z.string().min(1),
      enabled: z.boolean(),
    }),
    result: z.object({ agent: AgentDefinitionSchema }),
  },
  'agent_template.list': {
    params: z.object({ requestId: RequestIdSchema }),
    result: z.object({ templates: z.array(AgentTemplateSchema) }),
  },
  'agent_template.save': {
    params: z.object({
      requestId: RequestIdSchema,
      id: z.string().min(1).optional(),
      name: z.string().min(1).max(80),
      description: z.string().max(500),
      systemPrompt: z.string().min(1).max(20_000),
      enabled: z.boolean(),
      canDelegate: z.boolean(),
      allowedTools: z.array(z.string().min(1)),
    }),
    result: z.object({ template: AgentTemplateSchema }),
  },
  'agent_template.remove': {
    params: z.object({
      requestId: RequestIdSchema,
      templateId: z.string().min(1),
    }),
    result: z.object({ removed: z.boolean() }),
  },
  'delegation.list': {
    params: z.object({
      requestId: RequestIdSchema,
      sessionId: z.string().min(1),
    }),
    result: z.object({ delegations: z.array(DelegationSchema) }),
  },
  'delegation.create': {
    params: z.object({
      requestId: RequestIdSchema,
      sessionId: z.string().min(1),
      parentRunId: z.string().min(1),
      agentId: z.string().min(1),
      task: z.string().min(1),
    }),
    result: z.object({ delegation: DelegationSchema }),
  },
  'delegation.list_by_parent': {
    params: z.object({
      requestId: RequestIdSchema,
      parentRunId: z.string().min(1),
    }),
    result: z.object({ delegations: z.array(DelegationSchema) }),
  },
  'delegation.tree': {
    params: z.object({
      requestId: RequestIdSchema,
      rootRunId: z.string().min(1),
    }),
    result: z.object({ delegations: z.array(DelegationSchema) }),
  },
  'mutation_receipt.list': {
    params: z.object({
      requestId: RequestIdSchema,
      rootRunId: z.string().min(1),
    }),
    result: z.object({ receipts: z.array(MutationReceiptSchema) }),
  },
  'delegation.get_by_child_run': {
    params: z.object({
      requestId: RequestIdSchema,
      childRunId: z.string().min(1),
    }),
    result: z.object({ delegation: DelegationSchema.nullable() }),
  },
  'delegation.cancel': {
    params: z.object({
      requestId: RequestIdSchema,
      delegationId: z.string().min(1),
    }),
    result: z.object({ accepted: z.boolean() }),
  },
  'delegation.attach_child_run': {
    params: z.object({
      requestId: RequestIdSchema,
      delegationId: z.string().min(1),
      childRunId: z.string().min(1),
    }),
    result: z.object({ delegation: DelegationSchema }),
  },
  'delegation.update': {
    params: z.object({
      requestId: RequestIdSchema,
      delegationId: z.string().min(1),
      status: z.enum([
        'pending',
        'running',
        'completed',
        'failed',
        'cancelled',
      ]),
      result: z.string().nullable().optional(),
      error: z.string().nullable().optional(),
    }),
    result: z.object({ delegation: DelegationSchema }),
  },
  'agent_settings.get': {
    params: z.object({ requestId: RequestIdSchema }),
    result: z.object({ settings: AgentSettingsSchema }),
  },
  'agent_settings.update': {
    // 全量覆盖:未提供的字段置 null(回默认),前端草稿整体提交。
    params: z.object({
      requestId: RequestIdSchema,
      settings: AgentSettingsSchema,
    }),
    result: z.object({ settings: AgentSettingsSchema }),
  },
  'mcp.list': {
    params: z.object({ requestId: RequestIdSchema }),
    result: z.object({
      servers: z.array(McpServerSchema),
      tools: z.array(McpToolSchema),
    }),
  },
  'mcp.add': {
    params: z.object({
      requestId: RequestIdSchema,
      name: z.string().min(1),
      command: z.string().min(1),
      args: z.array(z.string()),
      env: z.array(
        z
          .object({
            key: z.string().min(1),
            secret: z.string().optional(),
            secretRef: z.string().min(1).optional(),
          })
          .refine(
            (entry) =>
              entry.secret !== undefined || entry.secretRef !== undefined,
            {
              message: 'env entry requires secret or secretRef',
            },
          ),
      ),
    }),
    result: z.object({ server: McpServerSchema }),
  },
  'mcp.remove': {
    params: z.object({
      requestId: RequestIdSchema,
      serverId: z.string().min(1),
    }),
    result: z.object({ removed: z.boolean() }),
  },
  'mcp.toggle': {
    params: z.object({
      requestId: RequestIdSchema,
      serverId: z.string().min(1),
    }),
    result: z.object({ server: McpServerSchema }),
  },
  'mcp.reload': {
    // 重新握手全部已启用的 server(配置变更/修复失败后手动重连)。
    params: z.object({ requestId: RequestIdSchema }),
    result: z.object({ servers: z.array(McpServerSchema) }),
  },
  'run.cancel': {
    params: RunCancelParamsSchema,
    result: z.object({ accepted: z.boolean() }),
  },
  'run.retry': {
    params: RunRetryParamsSchema,
    result: z.object({
      messageId: z.string().min(1),
      runId: z.string().min(1),
      retryOfRunId: z.string().min(1),
    }),
  },
  'approval.resolve': {
    params: ApprovalResolveParamsSchema,
    // accepted=false 表示该调用不在等待审批（已解决/已取消）。
    result: z.object({ accepted: z.boolean() }),
  },
  'interaction.respond': {
    params: UserInteractionResponseSchema.extend({
      requestId: RequestIdSchema,
    }),
    result: z.object({ accepted: z.boolean() }),
  },
  'interaction.list_pending': {
    params: z.object({ requestId: RequestIdSchema }),
    result: z.object({ interactions: z.array(UserInteractionSchema) }),
  },
  // ---------- 权限模型 V2：高级审批覆盖项与 Danger 会话租约 ----------
  // 覆盖项仅当前会话内存生效、不持久化；Runtime 是唯一真源。
  'permission.approval_override.set': {
    params: z.object({
      requestId: RequestIdSchema,
      sessionId: z.string().min(1),
      override: ApprovalOverrideSchema,
    }),
    result: z.object({ override: ApprovalOverrideSchema }),
  },
  'permission.approval_override.get': {
    params: z.object({
      requestId: RequestIdSchema,
      sessionId: z.string().min(1),
    }),
    result: z.object({ override: ApprovalOverrideSchema }),
  },
  // 两段式确认：prepare 签发单次消费的 challenge（≤60s、绑定 sessionId），
  // enable 必须携带 acceptedRisk=true 且通过平台 capability 校验。
  'danger.prepare': {
    params: z.object({
      requestId: RequestIdSchema,
      sessionId: z.string().min(1),
    }),
    result: z.object({
      challengeId: z.string().min(1),
      expiresAt: z.number().int().nonnegative(),
      warning: z.string(),
      capability: DangerCapabilitySchema,
    }),
  },
  'danger.enable': {
    params: z.object({
      requestId: RequestIdSchema,
      challengeId: z.string().min(1),
      acceptedRisk: z.literal(true),
    }),
    result: z.object({ lease: DangerAccessLeaseSchema }),
  },
  'danger.disable': {
    params: z.object({
      requestId: RequestIdSchema,
      sessionId: z.string().min(1),
    }),
    result: z.object({ disabled: z.boolean() }),
  },
  // 前端重挂/重载后与 Runtime 对齐 lease 状态（Runtime 是唯一真源）。
  'danger.status': {
    params: z.object({
      requestId: RequestIdSchema,
      sessionId: z.string().min(1),
    }),
    result: z.object({ lease: DangerAccessLeaseSchema.nullable() }),
  },
  'provider.list': {
    params: z.object({ requestId: RequestIdSchema }),
    result: z.object({ profiles: z.array(ProviderProfileSchema) }),
  },
  'provider.configure': {
    params: z.object({
      requestId: RequestIdSchema,
      id: z.string().min(1).optional(),
      name: z.string().min(1),
      baseUrl: z.url(),
      models: z.array(z.string().min(1)).min(1),
      // 只写字段：明文 Key 仅在请求中出现一次，runtime 落入本地 secret 存储，
      // profile 只返回 secretRef。任何响应/事件/日志不得包含 secret。
      secret: z.string().min(1).optional(),
      // 编辑且不换 Key 时必须回传既有 secretRef。
      secretRef: z.string().min(1).optional(),
      // 供应商能力类型；省略时编辑保留原值、新建为 ['chat']。
      capabilities: z.array(ProviderCapabilitySchema).optional(),
      // API 协议格式；省略时编辑保留原值、新建为 'openai-chat'。
      apiFormat: ApiFormatSchema.optional(),
      // 对话默认采样参数；省略=保留原值，null=清空回未配置。
      temperature: z.number().min(0).max(2).nullable().optional(),
      maxTokens: z.number().int().positive().nullable().optional(),
      // 模型上下文窗口（token 数）；省略=保留原值，null=清空。
      contextWindow: z.number().int().positive().nullable().optional(),
      // 上下文预算上限（token 数）；省略=保留原值，null=清空(默认 64k)。
      contextBudget: z.number().int().positive().nullable().optional(),
      enabled: z.boolean().optional(),
    }),
    result: z.object({ profile: ProviderProfileSchema }),
  },
  'provider.delete': {
    params: z.object({
      requestId: RequestIdSchema,
      id: z.string().min(1),
    }),
    result: z.object({ removed: z.boolean() }),
  },
  'provider.test': {
    params: z.object({
      requestId: RequestIdSchema,
      baseUrl: z.url(),
      model: z.string().min(1),
      // 测试请求的明文 Key 只在内存中使用一次，不落盘。
      secret: z.string().min(1).optional(),
      secretRef: z.string().min(1).optional(),
      // API 协议格式；省略时默认 'openai-chat'。
      apiFormat: ApiFormatSchema.optional(),
    }),
    result: z.object({
      ok: z.boolean(),
      latencyMs: z.number().int().nonnegative(),
      model: z.string().min(1),
      error: z.string().nullable(),
    }),
  },
  'instructions.get': {
    // 指令页读取单个文件；path 为 null 表示当前条件下没有该文件位置。
    params: z.object({
      requestId: RequestIdSchema,
      scope: z.enum(['global', 'project']),
      projectId: z.string().min(1).optional(),
      kind: z.enum(['agents', 'memory']),
    }),
    result: z.object({
      path: z.string().nullable(),
      content: z.string(),
    }),
  },
  'instructions.save': {
    // 指令页保存（原子替换）；项目级 AGENTS.md 会写入用户仓库根。
    params: z.object({
      requestId: RequestIdSchema,
      scope: z.enum(['global', 'project']),
      projectId: z.string().min(1).optional(),
      kind: z.enum(['agents', 'memory']),
      content: z.string(),
    }),
    result: z.object({ ok: z.boolean(), message: z.string() }),
  },
  'skill.list': {
    // 内置 Skill 清单（Phase 1A 无安装/启停，列表即全部可用项）。
    params: z.object({ requestId: RequestIdSchema }),
    result: z.object({ skills: z.array(SkillManifestSchema) }),
  },
  'plugin.list': {
    params: z.object({ requestId: RequestIdSchema }),
    result: z.object({ plugins: z.array(PluginRecordSchema) }),
  },
  'plugin.install': {
    params: PluginInstallParamsSchema,
    result: z.object({ task: PluginTaskSchema }),
  },
  'plugin.preview': {
    params: PluginInstallParamsSchema,
    result: z.object({ task: PluginTaskSchema }),
  },
  'plugin.update': {
    params: z.object({ requestId: RequestIdSchema, id: z.string().min(1) }),
    result: z.object({ task: PluginTaskSchema }),
  },
  'plugin.task.list': {
    params: z.object({ requestId: RequestIdSchema }),
    result: z.object({ tasks: z.array(PluginTaskSchema) }),
  },
  'plugin.task.cancel': {
    params: z.object({ requestId: RequestIdSchema, taskId: z.uuid() }),
    result: z.object({ task: PluginTaskSchema }),
  },
  'plugin.toggle': {
    params: z.object({
      requestId: RequestIdSchema,
      id: z.string().min(1),
      enabled: z.boolean(),
    }),
    result: z.object({ plugin: PluginRecordSchema }),
  },
  'plugin.uninstall': {
    params: z.object({ requestId: RequestIdSchema, id: z.string().min(1) }),
    result: z.object({ removed: z.boolean() }),
  },
  'plugin.rescan': {
    params: z.object({ requestId: RequestIdSchema }),
    result: z.object({ plugins: z.array(PluginRecordSchema) }),
  },
  // ---------- Phase 1B：Workspace Surface ----------
  'workspace.index.start': {
    params: z.object({
      requestId: RequestIdSchema,
      projectId: z.string().min(1),
    }),
    result: z.object({ accepted: z.boolean() }),
  },
  'workspace.index.cancel': {
    params: z.object({
      requestId: RequestIdSchema,
      projectId: z.string().min(1),
    }),
    result: z.object({ accepted: z.boolean() }),
  },
  'workspace.index.status': {
    params: z.object({
      requestId: RequestIdSchema,
      projectId: z.string().min(1),
    }),
    // 从未索引过返回 null；stale 状态由查询时按根目录 mtime 推导。
    result: z.object({ snapshot: WorkspaceIndexSnapshotSchema.nullable() }),
  },
  'workspace.list_dir': {
    params: z.object({
      requestId: RequestIdSchema,
      projectId: z.string().min(1),
      // 工作区相对目录；缺省 "."（根），只允许相对路径。
      path: z.string().optional(),
      // 分页续读：与 path 一起透传 file.list；缺省按服务端默认页大小返回。
      offset: z.number().int().nonnegative().optional(),
      limit: z.number().int().nonnegative().optional(),
    }),
    result: z.object({
      entries: z.array(WorkspaceEntrySchema),
      // 稳定排序后仍有后续页或触达遍历硬上限时为 true，用 nextOffset 续读。
      truncated: z.boolean(),
      returnedCount: z.number().int().nonnegative(),
      // 仍有后续内容时给出下一次请求的偏移量；无后续内容时省略。
      nextOffset: z.number().int().nonnegative().optional(),
    }),
  },
  'workspace.watch_dir': {
    params: z.object({
      requestId: RequestIdSchema,
      projectId: z.string().min(1),
      path: z.string().min(1),
    }),
    result: z.object({ watchId: z.string().min(1) }),
  },
  'workspace.unwatch_dir': {
    params: z.object({
      requestId: RequestIdSchema,
      watchId: z.string().min(1),
    }),
    result: z.object({ removed: z.boolean() }),
  },
  'workspace.search_files': {
    params: z.object({
      requestId: RequestIdSchema,
      projectId: z.string().min(1),
      query: z.string().min(1),
    }),
    result: z.object({
      entries: z.array(WorkspaceEntrySchema),
      truncated: z.boolean(),
    }),
  },
  'workspace.read_file': {
    params: z.object({
      requestId: RequestIdSchema,
      projectId: z.string().min(1),
      path: z.string().min(1),
      offset: z.number().int().nonnegative().optional(),
      limit: z.number().int().nonnegative().optional(),
    }),
    result: WorkspaceReadResultSchema,
  },
  'workspace.read_binary': {
    params: z.object({
      requestId: RequestIdSchema,
      projectId: z.string().min(1),
      path: z.string().min(1),
    }),
    result: z.object({
      dataBase64: z.string(),
      sizeBytes: z.number().int().nonnegative(),
      mimeType: z.string().min(1),
    }),
  },
  'workspace.git_status': {
    params: z.object({
      requestId: RequestIdSchema,
      projectId: z.string().min(1),
    }),
    // repo=false 表示目录不是 Git 仓库（前端展示提示而非错误）。
    result: z.object({
      repo: z.boolean(),
      entries: z.array(GitChangeEntrySchema),
      truncated: z.boolean(),
      // 分支上下文（porcelain v2 --branch）；detached/无仓库时 null。
      branch: z.string().nullable(),
      upstream: z.string().nullable(),
      ahead: z.number().int().nonnegative().nullable(),
      behind: z.number().int().nonnegative().nullable(),
    }),
  },
  'workspace.agent_changes': {
    params: z.object({
      requestId: RequestIdSchema,
      projectId: z.string().min(1),
      sessionId: z.string().min(1),
    }),
    result: z.object({
      rootRunId: z.string().min(1).nullable(),
      changes: z.array(ChangedFileSchema),
    }),
  },
  'workspace.git_diff': {
    params: z.object({
      requestId: RequestIdSchema,
      projectId: z.string().min(1),
      path: z.string().min(1),
      // 缺省为工作树 diff；true 对比 HEAD 与索引（已暂存）。
      staged: z.boolean().optional(),
    }),
    // 两侧内容直接取自 git 对象/磁盘：工作树 diff 为 索引→工作树，
    // 已暂存为 HEAD→索引；新增侧为空串，删除侧为空串。
    result: z.object({
      repo: z.boolean(),
      original: z.string(),
      modified: z.string(),
      truncated: z.boolean(),
      binary: z.boolean(),
    }),
  },
  'workspace.git_branches': {
    params: z.object({
      requestId: RequestIdSchema,
      projectId: z.string().min(1),
    }),
    result: z.object({
      repo: z.boolean(),
      current: z.string().min(1).nullable(),
      branches: z.array(z.string().min(1)),
      // 远程跟踪分支（refs/remotes/*，剔除 */HEAD），`origin/main` 形态。
      remoteBranches: z.array(z.string().min(1)),
    }),
  },
  // ---------- Git 写操作（方案 A：UI 直接动作免审批凭据；Rust 枚举拼装 argv） ----------
  'workspace.git_stage': {
    params: z.object({
      requestId: RequestIdSchema,
      projectId: z.string().min(1),
      paths: z.array(z.string().min(1)).min(1),
    }),
    result: z.object({ ok: z.literal(true) }),
  },
  'workspace.git_unstage': {
    params: z.object({
      requestId: RequestIdSchema,
      projectId: z.string().min(1),
      paths: z.array(z.string().min(1)).min(1),
    }),
    result: z.object({ ok: z.literal(true) }),
  },
  'workspace.git_commit': {
    params: z.object({
      requestId: RequestIdSchema,
      projectId: z.string().min(1),
      message: z.string().min(1),
    }),
    result: z.object({ ok: z.literal(true) }),
  },
  'workspace.git_fetch': {
    params: z.object({
      requestId: RequestIdSchema,
      projectId: z.string().min(1),
    }),
    result: z.object({ ok: z.literal(true) }),
  },
  'workspace.git_push': {
    params: z.object({
      requestId: RequestIdSchema,
      projectId: z.string().min(1),
    }),
    result: z.object({ ok: z.literal(true) }),
  },
  'workspace.git_pull': {
    params: z.object({
      requestId: RequestIdSchema,
      projectId: z.string().min(1),
    }),
    result: z.object({ ok: z.literal(true) }),
  },
  'workspace.git_branch_create': {
    params: z.object({
      requestId: RequestIdSchema,
      projectId: z.string().min(1),
      name: z.string().min(1),
      // true 时创建并切换（switch -c）；缺省仅创建。
      checkout: z.boolean().optional(),
      // 可选起点：commit 哈希（历史「基于此建分支」）或 `remote/branch`
      // （远程分支检出为本地跟踪分支）。形态安全校验在 Rust。
      startRef: z.string().min(1).optional(),
    }),
    result: z.object({ ok: z.literal(true) }),
  },
  'workspace.git_branch_switch': {
    params: z.object({
      requestId: RequestIdSchema,
      projectId: z.string().min(1),
      name: z.string().min(1),
    }),
    result: z.object({ ok: z.literal(true) }),
  },
  // ---------- Git 提交历史（只读浏览 + 导航；hash 一律十六进制校验） ----------
  'workspace.git_log': {
    params: z.object({
      requestId: RequestIdSchema,
      projectId: z.string().min(1),
      skip: z.number().int().nonnegative().optional(),
      limit: z.number().int().positive().optional(),
    }),
    result: z.object({
      repo: z.boolean(),
      commits: z.array(
        z.object({
          hash: z.string(),
          shortHash: z.string(),
          timestampMs: z.number().int().nonnegative(),
          authorName: z.string(),
          isMerge: z.boolean(),
          subject: z.string(),
        }),
      ),
      hasMore: z.boolean(),
    }),
  },
  'workspace.git_commit_files': {
    params: z.object({
      requestId: RequestIdSchema,
      projectId: z.string().min(1),
      hash: z.string().regex(/^[0-9a-fA-F]{4,64}$/),
    }),
    result: z.object({
      files: z.array(
        z.object({
          path: z.string(),
          oldPath: z.string().optional(),
          status: GitChangeStatusSchema,
        }),
      ),
    }),
  },
  'workspace.git_commit_diff': {
    params: z.object({
      requestId: RequestIdSchema,
      projectId: z.string().min(1),
      hash: z.string().regex(/^[0-9a-fA-F]{4,64}$/),
      path: z.string().min(1),
    }),
    // original = 该文件在 <hash>^ 的内容（root/新增→空），modified = <hash>。
    result: z.object({
      original: z.string(),
      modified: z.string(),
      binary: z.boolean(),
      truncated: z.boolean(),
    }),
  },
  // ---------- Git 远程管理（列出/添加/移除 remote；远程分支检出复用 branch API） ----------
  'workspace.git_remotes': {
    params: z.object({
      requestId: RequestIdSchema,
      projectId: z.string().min(1),
    }),
    result: z.object({
      repo: z.boolean(),
      // url 回显已剥内嵌凭据（scheme://***@host）。
      remotes: z.array(z.object({ name: z.string(), url: z.string() })),
    }),
  },
  'workspace.git_remote_add': {
    params: z.object({
      requestId: RequestIdSchema,
      projectId: z.string().min(1),
      name: z.string().min(1),
      url: z.string().min(1),
    }),
    result: z.object({ ok: z.literal(true) }),
  },
  'workspace.git_remote_remove': {
    params: z.object({
      requestId: RequestIdSchema,
      projectId: z.string().min(1),
      name: z.string().min(1),
    }),
    result: z.object({ ok: z.literal(true) }),
  },
  'workspace.write_file': {
    params: z.object({
      requestId: RequestIdSchema,
      projectId: z.string().min(1),
      path: z.string().min(1),
      content: z.string(),
    }),
    result: z.object({
      writtenBytes: z.number().int().nonnegative(),
    }),
  },
  // ---------- Asset（Phase 1B 第二阶段）：内容入 Store，引用与元数据落库 ----------
  'asset.import': {
    params: z.object({
      requestId: RequestIdSchema,
      projectId: z.string().min(1),
      // 工作区相对路径（与 file.read 同一安全边界：相对、无 ..）。
      path: z.string().min(1),
    }),
    result: z.object({ asset: AssetRefSchema }),
  },
  'asset.list': {
    params: z.object({
      requestId: RequestIdSchema,
      projectId: z.string().min(1),
    }),
    result: z.object({ assets: z.array(AssetRefSchema) }),
  },
  'asset.read': {
    params: z.object({
      requestId: RequestIdSchema,
      assetId: z.string().min(1),
    }),
    // 文本类直返文本；图片返回 base64；不支持预览的 kind 两者皆 null。
    result: z.object({
      asset: AssetRefSchema,
      text: z.string().nullable(),
      base64: z.string().nullable(),
    }),
  },
  'asset.delete': {
    params: z.object({
      requestId: RequestIdSchema,
      assetId: z.string().min(1),
    }),
    result: z.object({ removed: z.boolean() }),
  },
  // 集成终端：用户本机 shell，不经 Agent 通道。单输入批次 ≤8 KiB（spec §6）
  // 已在 runtime 服务层（terminal_input_batch_too_large 快拒）与 Rust 入队前
  // （invalid_request）双层强制（终审 #3），契约保持宽松（write.data 不在
  // schema 层限长）。
  'terminal.create': {
    params: z.object({
      requestId: RequestIdSchema,
      projectId: z.string().min(1),
      rows: z.number().int().positive(),
      cols: z.number().int().positive(),
    }),
    result: z.object({ terminal: TerminalSchema }),
  },
  'terminal.list': {
    params: z.object({
      requestId: RequestIdSchema,
      projectId: z.string().min(1),
    }),
    result: z.object({ terminals: z.array(TerminalSchema) }),
  },
  'terminal.attach': {
    params: z.object({
      requestId: RequestIdSchema,
      projectId: z.string().min(1),
      terminalId: z.string().min(1),
      /** 消费者代际：前端 xterm 宿主实例身份，重挂即新值。 */
      consumerId: z.string().min(1),
    }),
    result: z.object({
      terminal: TerminalSchema,
      replayedBytes: z.number().int().nonnegative(),
    }),
  },
  'terminal.write': {
    params: z.object({
      requestId: RequestIdSchema,
      projectId: z.string().min(1),
      terminalId: z.string().min(1),
      /** 前端每终端单调序号；服务端按序串行入队，重复不重写。 */
      inputSeq: z.number().int().nonnegative(),
      data: z.string().min(1),
    }),
    result: z.object({
      accepted: z.literal(true),
      inputSeq: z.number().int(),
    }),
  },
  'terminal.resize': {
    params: z.object({
      requestId: RequestIdSchema,
      projectId: z.string().min(1),
      terminalId: z.string().min(1),
      rows: z.number().int().positive(),
      cols: z.number().int().positive(),
    }),
    result: z.object({ ok: z.literal(true) }),
  },
  'terminal.ack': {
    params: z.object({
      requestId: RequestIdSchema,
      projectId: z.string().min(1),
      terminalId: z.string().min(1),
      /** 累计确认：已消费到的 outputSeq。 */
      throughOutputSeq: z.number().int().nonnegative(),
    }),
    result: z.object({ ok: z.literal(true) }),
  },
  'terminal.close': {
    params: z.object({
      requestId: RequestIdSchema,
      projectId: z.string().min(1),
      terminalId: z.string().min(1),
    }),
    result: z.object({ closed: z.literal(true) }),
  },
} satisfies Record<string, { params: z.ZodType; result: z.ZodType }>

export type CommandName = keyof typeof CommandSchemaRegistry

/** Commands accepted by the desktop Host and forwarded to Runtime. */
export const runtimeMethodNames = Object.freeze(
  Object.keys(CommandSchemaRegistry).sort() as CommandName[],
)

export type CommandSchemaEntry = {
  params: z.ZodType
  result: z.ZodType
}

export function lookupCommandSchema(
  method: string,
): CommandSchemaEntry | undefined {
  const entry = (CommandSchemaRegistry as Record<string, CommandSchemaEntry>)[
    method
  ]
  return entry
}
