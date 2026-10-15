import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { PluginPackageManifestSchema } from '@reflexion-os-studio/contracts'
import { cleanupTemporaryBestEffort } from '../../plugins/cleanup.js'
import {
  inspectPackage,
  packageManifestForBuiltin,
} from '../../plugins/package.js'
import { BUILTIN_SKILLS } from './index.js'

function isManaged(directory: string, id: string): boolean {
  if (!lstatSync(directory).isDirectory()) return false
  const path = join(directory, 'plugin.json')
  if (!lstatSync(path).isFile()) return false
  const manifest = PluginPackageManifestSchema.parse(
    JSON.parse(readFileSync(path, 'utf8')),
  )
  return (
    manifest.id === id &&
    manifest.skill?.metadata?.reflexionManagedBuiltin === 'true'
  )
}

function atomicWrite(directory: string, name: string, content: string): void {
  const temporary = join(directory, `.builtin-write-${randomUUID()}`)
  try {
    writeFileSync(temporary, content, { encoding: 'utf8', flag: 'wx' })
    renameSync(temporary, join(directory, name))
  } finally {
    cleanupTemporaryBestEffort(temporary)
  }
}

/** Export shipped skills as ordinary packages without replacing user-owned directories. */
export function materializeBuiltinSkills(root: string): Map<string, string> {
  const paths = new Map<string, string>()
  for (const definition of BUILTIN_SKILLS) {
    const directory = join(root, definition.manifest.id)
    let stage: string | undefined
    try {
      const existing = existsSync(directory)
      if (existing && !isManaged(directory, definition.manifest.id)) continue
      const manifest = packageManifestForBuiltin(definition)
      if (!manifest.skill) throw new Error('Skill manifest missing')
      manifest.skill.metadata = {
        ...manifest.skill.metadata,
        reflexionManagedBuiltin: 'true',
      }
      const files = {
        'SKILL.md': [
          '---',
          `name: ${definition.manifest.id}`,
          `description: ${JSON.stringify(definition.manifest.description)}`,
          '---',
          '',
          definition.instructions,
          '',
        ].join('\n'),
        'plugin.json': `${JSON.stringify(manifest, null, 2)}\n`,
      }
      let target = directory
      if (existing) {
        for (const name of readdirSync(directory)) {
          if (/^\.builtin-write-[\da-f-]{36}$/.test(name)) {
            const path = join(directory, name)
            if (!lstatSync(path).isDirectory()) cleanupTemporaryBestEffort(path)
          }
        }
      } else {
        mkdirSync(root, { recursive: true })
        stage = mkdtempSync(join(root, '.stage-builtin-'))
        target = join(stage, 'package')
        mkdirSync(target)
      }
      for (const [name, content] of Object.entries(files))
        atomicWrite(target, name, content)
      inspectPackage(target)
      if (!existing) renameSync(target, directory)
      paths.set(definition.manifest.id, directory)
    } catch {
      process.stderr.write(
        `[runtime] builtin Skill ${definition.manifest.id} package unavailable\n`,
      )
    } finally {
      if (stage) cleanupTemporaryBestEffort(stage)
    }
  }
  return paths
}
