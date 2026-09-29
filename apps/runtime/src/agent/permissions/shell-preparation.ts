import type { SystemRuntimeClient } from '../../system.js'
import { SystemRuntimeError } from '../../system.js'
import {
  ShellEscalationPrepareSchema,
  ShellEscalationPreparedSchema,
} from '@reflexion-os-studio/contracts'
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
import { validateEscalationTargets } from './escalation.js'
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
      sandboxProvider?: string
    }
  | {
      ok: false
      content: string
      code: string
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
    const targets = validateEscalationTargets(
      validated.data.additional_write_roots ?? [],
    )
    if (targets.rejected.length > 0 || targets.roots.length === 0) {
      return {
        ok: false,
        content:
          '提权范围无效：additional_write_roots 必须包含明确的非敏感绝对路径，不允许系统根、凭据范围、.. 或变量展开；不会猜测或静默扩大范围。',
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

/** Rust validates metadata before any permission dialog; failure never executes. */
export async function preflightShellExecution(
  prepared: ShellExecutionPrepared,
  system: SystemRuntimeClient | null | undefined,
  workspaceRoot: string | null,
  signal: AbortSignal,
): Promise<ShellExecutionPrepared> {
  if (!prepared.ok || !prepared.escalation) return prepared
  if (!system || !workspaceRoot)
    return {
      ok: false,
      code: 'sandbox_policy_unavailable',
      content: '提权预检不可用：需要已就绪的系统服务与工作区。',
    }
  try {
    const params = ShellEscalationPrepareSchema.parse({
      workspaceRoot,
      cwd: prepared.shellInput.cwd,
      escalationRoots: prepared.escalationRoots,
    })
    const result = ShellEscalationPreparedSchema.parse(
      await system.request('shell.prepare_escalation', params, { signal }),
    )
    return {
      ...prepared,
      sandboxProvider: result.sandboxProvider,
      escalationRoots: result.escalationRoots,
      shellInput: {
        ...prepared.shellInput,
        escalationRoots: result.escalationRoots,
      },
    }
  } catch (error) {
    if (
      signal.aborted ||
      (error instanceof Error && error.name === 'AbortError')
    )
      throw error
    return {
      ok: false,
      code:
        error instanceof SystemRuntimeError
          ? (error.code ?? 'sandbox_policy_unavailable')
          : 'sandbox_policy_unavailable',
      content: `提权预检失败（尚未申请授权或执行）：${error instanceof Error ? error.message : String(error)}`,
    }
  }
}
