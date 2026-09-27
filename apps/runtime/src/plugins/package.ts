import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  statSync,
} from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import {
  PluginPackageManifestSchema,
  PROTOCOL_VERSION,
  compareSemVer,
  skillManifestFromPackage,
  type PluginPackageManifest,
} from '@reflexion-os-studio/contracts'
import type { SkillDefinition } from '../skills/types.js'

const MAX_PACKAGE_FILES = 1_000
const MAX_PACKAGE_BYTES = 16 * 1024 * 1024
const ALLOWED_ROOT_ENTRIES = new Set([
  'plugin.json',
  'SKILL.md',
  'assets',
  'references',
  'scripts',
])
const FORBIDDEN_NAMES = new Set([
  '.env',
  '.git',
  '.gnupg',
  '.ssh',
  'credentials.json',
  'secrets.json',
  'id_token',
])

export interface LoadedSkillPackage {
  manifest: PluginPackageManifest
  definition: SkillDefinition
}

export function resolvePackageDirectory(path: string): string {
  const absolute = resolve(path)
  const info = lstatSync(absolute)
  if (info.isSymbolicLink()) throw new Error('symlinks are not allowed')
  if (info.isDirectory()) return absolute
  if (!info.isFile())
    throw new Error('plugin source must be a file or directory')
  if (!['plugin.json', 'SKILL.md'].includes(basename(absolute))) {
    throw new Error('plugin file must be plugin.json or SKILL.md')
  }
  return dirname(absolute)
}

export function inspectPackage(directory: string): PluginPackageManifest {
  assertPackageTree(directory)
  const manifestPath = join(directory, 'plugin.json')
  if (!existsSync(manifestPath)) throw new Error('plugin.json is missing')
  const manifest = PluginPackageManifestSchema.parse(
    JSON.parse(readFileSync(manifestPath, 'utf8')),
  )
  assertCompatible(manifest.compatibility.protocol)
  if (manifest.type !== 'skill') {
    throw new Error(`plugin type ${manifest.type} is not loadable yet`)
  }
  const entry = resolve(directory, manifest.entry)
  const relativeEntry = relative(resolve(directory), entry)
  if (
    relativeEntry.startsWith('..') ||
    lstatSync(entry).isSymbolicLink() ||
    !lstatSync(entry).isFile()
  ) {
    throw new Error('plugin entry must be a regular file inside the package')
  }
  return manifest
}

export function loadSkillPackage(directory: string): LoadedSkillPackage {
  const manifest = inspectPackage(directory)
  const instructions = parseSkillInstructions(
    readFileSync(join(directory, manifest.entry), 'utf8'),
  )
  return {
    manifest,
    definition: {
      manifest: skillManifestFromPackage(manifest),
      instructions,
    },
  }
}

export function packageManifestForBuiltin(
  definition: SkillDefinition,
): PluginPackageManifest {
  const tools = definition.manifest.tools
  const writesWorkspace = tools.some((tool) =>
    [
      'file.write',
      'file.write_stream',
      'file.edit',
      'file.delete',
      'file.move',
      'file.mkdir',
    ].includes(tool),
  )
  const readsWorkspace = tools.some(
    (tool) => tool.startsWith('file.') || tool.startsWith('workspace.'),
  )
  return PluginPackageManifestSchema.parse({
    manifestVersion: 1,
    id: definition.manifest.id,
    name: definition.manifest.name,
    version: definition.manifest.version,
    description: definition.manifest.description,
    type: 'skill',
    entry: 'SKILL.md',
    compatibility: { protocol: '^1.3' },
    capabilities: ['skill.instructions'],
    permissions: {
      filesystem: writesWorkspace
        ? 'workspace-write'
        : readsWorkspace
          ? 'workspace-read'
          : 'none',
      network: tools.includes('web.fetch'),
      shell: tools.includes('shell.execute'),
    },
    skill: {
      tools,
      argumentHint: definition.manifest.argumentHint,
    },
  })
}

export const compareVersions = compareSemVer

function assertPackageTree(directory: string): void {
  const root = resolve(directory)
  if (lstatSync(root).isSymbolicLink())
    throw new Error('symlinks are not allowed')
  let files = 0
  let bytes = 0
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const normalized = entry.name.toLowerCase()
      if (entry.isSymbolicLink()) throw new Error('symlinks are not allowed')
      if (
        entry.name.startsWith('.') ||
        FORBIDDEN_NAMES.has(normalized) ||
        normalized.endsWith('.key') ||
        normalized.endsWith('.pem') ||
        normalized.endsWith('.token')
      ) {
        throw new Error(`forbidden plugin package entry: ${entry.name}`)
      }
      if (current === root && !ALLOWED_ROOT_ENTRIES.has(entry.name)) {
        throw new Error(`unsupported plugin root entry: ${entry.name}`)
      }
      const path = join(current, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.isFile()) {
        files += 1
        bytes += statSync(path).size
        if (files > MAX_PACKAGE_FILES || bytes > MAX_PACKAGE_BYTES) {
          throw new Error('plugin package exceeds size limits')
        }
      } else {
        throw new Error(`unsupported plugin entry: ${entry.name}`)
      }
    }
  }
  walk(root)
}

function parseSkillInstructions(source: string): string {
  const frontmatter = /^---\r?\n[\s\S]*?\r?\n---\r?\n([\s\S]*)$/.exec(source)
  const instructions = (frontmatter?.[1] ?? source).trim()
  if (instructions === '')
    throw new Error('skill instructions must not be empty')
  return instructions
}

function assertCompatible(range: string): void {
  const current = normalizeProtocol(PROTOCOL_VERSION)
  const checks = range.startsWith('^')
    ? [
        { operator: '>=', version: normalizeProtocol(range.slice(1)) },
        {
          operator: '<',
          version: [normalizeProtocol(range.slice(1))[0] + 1, 0, 0],
        },
      ]
    : range.split(/\s+/).map((part) => {
        const match = /^(>=|>|<=|<|=)?(.+)$/.exec(part)
        if (!match) throw new Error(`invalid protocol range: ${range}`)
        return {
          operator: match[1] ?? '=',
          version: normalizeProtocol(match[2]),
        }
      })
  const compatible = checks.every(({ operator, version }) => {
    const difference = compareParts(current, version)
    if (operator === '>=') return difference >= 0
    if (operator === '>') return difference > 0
    if (operator === '<=') return difference <= 0
    if (operator === '<') return difference < 0
    return difference === 0
  })
  if (!compatible) {
    throw new Error(
      `requires protocol ${range}; runtime is ${PROTOCOL_VERSION}`,
    )
  }
}

function normalizeProtocol(value: string): number[] {
  const parts = value.split('.').map(Number)
  return [parts[0], parts[1], parts[2] ?? 0]
}

function compareParts(left: number[], right: number[]): number {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index]
  }
  return 0
}
