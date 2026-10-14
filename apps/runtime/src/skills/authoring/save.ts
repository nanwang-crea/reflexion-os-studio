import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type {
  PluginRecord,
  SkillSaveParams,
} from '@reflexion-os-studio/contracts'
import type { Store } from '../../store/index.js'
import type { PluginPackageInstaller } from '../../plugins/installer.js'
import { containsSecretLike } from '../../agent/instructions/secretGuard.js'

/** User-reviewed declarative content goes through the existing package validator/installer. */
export async function saveAuthoredSkill(
  store: Store,
  root: string,
  installer: PluginPackageInstaller,
  input: SkillSaveParams,
): Promise<PluginRecord> {
  if (input.projectId && !store.projects.get(input.projectId))
    throw new Error('项目不存在')
  if (store.plugins.get(input.id))
    throw new Error('Skill 标识已存在，请使用新的标识')
  for (const template of store.agents.list()) {
    if (!template.projectId || template.projectId === input.projectId) continue
    const escapedId = template.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const reference = new RegExp(
      `(?<![A-Za-z0-9_-])${escapedId}(?![A-Za-z0-9_-])`,
    )
    if (reference.test(input.instructions))
      throw new Error('Skill 引用了项目角色，请保存到该角色所属项目')
  }
  // Only canonical generated role IDs are exempted, as complete tokens; never strip substrings from possible credentials.
  const checkedInstructions = input.instructions.replace(
    /(?<![A-Za-z0-9_-])template-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![A-Za-z0-9_-])/gi,
    (id) => {
      const template = store.agents.get(id)
      if (!template) return id
      return '[已验证的角色模板引用]'
    },
  )
  if (
    containsSecretLike(checkedInstructions) ||
    containsSecretLike(input.description)
  )
    throw new Error('Skill 内容疑似包含机密，拒绝保存')
  mkdirSync(root, { recursive: true })
  const temporary = mkdtempSync(join(root, '.author-'))
  try {
    writeFileSync(
      join(temporary, 'SKILL.md'),
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
    const plugin = await installer.install(
      {
        source: 'local',
        path: temporary,
        installScope: input.projectId ? 'project' : 'global',
        installProjectId: input.projectId ?? undefined,
      },
      {},
    )
    // Keep the local source usable for the existing update lifecycle after temporary cleanup.
    return store.plugins.upsert({ ...plugin, sourceRef: plugin.installPath })
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
}
