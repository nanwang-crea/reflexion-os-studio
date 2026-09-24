import { existsSync, lstatSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  PluginCompatSchema,
  PROTOCOL_VERSION,
  SkillManifestSchema,
} from '@reflexion-os-studio/contracts'
import type { SkillDefinition } from './types.js'

export interface ParsedSkill {
  definition: SkillDefinition
  compat: { protocol: string } | null
}

export function assertSkillFileIsSafe(directory: string): void {
  if (lstatSync(directory).isSymbolicLink()) {
    throw new Error('symlinks are not allowed')
  }
  const skillFile = join(directory, 'SKILL.md')
  if (!existsSync(skillFile)) throw new Error('SKILL.md is missing')
  if (lstatSync(skillFile).isSymbolicLink()) {
    throw new Error('SKILL.md must not be a symlink')
  }
}

export function parseSkillFile(path: string): ParsedSkill {
  const source = readFileSync(path, 'utf8')
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(source)
  if (!match) throw new Error('SKILL.md requires YAML frontmatter')
  const raw = parseFrontmatter(match[1])
  const allowed = new Set([
    'id',
    'name',
    'version',
    'description',
    'tools',
    'argumentHint',
    'compat',
    'source',
  ])
  const unknown = Object.keys(raw).filter((key) => !allowed.has(key))
  if (unknown.length > 0) {
    throw new Error(`unknown manifest fields: ${unknown.join(', ')}`)
  }
  const manifest = SkillManifestSchema.parse({
    id: raw.id,
    name: raw.name,
    version: raw.version,
    description: raw.description,
    tools: raw.tools ?? [],
    argumentHint: raw.argumentHint ?? null,
  })
  const instructions = match[2].trim()
  if (instructions === '') throw new Error('instructions must not be empty')
  const compat =
    raw.compat === undefined ? null : PluginCompatSchema.parse(raw.compat)
  return { definition: { manifest, instructions }, compat }
}

export function assertCompatible(compat: { protocol: string } | null): void {
  if (compat === null) return
  const requested = compat.protocol.split('.').map(Number)
  const current = PROTOCOL_VERSION.split('.').map(Number)
  if (
    requested[0] > current[0] ||
    (requested[0] === current[0] && requested[1] > current[1])
  ) {
    throw new Error(
      `requires protocol ${compat.protocol}; runtime is ${PROTOCOL_VERSION}`,
    )
  }
}

function parseFrontmatter(text: string): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  const lines = text.split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue
    const match = /^([A-Za-z][A-Za-z0-9]*):\s*(.*)$/.exec(line)
    if (!match) throw new Error(`unsupported frontmatter line: ${line}`)
    const [, key, rawValue] = match
    if (rawValue === '' && key === 'tools') {
      const tools: string[] = []
      while (index + 1 < lines.length) {
        const item = /^\s+-\s+(.+)$/.exec(lines[index + 1])
        if (!item) break
        tools.push(item[1].replace(/^["']|["']$/g, ''))
        index += 1
      }
      result[key] = tools
      continue
    }
    if (rawValue === '' && key === 'compat') {
      const protocol = /^\s+protocol:\s*["']?([^"']+?)["']?\s*$/.exec(
        lines[index + 1] ?? '',
      )?.[1]
      if (!protocol) throw new Error('compat.protocol is required')
      result[key] = { protocol }
      index += 1
      continue
    }
    if (rawValue.startsWith('[')) {
      result[key] = JSON.parse(rawValue.replace(/'/g, '"'))
    } else if (key === 'compat') {
      const protocol = /^\{\s*protocol:\s*["']?([^"'} ]+)["']?\s*\}$/.exec(
        rawValue,
      )?.[1]
      if (!protocol) throw new Error('compat must be { protocol: "x.y" }')
      result[key] = { protocol }
    } else if (rawValue === 'null' || rawValue === '~' || rawValue === '') {
      result[key] = null
    } else {
      result[key] = rawValue.replace(/^["']|["']$/g, '')
    }
  }
  return result
}
