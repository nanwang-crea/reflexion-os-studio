import { z } from 'zod'

const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/

export const SemVerSchema = z.string().regex(SEMVER_PATTERN)
export type SemVer = z.infer<typeof SemVerSchema>

interface ParsedSemVer {
  core: [string, string, string]
  prerelease: string[]
}

export function compareSemVer(left: string, right: string): number {
  const a = parseSemVer(left)
  const b = parseSemVer(right)
  for (let index = 0; index < 3; index += 1) {
    const difference = compareNumericIdentifier(a.core[index], b.core[index])
    if (difference !== 0) return difference
  }
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    if (a.prerelease.length === b.prerelease.length) return 0
    return a.prerelease.length === 0 ? 1 : -1
  }
  const length = Math.max(a.prerelease.length, b.prerelease.length)
  for (let index = 0; index < length; index += 1) {
    const leftPart = a.prerelease[index]
    const rightPart = b.prerelease[index]
    if (leftPart === undefined) return -1
    if (rightPart === undefined) return 1
    if (leftPart === rightPart) continue
    const leftNumeric = /^\d+$/.test(leftPart)
    const rightNumeric = /^\d+$/.test(rightPart)
    if (leftNumeric && rightNumeric) {
      return compareNumericIdentifier(leftPart, rightPart)
    }
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1
    return leftPart < rightPart ? -1 : 1
  }
  return 0
}

function parseSemVer(value: string): ParsedSemVer {
  const parsed = SemVerSchema.safeParse(value)
  if (!parsed.success) throw new Error(`invalid semantic version: ${value}`)
  const match = SEMVER_PATTERN.exec(value)
  if (!match) throw new Error(`invalid semantic version: ${value}`)
  return {
    core: [match[1], match[2], match[3]],
    prerelease: match[4]?.split('.') ?? [],
  }
}

function compareNumericIdentifier(left: string, right: string): number {
  if (left.length !== right.length) return left.length < right.length ? -1 : 1
  if (left === right) return 0
  return left < right ? -1 : 1
}
