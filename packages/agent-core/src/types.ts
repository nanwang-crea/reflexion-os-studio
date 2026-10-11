import type {
  ChangedFile,
  JsonValue,
  ResourceLink,
  ToolProvenance,
  ImagePart,
} from '@reflexion-os-studio/contracts'

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
  | { role: 'system'; content: string }
  | {
      role: 'user'
      /** 仅用于 Runtime 控制，不投影到 Provider 请求。 */
      control?: 'continuation' | 'tool_recovery' | 'reflection' | 'task_context'
      content: string
      images?: (ImagePart & { base64?: string })[]
    }
  | { role: 'assistant'; content: string; toolCalls: AssistantToolCall[] }
  | { role: 'tool'; toolCallId: string; content: string; isError: boolean }

/** 一次模型调用的完整结果。 */
export interface ModelTurn {
  content: string
  /** 思考内容仅用于持久化展示，不回传给模型。 */
  reasoning: string
  /** 供应商原始停止原因，仅用于诊断。 */
  rawStopReason?: string
  toolCalls: AssistantToolCall[]
  /** Provider 已校验的终止原因；未知/缺失值不允许进入循环。 */
  finishReason: ModelFinishReason
  usage?: {
    promptTokens: number
    completionTokens: number
    /** Provider 回传的前缀缓存命中 prompt token 数；缺省表示端点未报告。 */
    cachedPromptTokens?: number
  }
}

/** Provider 终止原因（严格校验后的联合类型）。 */
export type ModelFinishReason =
  'stop' | 'length' | 'context_limit' | 'content_filter' | 'tool_calls'

export interface ToolCallRequest {
  id: string
  name: string
  /** 原始 JSON 字符串；注册表解析后传入 execute 的 args。 */
  arguments: string
}

export interface ToolExecutionArgs {
  /** 解析后的参数；形状由工具的 parameters JSON Schema 描述，工具自行校验。 */
  args: JsonValue
  /** 宿主侧 canonical 工具调用 ID；需要持久化关联时使用。 */
  toolCallId: string
  /** Provider 本轮生成的协议调用 ID；仅用于模型消息配对。 */
  protocolToolCallId: string
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
  /** 工具已明确提供的结构化数据；缺省时 Runtime 尝试从 content 解析 JSON。 */
  data?: JsonValue
  /** 可供 Artifact UI 导航的显式资源引用。 */
  resourceLinks?: ResourceLink[]
  /** 文件类工具产生的副作用；与普通 data 分离以便统一聚合。 */
  changedFiles?: ChangedFile[]
  /** 数据来源与信任等级；外部内容必须显式标记为不可信。 */
  provenance?: ToolProvenance
}

export interface ToolDefinition {
  name: string
  description: string
  /** JSON Schema 形式的参数声明（canonical ToolSpec.parameters）。 */
  parameters: JsonValue
  execute(args: ToolExecutionArgs): Promise<ToolResult> | ToolResult
  /**
   * 副作用感知调度元数据（Runtime 内部使用；不进入 Provider ToolSpec 投影）。
   * 缺省按保守 state 处理（串行执行）。
   */
  execution?: ToolExecutionPolicy
}

/** 工具副作用分类与资源键：决定同轮调度的并行/串行批次。 */
export interface ToolExecutionPolicy {
  /** pure/read 可并行；write/shell/state 串行且阻止后续 read 交叉。 */
  effect: 'pure' | 'read' | 'write' | 'shell' | 'state'
  /** 资源冲突键（如 workspace:path）；同 key 的调用保持声明顺序执行。 */
  resourceKeys?: (args: JsonValue) => string[]
  /** 幂等标记；供 Loop Guard 的重复副作用判断参考。 */
  idempotent?: boolean
}

export interface AgentLoopOptions {
  /** 起始上下文（含 system prompt 与历史）。 */
  history: ModelMessage[]
  /**
   * 每轮模型调用前收敛内存工作集；返回值会替换循环基线，避免后续轮次反复
   * 处理已淘汰历史。不得在此执行隐藏模型调用。
   */
  prepareMessages?(messages: ModelMessage[]): ModelMessage[]
  callModel(messages: ModelMessage[], signal: AbortSignal): Promise<ModelTurn>
  /**
   * 一轮全部工具调用的批量执行（由 Runtime 注入副作用调度器）：
   * 结果数组与请求顺序一一对应。单请求宿主可直接顺序执行。
   */
  executeToolBatch(
    requests: ToolCallRequest[],
    signal: AbortSignal,
  ): Promise<ToolResult[]>
  /** 模型调用/工具执行共享的取消信号。 */
  signal: AbortSignal
  /** 最大模型调用轮次；超出即停止，避免无限循环。 */
  maxTurns?: number
  /** length 续写最大连续轮次；缺省 2。 */
  maxContinuationTurns?: number
  /** 自动恢复诊断，不传入正文或工具参数。 */
  onRecovery?: (recovery: {
    kind: 'text' | 'reasoning' | 'tools'
    attempt: number
  }) => void
  /** 工具失败累计次数达到该值后注入反思消息；缺省 2，传 0 禁用。 */
  reflectionThreshold?: number
}

/** 模型轮次判定结果：finish reason 状态机的输出。 */
export type ModelTurnDisposition =
  | { kind: 'final' }
  | { kind: 'tools' }
  | { kind: 'truncated' }
  | { kind: 'tool_truncated' }
  | { kind: 'context_limit' }
  | { kind: 'blocked'; reason: 'content_filtered' }
  | { kind: 'protocol_error'; detail: string }

/** Run 因任务语义（而非异常）停止的稳定原因；统一映射为 failed + errorCode。 */
export type AgentStopReason =
  | 'max_turns'
  | 'output_truncated'
  | 'output_empty'
  | 'tool_output_truncated'
  | 'context_limit'
  | 'content_filtered'
  | 'provider_protocol'
  | 'no_progress'
  | 'run_timeout'
  | 'run_token_budget'
  | 'tool_call_budget'

export type AgentLoopOutcome =
  | {
      status: 'completed'
      turns: number
      finalTurn: ModelTurn
      messages: ModelMessage[]
    }
  | {
      status: 'stopped'
      turns: number
      /** 稳定停止原因；统一由宿主映射为 failed + errorCode。 */
      reason: AgentStopReason
      messages: ModelMessage[]
    }

export const DEFAULT_MAX_TURNS = 100
/** length 续写的最大连续轮次：超过即 output_truncated。 */
export const DEFAULT_MAX_CONTINUATION_TURNS = 2
