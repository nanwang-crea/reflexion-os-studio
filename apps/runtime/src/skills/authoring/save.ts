import {
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  rmSync,
  realpathSync,
  lstatSync,
} from 'node:fs'
import { join, relative, isAbsolute } from 'node:path'
import type {
  PluginRecord,
  SkillSaveParams,
} from '@reflexion-os-studio/contracts'
import type { Store } from '../../store/index.js'
import type { PluginPackageInstaller } from '../../plugins/installer.js'
import { validateAuthoredSkill, validateResourcePath } from './validation.js'
import { copyPackage } from '../../plugins/sources.js'
import { inspectPackage } from '../../plugins/package.js'

/** User-reviewed declarative content goes through the existing package validator/installer. */
export async function saveAuthoredSkill(
  store: Store,
  root: string,
  installer: PluginPackageInstaller,
  input: SkillSaveParams,
): Promise<PluginRecord> {
  const current = validateAuthoredSkill(store, input)
  mkdirSync(root, { recursive: true })
  const temporary = mkdtempSync(join(root, '.author-'))
  try {
    let directory = temporary
    if (current?.installPath) {
      if (lstatSync(current.installPath).isSymbolicLink())
        throw new Error('Skill 包不能是符号链接')
      const source = realpathSync(current.installPath)
      const within = relative(realpathSync(root), source)
      if (!within || within.startsWith('..') || isAbsolute(within))
        throw new Error('Skill 路径不在受管目录')
      inspectPackage(source)
      directory = join(temporary, 'package')
      copyPackage(source, directory)
      const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+]|$)/.exec(current.version)
      if (!match || !Number.isSafeInteger(Number(match[3]) + 1))
        throw new Error('Skill 版本不能递增')
      writeFileSync(
        join(directory, 'plugin.json'),
        JSON.stringify(
          {
            ...current.manifest,
            description: input.description,
            version: `${match[1]}.${match[2]}.${Number(match[3]) + 1}`,
          },
          null,
          2,
        ),
        'utf8',
      )
    }
    for (const resource of input.resources ?? []) {
      if (resource.path === current?.manifest.entry)
        throw new Error('资源路径不能覆盖 Skill 入口')
      const target = join(directory, ...validateResourcePath(resource.path))
      mkdirSync(join(target, '..'), { recursive: true })
      writeFileSync(target, resource.content, 'utf8')
    }
    writeFileSync(
      join(directory, current?.manifest.entry ?? 'SKILL.md'),
      [
        '---',
        `name: ${input.id}`,
        `description: ${JSON.stringify(input.description)}`,
        '---',
        '',
        input.instructions.trim(),
        '',
      ].join('\n'),
      'utf8',
    )
    const source = {
      source: 'local' as const,
      path: directory,
      installScope: input.projectId
        ? ('project' as const)
        : ('global' as const),
      installProjectId: input.projectId ?? undefined,
    }
    const plugin = current
      ? await installer.updateFromSource(input.id, source, {})
      : await installer.install(source, {})
    // Keep the local source usable for the existing update lifecycle after temporary cleanup.
    return store.plugins.upsert({ ...plugin, sourceRef: plugin.installPath })
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
}
