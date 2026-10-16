import { resolveRoleSkills } from './skills.js'
import type { SkillRegistry } from '../../skills/registry.js'
import { agentTemplateCommands } from '@reflexion-os-studio/contracts'
import type { Store } from '../../store/index.js'
import { CommandError } from '../errors.js'

/** Validate the complete selection before committing, preserving unedited fields. */
export function bulkUpdateTemplates(
  params: unknown,
  store: Store,
  registry?: SkillRegistry,
) {
  try {
    const { targets, patch } =
      agentTemplateCommands['agent_template.bulk_update'].params.parse(params)
    return store.transaction(() => {
      if (patch.projectId && !store.projects.get(patch.projectId))
        throw new Error('目标项目不存在')
      const originals = targets.map((target) => {
        const role = store.agents.get(target.id)
        if (!role) throw new Error('所选角色已被删除，请刷新后重新选择')
        if (role.builtin) throw new Error('内置角色请先复制，再批量配置')
        if (role.updatedAt !== target.updatedAt)
          throw new Error(`“${role.name}”已被修改，请刷新后重新选择`)
        return role
      })
      return {
        templates: originals.map((role) => {
          const canDelegate = patch.canDelegate ?? role.policy.canDelegate
          let allowedTools = patch.allowedTools ?? role.policy.allowedTools
          if (
            patch.canDelegate !== undefined ||
            patch.allowedTools !== undefined
          ) {
            allowedTools = canDelegate
              ? [...new Set([...allowedTools, 'task'])]
              : allowedTools.filter((tool) => tool !== 'task')
          }
          if (role.skills.length) {
            if (!registry) throw new Error('角色技能注册表不可用')
            resolveRoleSkills(
              {
                skills: role.skills,
                projectId:
                  patch.projectId === undefined
                    ? role.projectId
                    : patch.projectId,
                allowedTools,
              },
              registry,
            )
          }
          return store.agents.saveUser({
            id: role.id,
            name: role.name,
            description: role.description,
            systemPrompt: role.systemPrompt,
            domains: role.domains,
            modelBinding: role.modelBinding,
            projectId:
              patch.projectId === undefined ? role.projectId : patch.projectId,
            enabled: patch.enabled ?? role.enabled,
            permissionCeiling:
              patch.permissionCeiling ?? role.policy.permissionCeiling,
            allowedTools,
            canDelegate,
          })
        }),
      }
    })
  } catch (error) {
    throw new CommandError(
      'invalid_request',
      error instanceof Error ? error.message : String(error),
    )
  }
}
