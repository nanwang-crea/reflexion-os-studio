import type { JsonValue } from '@reflexion-os-studio/contracts'

/**
 * 循环内流转的 canonical 消息：provider 无关。
 * provider 适配层负责投影为具体方言（OpenAI function calling 等）。
 */
export interface AssistantToolCall {
  id: string
  name: string
  /** 原始 JSON 字符串；由工具注册表解析校验。 */
  arguments: string
}

export type ModelMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls: AssistantToolCall[] }
  | { role: 'tool'; toolCallId: string; content: string; isError: boolean }

/** 一次模型调用的完整结果。 */
export interface ModelTurn {
  content: string
  /** 思考内容仅用于持久化展示，不回传给模型。 */
  reasoning: string
  toolCalls: AssistantToolCall[]
  finishReason: string
  usage?: { promptTokens: number; completionTokens: number }
}

export interface ToolCallRequest {
  id: string
  name: string
  /** 原始 JSON 字符串；注册表解析后传入 execute 的 args。 */
  arguments: string
}

export interface ToolExecutionArgs {
  /** 解析后的参数；形状由工具的 parameters JSON Schema 描述，工具自行校验。 */
  args: JsonValue
  signal: AbortSignal
  /**
   * 宿主为特权操作注入的授权引用（不透明字符串）；纯计算工具忽略。
   * 语义由宿主的权限体系定义，agent-core 不解释、不持久化。
   */
  grant?: string
}

export interface ToolResult {
  /** 回传给模型的文本结果；错误时为可读错误说明。 */
  content: string
  isError: boolean
  /** 错误分类码；宿主用于持久化与审计（unsupported / invalid_request / tool_error）。 */
  code?: string
}

export interface ToolDefinition {
  name: string
  description: string
  /** JSON Schema 形式的参数声明（canonical ToolSpec.parameters）。 */
  parameters: JsonValue
  execute(args: ToolExecutionArgs): Promise<ToolResult> | ToolResult
}

export interface AgentLoopOptions {
  /** 起始上下文（含 system prompt 与历史）。 */
  history: ModelMessage[]
  callModel(messages: ModelMessage[], signal: AbortSignal): Promise<ModelTurn>
  executeTool(
    request: ToolCallRequest,
    signal: AbortSignal,
  ): Promise<ToolResult> | ToolResult
  /** 模型调用/工具执行共享的取消信号。 */
  signal: AbortSignal
  /** 最大模型调用轮次；超出即停止，避免无限循环。 */
  maxTurns?: number
  /** 工具失败累计次数达到该值后注入反思消息；缺省 2，传 0 禁用。 */
  reflectionThreshold?: number
}

export interface AgentLoopOutcome {
  status: 'completed' | 'max_turns_exhausted'
  turns: number
  /** status=completed 时的最终回复。 */
  finalTurn: ModelTurn | null
  /** 完整消息流（含收官 assistant 轮）；含反思消息等运行时注入内容，未持久化。 */
  messages: ModelMessage[]
}

export const DEFAULT_MAX_TURNS = 16
