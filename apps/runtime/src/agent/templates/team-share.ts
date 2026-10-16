import { resolveRoleSkills } from './skills.js'
import type { SkillRegistry } from '../../skills/registry.js'
import { randomUUID } from 'node:crypto'
import {
  agentTemplateCommands,
  AgentTeamShareSchema,
  MAX_AGENT_TEAM_SHARE_BYTES,
} from '@reflexion-os-studio/contracts'
import type { Store } from '../../store/index.js'
import { CommandError } from '../errors.js'
import { portableRole, writeRoleShare } from './share.js'
import { validateRoleTemplate } from './validation.js'

export async function exportTeam(params: unknown, store: Store) {
  const input =
    agentTemplateCommands['agent_template.team_export'].params.parse(params)
  const members = store.agents
    .list()
    .filter(
      (role) =>
        role.projectId === input.projectId &&
        role.domains.includes(`team:${input.teamId}`),
    )
  const selected = input.templateIds
    ? input.templateIds.map((id) => {
        const role = members.find((member) => member.id === id)
        if (!role)
          throw new CommandError(
            'invalid_request',
            '所选角色不属于该团队或已被删除，请刷新后重新选择',
          )
        return role
      })
    : members
  if (!selected.length)
    throw new CommandError('invalid_request', '团队没有可导出的角色')
  const archive = AgentTeamShareSchema.parse({
    format: 'reflexion-team',
    version: 1,
    teamId: input.teamId,
    roles: selected.map((role) => ({
      ...portableRole(role),
      domains: role.domains.filter((domain) => !domain.startsWith('team:')),
    })),
  })
  const result = await writeRoleShare(
    archive,
    input.directory,
    'team',
    MAX_AGENT_TEAM_SHARE_BYTES,
  )
  return { ...result, roleCount: selected.length }
}

export function importTeam(
  params: unknown,
  store: Store,
  registry?: SkillRegistry,
) {
  try {
    const input =
      agentTemplateCommands['agent_template.team_import'].params.parse(params)
    if (
      Buffer.byteLength(JSON.stringify(input.archive), 'utf8') >
      MAX_AGENT_TEAM_SHARE_BYTES
    )
      throw new Error('团队文件超过 4MB 上限')
    return store.transaction(() => {
      const existing = store.agents
        .list()
        .filter((role) => role.projectId === input.projectId)
      let teamId = input.archive.teamId
      while (existing.some((role) => role.domains.includes(`team:${teamId}`)))
        teamId = `import-${randomUUID().slice(0, 8)}`
      const roles = input.archive.roles.map((role) => {
        const draft = {
          ...role,
          domains: [
            ...(role.domains ?? []).filter(
              (domain) => !domain.startsWith('team:'),
            ),
            `team:${teamId}`,
          ],
          projectId: input.projectId,
          modelBinding: { mode: 'inherit' as const },
          enabled: false,
        }
        const validated = agentTemplateCommands['agent_template.save'].params
          .omit({ requestId: true })
          .parse(draft)
        validateRoleTemplate(store, validated)
        if (validated.skills?.length) {
          if (!registry) throw new Error('角色技能注册表不可用')
          resolveRoleSkills(validated, registry)
        }
        return validated
      })
      return {
        templates: roles.map((role) => store.agents.saveUser(role)),
        teamId,
      }
    })
  } catch {
    throw new CommandError(
      'invalid_request',
      '团队导入失败：请检查文件格式、项目、分类数量和角色内容；未保存任何角色',
    )
  }
}
