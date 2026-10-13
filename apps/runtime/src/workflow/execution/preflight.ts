import type {
  PermissionPreset,
  ProviderProfile,
  WorkflowAgentNode,
  WorkflowDefinition,
  WorkflowValidationIssue,
} from '@reflexion-os-studio/contracts'
import { INHERITABLE_CHILD_TOOLS } from '../../agent/delegation/instance.js'

const PRESET_RANK: Record<PermissionPreset, number> = {
  'workspace-read': 0,
  'workspace-write': 1,
  'workspace-full': 2,
}

export function effectiveNodePolicy(
  node: WorkflowAgentNode,
  permissionPreset: PermissionPreset,
  availableTools: ReadonlySet<string>,
): {
  permissionPreset: PermissionPreset
  allowedTools: string[]
  canDelegate: false
} {
  const ceiling = node.role.policy.permissionCeiling
  return {
    permissionPreset:
      PRESET_RANK[permissionPreset] <= PRESET_RANK[ceiling]
        ? permissionPreset
        : ceiling,
    allowedTools: node.role.policy.allowedTools.filter(
      (tool) =>
        tool !== 'task' &&
        availableTools.has(tool) &&
        (INHERITABLE_CHILD_TOOLS.includes(tool) || tool.includes('/')),
    ),
    canDelegate: false,
  }
}

/** No credentials are accessed while resolving node models and tool availability. */
export function preflightWorkflow(
  definition: WorkflowDefinition,
  input: {
    defaultModel: { providerId: string; model: string }
    providers: readonly ProviderProfile[]
    availableTools: ReadonlySet<string>
  },
): {
  models: { nodeId: string; providerId: string; model: string }[]
  issues: WorkflowValidationIssue[]
} {
  const models: { nodeId: string; providerId: string; model: string }[] = []
  const issues: WorkflowValidationIssue[] = []
  for (const node of definition.nodes) {
    if (node.kind !== 'agent') continue
    const selected =
      node.model.mode === 'default' ? input.defaultModel : node.model
    const provider = input.providers.find(
      (item) => item.id === selected.providerId,
    )
    if (
      !provider?.enabled ||
      !provider.capabilities.includes('chat') ||
      !provider.models.includes(selected.model)
    ) {
      issues.push({
        code: 'model_unavailable',
        path: node.id,
        message: 'Selected chat model is unavailable',
      })
    } else
      models.push({
        nodeId: node.id,
        providerId: provider.id,
        model: selected.model,
      })
    for (const tool of node.role.policy.allowedTools) {
      if (
        tool === 'task' ||
        !input.availableTools.has(tool) ||
        (!INHERITABLE_CHILD_TOOLS.includes(tool) && !tool.includes('/'))
      )
        issues.push({
          code: 'tool_unavailable',
          path: node.id,
          message: `Tool is unavailable for this workflow: ${tool}`,
        })
    }
  }
  return { models: issues.length ? [] : models, issues }
}
