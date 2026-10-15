import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import {
  PluginPackageManifestSchema,
  type PluginPackageManifest,
} from '@reflexion-os-studio/contracts'
import { cleanupTemporaryBestEffort } from '../../plugins/cleanup.js'

export function atomicBuiltinWrite(
  directory: string,
  name: string,
  content: string,
): void {
  const temporary = join(directory, `.builtin-write-${randomUUID()}`)
  try {
    writeFileSync(temporary, content, { encoding: 'utf8', flag: 'wx' })
    renameSync(temporary, join(directory, name))
  } finally {
    cleanupTemporaryBestEffort(temporary)
  }
}

/** Ownership is application state, separate from portable Skill content. */
export class BuiltinPackageStorage {
  private readonly directory: string

  constructor(skillsRoot: string) {
    this.directory = join(skillsRoot, '..', 'builtin-skills')
  }

  owns(directory: string, id: string): boolean {
    if (!lstatSync(directory).isDirectory()) return false
    if (existsSync(this.directory) && !lstatSync(this.directory).isDirectory())
      return false
    const record = join(this.directory, `${id}.json`)
    const legacy = join(directory, 'plugin.json')
    // A legacy manifest is also checked when present; never read symlinks.
    if (existsSync(legacy) && !lstatSync(legacy).isFile()) return false
    return this.matches(record, id) || this.matches(legacy, id)
  }

  remember(manifest: PluginPackageManifest): void {
    mkdirSync(this.directory, { recursive: true })
    if (!lstatSync(this.directory).isDirectory())
      throw new Error('Builtin ownership directory must be a regular directory')
    atomicBuiltinWrite(
      this.directory,
      `${manifest.id}.json`,
      `${JSON.stringify(
        {
          ...manifest,
          skill: {
            ...manifest.skill,
            metadata: {
              ...manifest.skill?.metadata,
              reflexionManagedBuiltin: 'true',
            },
          },
        },
        null,
        2,
      )}\n`,
    )
  }

  private matches(path: string, id: string): boolean {
    if (!existsSync(path)) return false
    if (!lstatSync(path).isFile()) return false
    const manifest = PluginPackageManifestSchema.parse(
      JSON.parse(readFileSync(path, 'utf8')),
    )
    return (
      manifest.id === id &&
      manifest.skill?.metadata?.reflexionManagedBuiltin === 'true'
    )
  }
}
