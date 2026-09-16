import { createHash } from 'node:crypto'
import type {
  ApprovalSubject,
  JsonValue,
  SandboxPolicy,
  ToolOperation,
} from '@reflexion-os-studio/contracts'
import type { ShellInterpreter } from './types.js'

/**
 * ApprovalSubject 构造 + subjectDigest 计算（PERMISSION-MODEL §7.1/§11.1）。
 * 主题由 Runtime 依工具参数生成，模型不得直接提供；digest 用长度前缀
 * canonical 串（TS/Rust 双实现必须逐字节一致），杜绝分隔符歧义注入。
 */

export class InvalidWorkspacePathError extends Error {
  constructor(path: string) {
    super(
      `path must be workspace-relative (no absolute paths or ".."): ${path}`,
    )
    this.name = 'InvalidWorkspacePathError'
  }
}

/**
 * 规范化为协议级相对路径：`\`→`/`、去空段与 `.` 段；拒绝绝对路径、
 * 盘符与 `..` 段（审批前拒绝；Rust 继续 canonicalize 与符号链接边界）。
 * 返回 null 表示非法（调用方必须拒绝而非静默改写）。
 */
export function normalizeRelativePath(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (trimmed === '') return null
  const slashed = trimmed.replace(/\\/g, '/')
  if (slashed.startsWith('/') || /^[A-Za-z]:/.test(slashed)) return null
  const segments: string[] = []
  for (const segment of slashed.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') return null
    segments.push(segment)
  }
  return segments.length === 0 ? '.' : segments.join('/')
}

/** 长度前缀拼接（"v2" | operation | 资源部分…），Rust 侧同算法复核。 */
export function canonicalDigest(operation: string, parts: string[]): string {
  const pieces = ['v2', operation, ...parts]
  const joined = pieces
    .map((piece) => `${Buffer.byteLength(piece, 'utf8')}:${piece}`)
    .join('')
  return `sha256:${createHash('sha256').update(joined, 'utf8').digest('hex')}`
}

function record(args: JsonValue): Record<string, unknown> {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    return {}
  }
  return args as Record<string, unknown>
}

function stringField(args: JsonValue, key: string): string | undefined {
  const value = record(args)[key]
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** file.glob / file.grep 的资源标识（grep 不含搜索文本，见 §8.2）。 */
function searchScopeIdentity(
  operation: 'file.glob' | 'file.grep',
  args: JsonValue,
): string[] {
  const path = normalizeRelativePath(stringField(args, 'path') ?? '.') ?? '.'
  if (operation === 'file.glob') {
    // glob 授权范围 = pattern 本身（不扩大为全工作区读取）。
    return [`${path}\n${stringField(args, 'pattern') ?? ''}`]
  }
  return [`${path}\n${stringField(args, 'glob') ?? '*'}`]
}

export interface ShellSubjectInput {
  command: string
  /** 已规范化的相对 cwd（'.' 表示工作区根）。 */
  cwd: string
  sandbox: SandboxPolicy
  network: boolean
  escalation: boolean
  displayCommand: string
  prefixCandidate: string[] | null
  interpreter: ShellInterpreter
  /**
   * escalated 档的审批提权根（Runtime 从命令的绝对路径参数推导并经敏感
   * 校验；参与 digest + 写入 grant，Rust 重算绑定后再独立复核）。
   */
  escalationRoots?: string[]
}

/**
 * Shell 资源身份：command + cwd +（escalated 时）提权根 + sandbox + network
 * （§11.1；根集合顺序按命令参数出现序，TS/Rust 同源字符串逐段比对）。
 */
export function shellDigest(input: ShellSubjectInput): string {
  const parts = [input.command, input.cwd]
  if (input.escalation) {
    parts.push(...(input.escalationRoots ?? []))
  }
  parts.push(input.sandbox, input.network ? '1' : '0')
  return canonicalDigest('shell.execute', parts)
}

/**
 * 从工具参数构造审批主题与 digest。返回 digest 供 grant 签发与 Rust 复核；
 * 文件路径非法时抛 InvalidWorkspacePathError（调用方折叠为工具错误）。
 */
export function buildApprovalSubject(
  toolName: string,
  args: JsonValue,
  shell?: ShellSubjectInput,
): { subject: ApprovalSubject; digest: string } {
  switch (toolName) {
    case 'file.read':
    case 'file.list':
    case 'file.write':
    case 'file.edit':
    case 'file.delete':
    case 'file.mkdir': {
      const raw = stringField(args, 'path')
      const path = raw === undefined ? null : normalizeRelativePath(raw)
      if (path === null) {
        throw new InvalidWorkspacePathError(String(raw ?? ''))
      }
      const operation = toolName as ToolOperation
      return {
        subject: { kind: 'workspace-path', operation, path },
        digest: canonicalDigest(operation, [path]),
      }
    }
    case 'file.glob':
    case 'file.grep': {
      const operation = toolName as 'file.glob' | 'file.grep'
      const identity = searchScopeIdentity(operation, args)
      return {
        subject: {
          kind: 'workspace-path',
          operation,
          path: identity[0],
        },
        digest: canonicalDigest(operation, identity),
      }
    }
    case 'file.move': {
      const from = stringField(args, 'from')
      const to = stringField(args, 'to')
      const fromPath = from === undefined ? null : normalizeRelativePath(from)
      const toPath = to === undefined ? null : normalizeRelativePath(to)
      if (fromPath === null || toPath === null) {
        throw new InvalidWorkspacePathError(`${from ?? ''} → ${to ?? ''}`)
      }
      // move 不提供会话规则（避免扩大源删除能力）：operation 级一次性审批，
      // digest 仍绑定 from + to，Rust 复核资源一致性。
      return {
        subject: { kind: 'operation', operation: 'file.move' },
        digest: canonicalDigest('file.move', [fromPath, toPath]),
      }
    }
    case 'shell.execute': {
      if (shell === undefined) {
        throw new Error('shell.execute requires ShellSubjectInput')
      }
      return {
        subject: {
          kind: 'shell-command',
          operation: 'shell.execute',
          commandDigest: shellDigest(shell),
          displayCommand: shell.displayCommand,
          prefixCandidate: shell.prefixCandidate,
          escalation: shell.escalation,
          network: shell.network,
        },
        digest: shellDigest(shell),
      }
    }
    default: {
      // MCP / 其它动态工具：保持 operation 级审批，本期不扩展资源语义。
      return {
        subject: { kind: 'operation', operation: toolName },
        digest: canonicalDigest(toolName, []),
      }
    }
  }
}

/** 自动放行（preset/danger/session-rule）时的 digest 复算入口。 */
export function digestForGrant(
  toolName: string,
  args: JsonValue,
  shell?: ShellSubjectInput,
): string {
  return buildApprovalSubject(toolName, args, shell).digest
}
