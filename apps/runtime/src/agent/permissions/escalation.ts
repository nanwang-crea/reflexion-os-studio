import { homedir } from 'node:os'
import { isAbsolute, normalize, join } from 'node:path'

/**
 * 提权目标推导与敏感边界复核（§10.2/§6.3）：
 * escalated 命令的可写扩展根 = 显式 additional_write_roots；no-read 机密清单命中的目标直接拒绝，任何档位不商量。
 * Rust 侧（resolve_escalation_roots）独立执行同一不变量，双端不互信。
 */

const SENSITIVE_DIR_NAMES = new Set([
  '.ssh',
  '.aws',
  '.gnupg',
  'pgp',
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

/** Credential-name checks, without the blanket denial of runtime data roots. */
export function hasSensitivePathSegments(path: string): boolean {
  const segments = normalizeSlashes(path).map((s) => s.toLowerCase())
  return segments.some(
    (segment) =>
      SENSITIVE_DIR_NAMES.has(segment) ||
      segment.startsWith('.env') ||
      segment.startsWith('id_rsa') ||
      segment.startsWith('id_ed25519') ||
      ['credentials.json', 'secrets.json', 'id_token'].includes(segment) ||
      /\.(pem|key|token)$/.test(segment),
  )
}

/** 目标与敏感根双向重叠（互为前缀）即拒绝；空路径（'/'）交由深度规则处理。 */
export function touchesSensitive(path: string): boolean {
  const segments = normalizeSlashes(path).map((s) => s.toLowerCase())
  if (segments.length === 0) return false
  if (hasSensitivePathSegments(path)) return true
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

/** Explicit scopes only: shell text is never an authority for writable roots. */
export function validateEscalationTargets(
  paths: string[],
): EscalationTargetOutcome {
  const roots: string[] = []
  const rejected: string[] = []
  for (const path of paths) {
    const segments = normalizeSlashes(path)
    if (
      !isAbsolute(path) ||
      /[\x00-\x1f\x7f]/.test(path) ||
      segments.includes('..') ||
      segments.length < 2 ||
      touchesSensitive(path)
    ) {
      rejected.push(path)
    } else {
      const normalized = normalize(path)
      if (!roots.includes(normalized)) roots.push(normalized)
    }
  }
  return { roots, rejected }
}

export interface EscalationTargetOutcome {
  roots: string[]
  rejected: string[]
}
