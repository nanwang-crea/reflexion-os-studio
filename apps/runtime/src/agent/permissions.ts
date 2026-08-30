import type { ToolOperation } from '@reflexion-os-studio/contracts'
import type { RunEventEmitter } from '../events.js'

export type DecisionMode = 'automatic' | 'ask' | 'denied'
export type PermissionMode = 'workspace' | 'read-only'

const WORKSPACE_POLICY: Record<ToolOperation, DecisionMode> = {
  'file.read': 'automatic',
  'file.list': 'automatic',
  'file.write': 'ask',
  'shell.execute': 'ask',
}

const READ_ONLY_POLICY: Record<ToolOperation, DecisionMode> = {
  'file.read': 'automatic',
  'file.list': 'automatic',
  'file.write': 'denied',
  'shell.execute': 'denied',
}

const TOOL_OPERATIONS = new Set<string>(Object.keys(WORKSPACE_POLICY))

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
    if (!isToolOperation(toolName)) return 'automatic'
    if (!this.hasWorkspace) return 'denied'
    return policyFor(this.mode)[toolName]
  }
}

interface PendingApproval {
  resolve: (decision: 'approved' | 'denied', scope: 'once' | 'session') => void
}

/**
 * 审批网关：工具循环等待用户决策的桥。
 * pending 以 toolCallId 为键，`approval.resolve` 命令驱动落子；
 * 会话级授权只存内存（进程重启失效），对齐 PERMISSION-MODEL 的 ApprovalGrant 语义。
 */
export class ApprovalGateway {
  private readonly pending = new Map<string, PendingApproval>()
  private readonly sessionGrants = new Set<ToolOperation>()

  request(input: {
    toolCallId: string
    emitter: RunEventEmitter
    operation: ToolOperation
    summary: string
    signal: AbortSignal
  }): Promise<'approved' | 'denied'> {
    const { toolCallId, emitter, operation, summary, signal } = input
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
        resolve: (decision, scope) => {
          signal.removeEventListener('abort', onAbort)
          this.pending.delete(toolCallId)
          if (decision === 'approved' && scope === 'session') {
            this.sessionGrants.add(operation)
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

  hasSessionGrant(operation: ToolOperation): boolean {
    return this.sessionGrants.has(operation)
  }
}
