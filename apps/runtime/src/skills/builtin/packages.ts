import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  inspectPackage,
  packageManifestForBuiltin,
} from '../../plugins/package.js'
import { BUILTIN_SKILLS } from './index.js'

/** Export shipped skills as ordinary packages without replacing user-owned directories. */
export function materializeBuiltinSkills(root: string): Map<string, string> {
  const paths = new Map<string, string>()
  for (const definition of BUILTIN_SKILLS) {
    const directory = join(root, definition.manifest.id)
    try {
      if (existsSync(directory)) {
        const previous = inspectPackage(directory)
        if (previous.skill?.metadata?.reflexionManagedBuiltin !== 'true')
          continue
      }
      mkdirSync(directory, { recursive: true })
      const manifest = packageManifestForBuiltin(definition)
      if (!manifest.skill) throw new Error('Skill manifest missing')
      manifest.skill.metadata = {
        ...manifest.skill.metadata,
        reflexionManagedBuiltin: 'true',
      }
      writeFileSync(
        join(directory, 'SKILL.md'),
        [
          '---',
          `name: ${definition.manifest.id}`,
          `description: ${JSON.stringify(definition.manifest.description)}`,
          '---',
          '',
          definition.instructions,
          '',
        ].join('\n'),
        'utf8',
      )
      writeFileSync(
        join(directory, 'plugin.json'),
        `${JSON.stringify(manifest, null, 2)}\n`,
        'utf8',
      )
      paths.set(definition.manifest.id, directory)
    } catch {
      process.stderr.write(
        `[runtime] builtin Skill ${definition.manifest.id} package unavailable\n`,
      )
    }
  }
  return paths
}
