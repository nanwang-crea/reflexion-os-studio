import type { JsonValue, ToolOperation } from '@reflexion-os-studio/contracts'
import type { RunEventEmitter } from '../events.js'

export type DecisionMode = 'automatic' | 'ask' | 'denied'
export type PermissionMode = 'workspace' | 'read-only'

const WORKSPACE_POLICY: Record<ToolOperation, DecisionMode> = {
  'file.read': 'automatic',
  'file.list': 'automatic',
  'file.glob': 'automatic',
  'file.grep': 'automatic',
  'file.write': 'ask',
  'file.edit': 'ask',
  'file.delete': 'ask',
  'file.move': 'ask',
  'file.mkdir': 'ask',
  'shell.execute': 'ask',
}

const READ_ONLY_POLICY: Record<ToolOperation, DecisionMode> = {
  'file.read': 'automatic',
  'file.list': 'automatic',
  'file.glob': 'automatic',
  'file.grep': 'automatic',
  'file.write': 'denied',
  'file.edit': 'denied',
  'file.delete': 'denied',
  'file.move': 'denied',
  'file.mkdir': 'denied',
  'shell.execute': 'denied',
}

const TOOL_OPERATIONS = new Set<string>(Object.keys(WORKSPACE_POLICY))

/** 非操作类的内置纯计算工具:无需审批。 */
const AUTOMATIC_OTHER_TOOLS = new Set([
  'get_current_time',
  'web.fetch',
  'skill.use',
  // 计划工具只在本会话的 plans 表内写状态，不触工作区/Shell，无需审批。
  'update_plan',
])

export function policyFor(
  mode: PermissionMode,
): Record<ToolOperation, DecisionMode> {
  return mode === 'read-only' ? READ_ONLY_POLICY : WORKSPACE_POLICY
}

export function isToolOperation(toolName: string): toolName is ToolOperation {
  return TOOL_OPERATIONS.has(toolName)
}

/**
 * 单次 Run 的策略闸门：决定工具调用 automatic / ask / denied。
 * 无工作区（独立会话）时文件/Shell 一律拒绝；Rust 侧另有硬边界兜底。
 */
export class PermissionGate {
  constructor(
    private readonly mode: PermissionMode,
    private readonly hasWorkspace: boolean,
  ) {}

  decisionFor(toolName: string): DecisionMode {
    if (!isToolOperation(toolName)) {
      // MCP 与其它未知工具默认 ask(需用户审批),内置纯计算工具白名单放行。
      return AUTOMATIC_OTHER_TOOLS.has(toolName) ? 'automatic' : 'ask'
    }
    if (!this.hasWorkspace) return 'denied'
    return policyFor(this.mode)[toolName]
  }
}

interface PendingApproval {
  runId: string
  resolve: (decision: 'approved' | 'denied', scope: 'once' | 'session') => void
}

export interface ApprovalContext {
  sessionId: string
  workspaceRoot: string | null
}

/**
 * 审批网关：工具循环等待用户决策的桥。
 * pending 以 toolCallId 为键，`approval.resolve` 命令驱动落子；
 * 会话级授权只存内存（进程重启失效），对齐 PERMISSION-MODEL 的 ApprovalGrant 语义。
 */
export class ApprovalGateway {
  private readonly pending = new Map<string, PendingApproval>()
  private readonly sessionGrants = new Set<string>()

  private grantKey(context: ApprovalContext, operation: string): string {
    return `${context.sessionId}\u0000${context.workspaceRoot ?? ''}\u0000${operation}`
  }

  request(input: {
    toolCallId: string
    emitter: RunEventEmitter
    operation: string
    summary: string
    signal: AbortSignal
    context: ApprovalContext
  }): Promise<'approved' | 'denied'> {
    const { toolCallId, emitter, operation, summary, signal, context } = input
    emitter.next({ type: 'approval.required', toolCallId, operation, summary })
    return new Promise((resolve, reject) => {
      const onAbort = (): void => {
        this.pending.delete(toolCallId)
        reject(new DOMException('The operation was aborted.', 'AbortError'))
      }
      if (signal.aborted) {
        onAbort()
        return
      }
      signal.addEventListener('abort', onAbort, { once: true })
      this.pending.set(toolCallId, {
        runId: emitter.runId,
        resolve: (decision, scope) => {
          signal.removeEventListener('abort', onAbort)
          this.pending.delete(toolCallId)
          if (decision === 'approved' && scope === 'session') {
            this.sessionGrants.add(this.grantKey(context, operation))
          }
          emitter.next({
            type: 'approval.resolved',
            toolCallId,
            decision,
            scope,
          })
          resolve(decision)
        },
      })
    })
  }

  /** approval.resolve 命令入口；返回是否确实有等待中的调用被解决。 */
  resolve(
    toolCallId: string,
    decision: 'approved' | 'denied',
    scope: 'once' | 'session',
  ): boolean {
    const entry = this.pending.get(toolCallId)
    if (!entry) return false
    entry.resolve(decision, scope)
    return true
  }

  hasSessionGrant(operation: string, context: ApprovalContext): boolean {
    return this.sessionGrants.has(this.grantKey(context, operation))
  }

  /** 该 Run 是否仍有待审批调用：并行工具轮次据此维持 awaiting_approval。 */
  hasPendingRun(runId: string): boolean {
    for (const entry of this.pending.values()) {
      if (entry.runId === runId) return true
    }
    return false
  }
}

/**
 * 审批卡摘要：文件操作显示路径，move 显示 from→to，shell 显示命令，其余回退到参数 JSON。
 * 支持内置操作与动态工具名（MCP 的 serverId/toolName）。
 */
export function summarizeArgs(toolName: string, args: JsonValue): string {
  const record =
    typeof args === 'object' && args !== null && !Array.isArray(args)
      ? (args as Record<string, unknown>)
      : undefined
  if (record !== undefined) {
    if (typeof record.path === 'string') return `${toolName}: ${record.path}`
    if (typeof record.from === 'string' && typeof record.to === 'string') {
      return `${toolName}: ${record.from} → ${record.to}`
    }
    if (typeof record.command === 'string')
      return `${toolName}: ${record.command}`
  }
  return `${toolName}: ${JSON.stringify(args).slice(0, 200)}`
}

interface GrantIdentity {
  grantId: string
  requestId: string
  sessionId: string
  workspaceRoot: string | null
  operation: string
}

/** once 凭据：ask 批准后以本次调用为凭据，时效 5 分钟。 */
export function buildOnceGrant(input: GrantIdentity): string {
  return JSON.stringify({
    grantId: input.grantId,
    requestId: input.requestId,
    sessionId: input.sessionId,
    workspaceId: input.workspaceRoot ?? '',
    operation: input.operation,
    scope: 'once',
    expiresAt: Date.now() + 5 * 60 * 1000,
  })
}

/** session 凭据：同一调用的稳定引用授权，时效 30 分钟（内存态，重启失效）。 */
export function buildSessionGrant(input: GrantIdentity): string {
  return JSON.stringify({
    grantId: input.grantId,
    requestId: input.requestId,
    sessionId: input.sessionId,
    workspaceId: input.workspaceRoot ?? '',
    operation: input.operation,
    scope: 'session',
    expiresAt: Date.now() + 30 * 60 * 1000,
  })
}
