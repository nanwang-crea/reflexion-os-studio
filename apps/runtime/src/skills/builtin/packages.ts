import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  unlinkSync,
} from 'node:fs'
import { join } from 'node:path'
import { cleanupTemporaryBestEffort } from '../../plugins/cleanup.js'
import {
  inspectPackage,
  packageManifestForBuiltin,
} from '../../plugins/package.js'
import { atomicBuiltinWrite, BuiltinPackageStorage } from './storage.js'
import { formatStandardSkill } from '../../plugins/standard-skill.js'
import { BUILTIN_SKILLS } from './index.js'

/** Export shipped skills as ordinary packages without replacing user-owned directories. */
export function materializeBuiltinSkills(root: string): Map<string, string> {
  const paths = new Map<string, string>()
  const storage = new BuiltinPackageStorage(root)
  for (const definition of BUILTIN_SKILLS) {
    const directory = join(root, definition.manifest.id)
    let stage: string | undefined
    try {
      const existing = existsSync(directory)
      if (existing && !storage.owns(directory, definition.manifest.id)) continue
      const manifest = packageManifestForBuiltin(definition)
      const content = formatStandardSkill(
        {
          name: manifest.id,
          description: manifest.description,
          ...(manifest.skill?.whenToUse
            ? { when_to_use: manifest.skill.whenToUse }
            : {}),
          ...(manifest.skill?.license
            ? { license: manifest.skill.license }
            : {}),
          metadata: { ...manifest.skill?.metadata, version: manifest.version },
        },
        definition.instructions,
      )
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
      atomicBuiltinWrite(target, 'SKILL.md', content)
      // Persist ownership before removing the old marker or publishing a new directory.
      storage.remember(manifest)
      if (existsSync(join(target, 'plugin.json')))
        unlinkSync(join(target, 'plugin.json'))
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
