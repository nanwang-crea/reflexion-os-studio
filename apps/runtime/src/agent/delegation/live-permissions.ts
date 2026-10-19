import type { PermissionPreset } from '@reflexion-os-studio/contracts'
import type { Store } from '../../store/index.js'
import { resolveAgentPermissions } from './instance.js'

export interface RunPermissions {
  permissionPreset: PermissionPreset
  allowedTools: ReadonlySet<string>
}

/** The root boundary is fixed; each role can change only within its live parent domain. */
export function liveRolePermissions(input: {
  store: Store
  templateId: string | null
  projectId: string | null
  inherited: () => RunPermissions
  canDelegateByDepth: boolean
}): () => RunPermissions {
  return () => {
    const inherited = input.inherited()
    const template = input.templateId
      ? input.store.agents.get(input.templateId)
      : null
    if (
      input.templateId &&
      (!template ||
        !template.enabled ||
        (template.projectId !== null && template.projectId !== input.projectId))
    ) {
      return { ...inherited, allowedTools: new Set() }
    }
    return resolveAgentPermissions({
      template,
      inheritedPreset: inherited.permissionPreset,
      inheritedTools: inherited.allowedTools,
      canDelegateByDepth: input.canDelegateByDepth,
    })
  }
}
