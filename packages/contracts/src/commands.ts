import { z } from 'zod'
import {
  MemoryScopeSchema,
  MemorySchema,
  MemoryStatusSchema,
  MessageSchema,
  ProviderCapabilitySchema,
  ProviderProfileSchema,
  ProjectSchema,
  RunSchema,
  SessionSchema,
  SkillManifestSchema,
  ToolCallSchema,
  WorkspaceEntrySchema,
  WorkspaceIndexSnapshotSchema,
  WorkspaceReadResultSchema,
  GitChangeEntrySchema,
  AssetRefSchema,
  QueueEntrySchema,
  AgentSettingsSchema,
  McpServerSchema,
  McpToolSchema,
} from './entities.js'
import { RuntimeStatusSchema } from './handshake.js'

export const RequestIdSchema = z.string().min(1)
export type RequestId = z.infer<typeof RequestIdSchema>

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
  // 本次会话执行的工具权限 Profile；缺省 workspace。
  permissionMode: z.enum(['workspace', 'read-only']).optional(),
  // 显式激活的 Skill；内容以 /<skillId> 开头时也可隐式激活（显式优先）。
  skillId: z.string().min(1).optional(),
})
export type ChatCommand = z.infer<typeof MessageSendParamsSchema>

export const ApprovalResolveParamsSchema = z.object({
  requestId: RequestIdSchema,
  toolCallId: z.string().min(1),
  decision: z.enum(['approved', 'denied']),
  scope: z.enum(['once', 'session']),
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
  'queue.list': {
    params: z.object({
      requestId: RequestIdSchema,
      sessionId: z.string().min(1),
    }),
    result: z.object({ items: z.array(QueueEntrySchema) }),
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
      env: z.array(z.object({ key: z.string().min(1), value: z.string() })),
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
    }),
    result: z.object({
      ok: z.boolean(),
      latencyMs: z.number().int().nonnegative(),
      model: z.string().min(1),
      error: z.string().nullable(),
    }),
  },
  'memory.list': {
    // scopeId 语义与 Memory.scopeId 一致：省略 → 全部；null → user 级。
    params: z.object({
      requestId: RequestIdSchema,
      scope: MemoryScopeSchema.optional(),
      scopeId: z.union([z.string().min(1), z.null()]).optional(),
    }),
    result: z.object({ memories: z.array(MemorySchema) }),
  },
  'memory.update': {
    // 记忆管理页的编辑/固定/归档；content 编辑会作废原 embedding（召回侧重建）。
    params: z.object({
      requestId: RequestIdSchema,
      id: z.string().min(1),
      content: z.string().min(1).optional(),
      status: MemoryStatusSchema.optional(),
    }),
    result: z.object({ memory: MemorySchema.nullable() }),
  },
  'memory.delete': {
    params: z.object({
      requestId: RequestIdSchema,
      id: z.string().min(1),
    }),
    result: z.object({ removed: z.boolean() }),
  },
  'skill.list': {
    // 内置 Skill 清单（Phase 1A 无安装/启停，列表即全部可用项）。
    params: z.object({ requestId: RequestIdSchema }),
    result: z.object({ skills: z.array(SkillManifestSchema) }),
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
    }),
    result: z.object({ entries: z.array(WorkspaceEntrySchema) }),
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
    }),
  },
  'workspace.git_diff': {
    params: z.object({
      requestId: RequestIdSchema,
      projectId: z.string().min(1),
      path: z.string().min(1),
      // 缺省为工作树 diff；true 取索引（已暂存）版本。
      staged: z.boolean().optional(),
    }),
    result: z.object({
      repo: z.boolean(),
      diff: z.string(),
      truncated: z.boolean(),
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
} satisfies Record<string, { params: z.ZodType; result: z.ZodType }>

export type CommandName = keyof typeof CommandSchemaRegistry

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
