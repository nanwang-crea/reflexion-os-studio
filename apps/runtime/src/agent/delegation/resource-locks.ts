import path from 'node:path'
import type { JsonValue } from '@reflexion-os-studio/contracts'

/** Lexical keys are scheduling hints, never authorization or Rust revision keys. */
export function fileResourceKeys(args: JsonValue): string[] {
  if (
    !args ||
    typeof args !== 'object' ||
    Array.isArray(args) ||
    typeof args.path !== 'string'
  )
    return []
  const raw = args.path.replaceAll('\\', '/')
  if (
    !raw ||
    raw.startsWith('/') ||
    /^[a-z]:/i.test(raw) ||
    raw.split('/').includes('..')
  )
    return []
  let normalized = path.posix.normalize(raw).replace(/\/$/, '')
  if (normalized === '.') return []
  if (process.platform !== 'linux') normalized = normalized.toLowerCase()
  return [`workspace:${normalized}`]
}

/** Ancestors conflict too. Empty keys mean unknown footprint, hence a barrier. */
export function resourcesConflict(
  a: readonly string[],
  b: readonly string[],
): boolean {
  if (!a.length || !b.length) return true
  return a.some((left) =>
    b.some(
      (right) =>
        left === right ||
        left.startsWith(`${right}/`) ||
        right.startsWith(`${left}/`),
    ),
  )
}
