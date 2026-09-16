import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * 提权目标推导与敏感边界复核（§10.2/§6.3）：
 * escalated 命令的可写扩展根 = 命令中出现的绝对路径参数（Runtime 推导，
 * 模型不能另行声明）；no-read 机密清单命中的目标直接拒绝，任何档位不商量。
 * Rust 侧（resolve_escalation_roots）独立执行同一不变量，双端不互信。
 */

export const MAX_ESCALATION_ROOTS = 4

const SENSITIVE_DIR_NAMES = new Set([
  '.ssh',
  '.aws',
  '.gnupg',
  '.config',
  '.docker',
  '.npmrc',
  '.netrc',
])

/** 平台敏感根（与 Rust sensitive_roots 同源清单）。 */
export function sensitiveRoots(): string[] {
  const home = homedir()
  const dataDir =
    process.env.REFLEXION_DATA_DIR ?? join(home, '.reflexion-os-studio')
  const roots = [
    dataDir,
    join(home, '.ssh'),
    join(home, '.aws'),
    join(home, '.gnupg'),
    join(home, '.config', 'gcloud'),
    join(home, '.docker'),
  ]
  if (process.platform !== 'win32') {
    roots.push('/etc')
  } else if (process.env.SystemRoot) {
    roots.push(process.env.SystemRoot)
  }
  return roots
}

function normalizeSlashes(path: string): string[] {
  const segments = path
    .replace(/\\/g, '/')
    .split('/')
    .filter((segment) => segment !== '')
  return segments
}

/** 目标与敏感根双向重叠（互为前缀）即拒绝；空路径（'/'）交由深度规则处理。 */
export function touchesSensitive(path: string): boolean {
  const segments = normalizeSlashes(path).map((s) => s.toLowerCase())
  if (segments.length === 0) return false
  if (segments.some((segment) => SENSITIVE_DIR_NAMES.has(segment))) {
    return true
  }
  for (const root of sensitiveRoots()) {
    const guard = normalizeSlashes(root).map((s) => s.toLowerCase())
    const overlaps =
      guard.length <= segments.length
        ? guard.every((segment, index) => segments[index] === segment)
        : segments.every((segment, index) => guard[index] === segment)
    if (overlaps) return true
  }
  return false
}

function isAbsoluteLike(path: string): boolean {
  return (
    path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path) || /^\\\\/.test(path)
  )
}

/** 深度 ≥2（拒绝裸根与一级系统目录）。 */
function deepEnough(path: string): boolean {
  return normalizeSlashes(path).length >= 2
}

function stripQuotes(token: string): string | null {
  let value = token
  const single = /^'([^']*)'$/.exec(token)
  if (single) value = single[1] ?? ''
  const double = /^"([^"]*)"$/.exec(token)
  if (double) value = double[1] ?? ''
  // 展开/命令替换/转义形态（含引号内部）：不可信为确定路径，保守丢弃。
  if (/[$`\\]/.test(value)) return null
  return value
}

export interface EscalationTargetOutcome {
  roots: string[]
  /** 被拒绝的敏感/过浅目标（披露给用户，不静默吞掉）。 */
  rejected: string[]
}

/**
 * 从命令字符串推导提权根：按空白切词，取引号剥离后的绝对路径形态 token。
 * 保守：含展开/转义的 token 直接丢；超过上限截断并记拒绝；敏感目标必须显式
 * 上报（executor 据此整体拒绝审批请求，而不是默默去掉边界）。
 */
export function extractEscalationTargets(
  command: string,
): EscalationTargetOutcome {
  const roots: string[] = []
  const rejected: string[] = []
  for (const rawToken of command.split(/\s+/)) {
    if (rawToken === '') continue
    const token = stripQuotes(rawToken)
    if (token === null) continue
    if (!isAbsoluteLike(token)) continue
    if (touchesSensitive(token)) {
      rejected.push(token)
      continue
    }
    if (!deepEnough(token)) {
      rejected.push(token)
      continue
    }
    if (!roots.includes(token)) {
      if (roots.length >= MAX_ESCALATION_ROOTS) {
        rejected.push(token)
        continue
      }
      roots.push(token)
    }
  }
  return { roots, rejected }
}
