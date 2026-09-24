import { existsSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PluginPackageManifestSchema } from '@reflexion-os-studio/contracts'
import { parseSkillFile } from '../skills/manifest.js'
import { copyPackage } from './sources.js'

const ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/

export function migrateLegacySkills(
  legacyRoot: string,
  pluginsRoot: string,
  builtinIds: ReadonlySet<string>,
): void {
  if (!existsSync(legacyRoot)) return
  for (const entry of readdirSync(legacyRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !ID_PATTERN.test(entry.name)) continue
    const target = join(pluginsRoot, entry.name)
    if (existsSync(target) || builtinIds.has(entry.name)) continue
    try {
      copyPackage(join(legacyRoot, entry.name), target)
      if (!existsSync(join(target, 'plugin.json'))) {
        writeFileSync(
          join(target, 'plugin.json'),
          JSON.stringify(legacyManifest(target), null, 2),
        )
      }
    } catch (error) {
      rmSync(target, { recursive: true, force: true })
      process.stderr.write(
        `[runtime] legacy skill ${entry.name} migration failed: ${String(error)}\n`,
      )
    }
  }
}

function legacyManifest(directory: string) {
  const parsed = parseSkillFile(join(directory, 'SKILL.md'))
  return PluginPackageManifestSchema.parse({
    manifestVersion: 1,
    id: parsed.definition.manifest.id,
    name: parsed.definition.manifest.name,
    version: parsed.definition.manifest.version,
    description: parsed.definition.manifest.description,
    type: 'skill',
    entry: 'SKILL.md',
    compatibility: parsed.compat ?? { protocol: '^1.3' },
    capabilities: ['skill.instructions'],
    permissions: { filesystem: 'none', network: false, shell: false },
    skill: {
      tools: parsed.definition.manifest.tools,
      argumentHint: parsed.definition.manifest.argumentHint,
    },
  })
}
