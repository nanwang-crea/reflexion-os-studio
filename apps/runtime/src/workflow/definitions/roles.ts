import type {
  WorkflowDefinition,
  WorkflowVersion,
} from '@reflexion-os-studio/contracts'
import type { Store } from '../../store/index.js'
import { canonicalJson } from '../graph/json-schema.js'

/** Freeze trusted templates on selection; unchanged saved snapshots stay unchanged. */
export function freezeWorkflowRoles(
  store: Store,
  definition: WorkflowDefinition,
  previous: WorkflowVersion | null,
): WorkflowDefinition {
  return {
    ...definition,
    nodes: definition.nodes.map((node) => {
      if (node.kind !== 'agent' || node.role.templateId === null) return node
      const old = previous?.definition.nodes.find((item) => item.id === node.id)
      if (
        old?.kind === 'agent' &&
        canonicalJson(old.role) === canonicalJson(node.role)
      )
        return node
      const template = store.agents.get(node.role.templateId)
      if (!template?.enabled)
        throw new Error('Role template is missing or disabled')
      return {
        ...node,
        role: {
          templateId: template.id,
          templateUpdatedAt: template.updatedAt,
          name: template.name,
          systemPrompt: template.systemPrompt,
          policy: {
            ...template.policy,
            allowedTools: template.policy.allowedTools.filter(
              (tool) => !['task', 'ask_user'].includes(tool),
            ),
            canDelegate: false as const,
          },
        },
      }
    }),
  }
}
