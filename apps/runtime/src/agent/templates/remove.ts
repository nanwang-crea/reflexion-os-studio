import { agentTemplateCommands } from '@reflexion-os-studio/contracts'
import type { Store } from '../../store/index.js'
import { CommandError } from '../errors.js'

/** Validate every snapshot before deletion; one stale target rolls back the batch. */
export function bulkRemoveTemplates(params: unknown, store: Store) {
  try {
    const { targets } =
      agentTemplateCommands['agent_template.bulk_remove'].params.parse(params)
    return store.transaction(() => {
      for (const target of targets) {
        const role = store.agents.get(target.id)
        if (!role) throw new Error('所选角色已被删除，请刷新后重新选择')
        if (role.builtin) throw new Error('内置角色不可删除')
        if (role.updatedAt !== target.updatedAt)
          throw new Error(`“${role.name}”已被修改，请刷新后重新选择`)
      }
      for (const target of targets) {
        if (!store.agents.removeUser(target.id))
          throw new Error('删除失败，未删除任何角色')
      }
      return { removedIds: targets.map((target) => target.id) }
    })
  } catch (error) {
    throw new CommandError(
      'invalid_request',
      error instanceof Error ? error.message : '批量删除失败',
    )
  }
}
