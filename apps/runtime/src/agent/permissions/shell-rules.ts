import { randomUUID } from 'node:crypto'
import type { ApprovalScope, ShellPrefixRule, ShellRuleMatch } from './types.js'

/**
 * Shell 前缀会话规则（§9.3）：匹配必须基于 token，禁止字符串 startsWith；
 * interpreter / cwd / sandbox / network 参与 rule identity——一条 read-only
 * 规则不得在 workspace-write 或 escalated 执行中复用。
 */

/** prefix 至少包含可执行文件和一个稳定子命令（最短 2 token）。 */
export const MIN_PREFIX_TOKENS = 2

function samePrefix(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((token, index) => token === b[index])
}

export function buildShellPrefixRule(input: {
  scope: ApprovalScope
  interpreter: ShellPrefixRule['interpreter']
  cwd: string
  prefix: string[]
  sandbox: ShellPrefixRule['sandbox']
  network: boolean
}): ShellPrefixRule {
  if (input.prefix.length < MIN_PREFIX_TOKENS) {
    throw new Error('shell prefix rule requires executable + stable subcommand')
  }
  return {
    kind: 'shell-prefix',
    id: randomUUID(),
    sessionId: input.scope.sessionId,
    workspaceRoot: input.scope.workspaceRoot,
    interpreter: input.interpreter,
    cwd: input.cwd,
    prefix: [...input.prefix],
    sandbox: input.sandbox,
    network: input.network,
  }
}

/** 语义匹配（session/workspace 隔离由 ShellRuleStore.lookup 先过滤）。 */
export function matchesShellPrefixRule(
  rule: ShellPrefixRule,
  actual: ShellRuleMatch,
): boolean {
  if (rule.interpreter !== actual.interpreter) return false
  if (rule.cwd !== actual.cwd) return false
  if (rule.sandbox !== actual.sandbox) return false
  if (rule.network !== actual.network) return false
  if (rule.prefix.length > actual.tokens.length) return false
  for (let index = 0; index < rule.prefix.length; index += 1) {
    if (rule.prefix[index] !== actual.tokens[index]) return false
  }
  return true
}

export class ShellRuleStore {
  private rules: ShellPrefixRule[] = []

  add(rule: ShellPrefixRule): void {
    // 同 identity 去重（重复授权同一前缀不叠加审计噪音）。
    this.rules = this.rules.filter(
      (existing) =>
        !(
          existing.sessionId === rule.sessionId &&
          (existing.workspaceRoot ?? '') === (rule.workspaceRoot ?? '') &&
          existing.interpreter === rule.interpreter &&
          existing.cwd === rule.cwd &&
          existing.sandbox === rule.sandbox &&
          existing.network === rule.network &&
          samePrefix(existing.prefix, rule.prefix)
        ),
    )
    this.rules.push(rule)
  }

  /** 返回命中的规则（含 id，审计记 ruleId）；未命中 null。 */
  lookup(scope: ApprovalScope, actual: ShellRuleMatch): ShellPrefixRule | null {
    for (const rule of this.rules) {
      if (rule.sessionId !== scope.sessionId) continue
      if ((rule.workspaceRoot ?? '') !== (scope.workspaceRoot ?? '')) continue
      if (matchesShellPrefixRule(rule, actual)) return rule
    }
    return null
  }

  clearSession(sessionId: string): void {
    this.rules = this.rules.filter((rule) => rule.sessionId !== sessionId)
  }

  get size(): number {
    return this.rules.length
  }
}
