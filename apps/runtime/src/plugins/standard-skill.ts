import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import {
  JsonValueSchema,
  PluginPackageManifestSchema,
  type JsonValue,
  type PluginPackageManifest,
} from '@reflexion-os-studio/contracts'
import { parse } from 'yaml'

const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export function manifestFromStandardSkill(
  directory: string,
  onWarning?: (warning: string) => void,
): PluginPackageManifest {
  const source = readFileSync(join(directory, 'SKILL.md'), 'utf8')
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(source)
  if (!match) throw new Error('SKILL.md requires YAML frontmatter')

  const frontmatter = parse(match[1], { maxAliasCount: 20 }) as unknown
  if (!isRecord(frontmatter)) {
    throw new Error('SKILL.md frontmatter must be a YAML mapping')
  }
  const name = requiredString(frontmatter, 'name')
  const description = requiredString(frontmatter, 'description')
  const whenToUse = optionalString(frontmatter, 'when_to_use')
  const license = optionalString(frontmatter, 'license')
  const metadata = standardMetadata(frontmatter.metadata)
  if (name.length > 64 || !SKILL_NAME_PATTERN.test(name)) {
    throw new Error(
      'SKILL.md name must be 1-64 lowercase letters, numbers, or hyphens',
    )
  }
  if (description.length > 1_024) {
    throw new Error('SKILL.md description must be at most 1024 characters')
  }
  if (frontmatter['allowed-tools'] !== undefined) {
    onWarning?.(
      'SKILL.md allowed-tools is informational; normal tool permissions still apply',
    )
  }

  return PluginPackageManifestSchema.parse({
    manifestVersion: 1,
    id: name,
    name,
    version: standardVersion(metadata, onWarning),
    description,
    type: 'skill',
    entry: 'SKILL.md',
    compatibility: { protocol: '^1.3' },
    capabilities: ['skill.instructions'],
    permissions: { filesystem: 'none', network: false, shell: false },
    skill: {
      tools: [],
      argumentHint: null,
      whenToUse,
      license,
      metadata,
    },
  })
}

function standardVersion(
  metadata: Record<string, unknown>,
  onWarning?: (warning: string) => void,
): string {
  if (typeof metadata.version !== 'string') {
    return '1.0.0'
  }
  const version = /^\d+\.\d+$/.test(metadata.version)
    ? `${metadata.version}.0`
    : metadata.version
  if (/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) return version
  onWarning?.(
    `Ignored non-SemVer SKILL.md metadata.version: ${metadata.version}`,
  )
  return '1.0.0'
}

function standardMetadata(value: unknown): Record<string, JsonValue> {
  if (value === undefined) return {}
  if (!isRecord(value)) throw new Error('SKILL.md metadata must be a mapping')
  const parsed = JsonValueSchema.parse(value)
  if (!isRecord(parsed)) throw new Error('SKILL.md metadata must be a mapping')
  return parsed
}

function requiredString(
  frontmatter: Record<string, unknown>,
  field: 'name' | 'description',
): string {
  const value = frontmatter[field]
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`SKILL.md frontmatter requires ${field}`)
  }
  return value.trim()
}

function optionalString(
  frontmatter: Record<string, unknown>,
  field: 'when_to_use' | 'license',
): string | null {
  const value = frontmatter[field]
  if (value === undefined) return null
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`SKILL.md frontmatter ${field} must be a non-empty string`)
  }
  return value.trim()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
