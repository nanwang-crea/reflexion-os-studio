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

// ---------------------------------------------------------------------------
// Shell 执行编排（权限模型 V2 §12：Shell 特有的分类、提权根与 digest 逻辑
// 集中于此，tool-executor 只保留统一编排）。
// ---------------------------------------------------------------------------

import {
  ShellExecuteParamsSchema,
  type JsonValue,
  type PermissionPreset,
  type SandboxPolicy,
} from '@reflexion-os-studio/contracts'
import {
  classifyShellCommand,
  resolvePrefixCandidate,
} from './shell-classifier.js'
import { extractEscalationTargets, touchesSensitive } from './escalation.js'
import {
  normalizeRelativePath,
  shellDigest,
  type ShellSubjectInput,
} from './subjects.js'
import { displayCommand } from './summaries.js'

export type ShellInterpreterTag = 'posix-sh' | 'windows-cmd'

/** 当前平台的实际解释器（§9.4）：分类器与执行器同源，禁止不一致。 */
export function currentShellInterpreter(): ShellInterpreterTag {
  return process.platform === 'win32' ? 'windows-cmd' : 'posix-sh'
}

export interface ShellExecutionInput {
  args: JsonValue
  record: Record<string, unknown>
  preset: PermissionPreset
  dangerActive: boolean
}

export type ShellExecutionPrepared =
  | {
      ok: true
      shellInput: ShellSubjectInput
      /** 分类 token（供会话规则匹配）。 */
      tokens: string[]
      escalation: boolean
      networkRequested: boolean
      escalationRoots: string[]
    }
  | {
      ok: false
      content: string
      code: 'invalid_request' | 'permission_denied'
    }

/**
 * 一次 shell.execute 的权限面准备：参数校验（含 justification 条件校验）、
 * cwd 规范化、提权根推导与敏感拒绝、分类与前缀候选、档位选择。
 * 失败返回模型可读的工具错误（不弹卡、不发 grant）。
 */
export function prepareShellExecution(
  input: ShellExecutionInput,
): ShellExecutionPrepared {
  const { args, record, preset, dangerActive } = input
  const validated = ShellExecuteParamsSchema.safeParse(args)
  if (!validated.success) {
    return {
      ok: false,
      content: `shell.execute 参数不合规：${validated.error.issues
        .map((issue) => `${String(issue.path.join('.'))}: ${issue.message}`)
        .join('; ')}`,
      code: 'invalid_request',
    }
  }
  if (typeof record.command !== 'string' || record.command.trim() === '') {
    return {
      ok: false,
      content: 'shell.execute 缺少 command 参数',
      code: 'invalid_request',
    }
  }
  const escalationRequested = record.sandbox_permissions === 'require_escalated'
  // Danger 生效时提权请求被更宽的 danger 档吸收（roots 不进 digest）。
  const escalation = escalationRequested && !dangerActive
  const networkRequested = record.requires_network === true
  const rawCwd = record.cwd
  const cwd =
    rawCwd === undefined || rawCwd === ''
      ? '.'
      : normalizeRelativePath(String(rawCwd))
  if (cwd === null) {
    return {
      ok: false,
      content: `shell.execute 的 cwd 必须是工作区相对路径（不允许绝对路径或 ..）：${String(rawCwd)}`,
      code: 'invalid_request',
    }
  }
  let escalationRoots: string[] = []
  if (escalation) {
    // 提权根 = 命令中出现的绝对路径参数（Runtime 推导）；命中 no-read
    // 机密清单直接拒绝并披露——任何档位/提权都不可旁路（红线第 9 条）。
    const targets = extractEscalationTargets(record.command)
    if (targets.rejected.some((target) => touchesSensitive(target))) {
      return {
        ok: false,
        content:
          '提权请求被拒绝：命令目标涉及受保护凭据路径（no-read 清单），任何档位不可旁路。',
        code: 'permission_denied',
      }
    }
    escalationRoots = targets.roots
  }
  // Shell 默认档位严格跟随 preset（§6.2）；审批扩写必须走显式 choice。
  const presetShellSandbox: SandboxPolicy =
    preset === 'workspace-read' ? 'read-only' : 'workspace-write'
  const sandbox: SandboxPolicy = dangerActive
    ? 'danger'
    : escalation
      ? 'escalated'
      : presetShellSandbox
  const classification = classifyShellCommand(
    record.command,
    currentShellInterpreter(),
  )
  // 提权命令不给可复用前缀（§10.2）。联网命令的主卡同样不给（choice 层
  // 排除），但候选值保留给网络卡生成"前缀 + network=true"会话规则（W6）。
  const candidate = escalation
    ? null
    : resolvePrefixCandidate(classification, record.prefix_rule)
  const shellInput: ShellSubjectInput = {
    command: record.command,
    cwd,
    sandbox,
    network: networkRequested,
    escalation,
    displayCommand: displayCommand(record.command),
    prefixCandidate: candidate,
    interpreter: currentShellInterpreter(),
    escalationRoots,
  }
  return {
    ok: true,
    shellInput,
    tokens: classification.tokens,
    escalation,
    networkRequested,
    escalationRoots,
  }
}

/** 审批 choice 显式扩写（sandboxOverride）后按最终档位重算 digest。 */
export function shellDigestWithSandbox(
  shellInput: ShellSubjectInput,
  sandbox: SandboxPolicy,
): string {
  return shellDigest({ ...shellInput, sandbox })
}
