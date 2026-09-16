import type {
  ApprovalChoice,
  ApprovalContextView,
  ApprovalRisk,
  ApprovalSubject,
  ToolOperation,
} from '@reflexion-os-studio/contracts'
import type { RunEventEmitter } from '../../events.js'
import {
  buildWorkspacePathRule,
  WorkspacePathRuleStore,
} from './resource-rules.js'
import { buildShellPrefixRule, ShellRuleStore } from './shell-rules.js'
import type {
  ApprovalScope,
  ShellInterpreter,
  ShellPrefixRule,
  ShellRuleMatch,
} from './types.js'

/**
 * 审批网关 V2：pending 以 toolCallId 为键、choice 驱动落子，并持有会话规则
 * （workspace-path / shell-prefix / operation 级兼容授权）与 ask-everything
 * 覆盖项。Runtime 下发它认可的 choices（label + effect 成对注册），前端只能
 * 回传 choiceId；前端不得构造或篡改授权语义。
 */

export type ApprovalChoiceEffect =
  /**
   * 仅放行本次调用。sandboxOverride：审批同时显式携带的沙箱能力（§6.2——
   * 一次普通审批不得隐式将 read-only 沙箱升级为工作区可写，必须走这个字段）。
   */
  | { kind: 'once'; sandboxOverride?: 'workspace-write' }
  /** 拒绝。 */
  | { kind: 'deny' }
  /** 会话内免问该 operation（MCP/动态工具与 sandbox_network 兼容通道）。 */
  | { kind: 'session-operation'; operation: string }
  /** 写入会话规则（file.edit 组合 choice 携带 read+edit 两条，原子生效）。 */
  | { kind: 'session-rules'; rules: ApprovalScopeRule[] }

export type ApprovalScopeRule =
  | { kind: 'workspace-path'; operation: ToolOperation; path: string }
  | {
      kind: 'shell-prefix'
      interpreter: ShellInterpreter
      cwd: string
      prefix: string[]
      sandbox: ShellPrefixRule['sandbox']
      network: boolean
    }

export interface ChoiceSpec {
  choice: ApprovalChoice
  effect: ApprovalChoiceEffect
}

export interface ApprovalOutcome {
  decision: 'approved' | 'denied'
  choiceId: string
  grantScope: 'once' | 'session'
  effect: ApprovalChoiceEffect
}

interface PendingEntry {
  runId: string
  choices: Map<string, ChoiceSpec>
  settle: (outcome: ApprovalOutcome) => void
}

export interface ApprovalRequestInput {
  toolCallId: string
  emitter: RunEventEmitter
  operation: string
  summary: string
  subject: ApprovalSubject
  risk: ApprovalRisk
  context: ApprovalContextView
  choices: ChoiceSpec[]
  signal: AbortSignal
  scope: ApprovalScope
}

export function effectGrantScope(
  effect: ApprovalChoiceEffect,
): 'once' | 'session' {
  return effect.kind === 'session-operation' || effect.kind === 'session-rules'
    ? 'session'
    : 'once'
}

export class ApprovalGateway {
  private readonly pending = new Map<string, PendingEntry>()
  private readonly pathRules = new WorkspacePathRuleStore()
  private readonly shellRules = new ShellRuleStore()
  /** operation 级会话授权：MCP/动态工具与 sandbox_network（W6 前兼容通道）。 */
  private readonly sessionOperations = new Set<string>()
  /** 高级审批覆盖项：仅当前会话内存生效，不持久化。 */
  private readonly overrides = new Map<string, 'default' | 'ask-everything'>()

  setApprovalOverride(
    sessionId: string,
    override: 'default' | 'ask-everything',
  ): 'default' | 'ask-everything' {
    if (override === 'default') this.overrides.delete(sessionId)
    else this.overrides.set(sessionId, override)
    return this.approvalOverrideFor(sessionId)
  }

  approvalOverrideFor(sessionId: string): 'default' | 'ask-everything' {
    return this.overrides.get(sessionId) ?? 'default'
  }

  private operationKey(scope: ApprovalScope, operation: string): string {
    return `${scope.sessionId}\u0000${scope.workspaceRoot ?? ''}\u0000${operation}`
  }

  request(input: ApprovalRequestInput): Promise<ApprovalOutcome> {
    const { toolCallId, emitter, signal, scope } = input
    if (input.choices.some((spec) => spec.choice.id === '')) {
      throw new Error('approval choice id must be non-empty')
    }
    emitter.next({
      type: 'approval.required',
      toolCallId,
      sessionId: scope.sessionId,
      operation: input.operation,
      summary: input.summary,
      subject: input.subject,
      risk: input.risk,
      context: input.context,
      choices: input.choices.map((spec) => spec.choice),
    })
    return new Promise<ApprovalOutcome>((resolve, reject) => {
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
        choices: new Map(
          input.choices.map((spec) => [spec.choice.id, spec] as const),
        ),
        settle: (outcome) => {
          signal.removeEventListener('abort', onAbort)
          this.pending.delete(toolCallId)
          if (outcome.effect.kind === 'session-operation') {
            this.sessionOperations.add(
              this.operationKey(scope, outcome.effect.operation),
            )
          } else if (outcome.effect.kind === 'session-rules') {
            for (const rule of outcome.effect.rules) {
              if (rule.kind === 'workspace-path') {
                this.pathRules.add(
                  buildWorkspacePathRule({
                    scope,
                    operation: rule.operation,
                    path: rule.path,
                  }),
                )
              } else {
                this.shellRules.add(
                  buildShellPrefixRule({
                    scope,
                    interpreter: rule.interpreter,
                    cwd: rule.cwd,
                    prefix: rule.prefix,
                    sandbox: rule.sandbox,
                    network: rule.network,
                  }),
                )
              }
            }
          }
          emitter.next({
            type: 'approval.resolved',
            toolCallId,
            decision: outcome.decision,
            grantScope: outcome.grantScope,
            choiceId: outcome.choiceId,
          })
          resolve(outcome)
        },
      })
    })
  }

  /** approval.resolve 命令入口；choiceId 必须属于当前 pending。 */
  resolveChoice(toolCallId: string, choiceId: string): boolean {
    const entry = this.pending.get(toolCallId)
    const spec = entry?.choices.get(choiceId)
    if (!entry || !spec) return false
    entry.settle({
      decision: spec.choice.decision,
      choiceId,
      grantScope: effectGrantScope(spec.effect),
      effect: spec.effect,
    })
    return true
  }

  hasSessionOperationGrant(operation: string, scope: ApprovalScope): boolean {
    return this.sessionOperations.has(this.operationKey(scope, operation))
  }

  hasWorkspacePathRule(
    scope: ApprovalScope,
    operation: ToolOperation,
    path: string,
  ): boolean {
    return this.pathRules.has(scope, operation, path)
  }

  matchShellPrefixRule(scope: ApprovalScope, actual: ShellRuleMatch) {
    return this.shellRules.lookup(scope, actual)
  }

  /** 会话删除时清理该会话全部授权痕迹与覆盖项。 */
  clearSession(sessionId: string): void {
    this.pathRules.clearSession(sessionId)
    this.shellRules.clearSession(sessionId)
    for (const key of this.sessionOperations) {
      if (key.split('\u0000')[0] === sessionId)
        this.sessionOperations.delete(key)
    }
    this.overrides.delete(sessionId)
  }

  /** 该 Run 是否仍有待审批调用：并行工具轮次据此维持 awaiting_approval。 */
  hasPendingRun(runId: string): boolean {
    for (const entry of this.pending.values()) {
      if (entry.runId === runId) return true
    }
    return false
  }
}
