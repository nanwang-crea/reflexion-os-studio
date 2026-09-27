import { randomUUID } from 'node:crypto'
import type {
  AgentInstance,
  AgentSpawnSpec,
  AgentTemplate,
  PermissionPreset,
} from '@reflexion-os-studio/contracts'

export const INHERITABLE_CHILD_TOOLS = [
  'get_current_time',
  'web.fetch',
  'skill.use',
  'ask_user',
  'file.read',
  'file.list',
  'file.glob',
  'file.grep',
  'file.write',
  'file.edit',
  'file.delete',
  'file.move',
  'file.mkdir',
  'shell.execute',
  'task',
]

const PRESET_RANK: Record<PermissionPreset, number> = {
  'workspace-read': 0,
  'workspace-write': 1,
  'workspace-full': 2,
}

function narrowPreset(
  inherited: PermissionPreset,
  ceiling: PermissionPreset,
): PermissionPreset {
  return PRESET_RANK[inherited] <= PRESET_RANK[ceiling] ? inherited : ceiling
}

export function createAgentInstance(input: {
  spawn: AgentSpawnSpec
  template: AgentTemplate | null
  inheritedPreset: PermissionPreset
  inheritedTools: ReadonlySet<string>
  permissionDomainId: string
  canDelegateByDepth: boolean
}): AgentInstance {
  const inherited = [...input.inheritedTools].filter(
    (tool) => INHERITABLE_CHILD_TOOLS.includes(tool) || tool.includes('/'),
  )
  const effectiveTools = input.template
    ? inherited.filter((tool) =>
        input.template!.policy.allowedTools.includes(tool),
      )
    : inherited
  const permissionPreset = input.template
    ? narrowPreset(
        input.inheritedPreset,
        input.template.policy.permissionCeiling,
      )
    : input.inheritedPreset
  const canDelegate =
    input.canDelegateByDepth &&
    (input.template?.policy.canDelegate ?? true) &&
    effectiveTools.includes('task')
  const allowedTools = new Set(effectiveTools)
  if (!canDelegate) allowedTools.delete('task')
  const instructions = [
    input.template?.systemPrompt,
    input.spawn.role ? `Role: ${input.spawn.role}` : undefined,
    input.spawn.instructions,
    'Complete only the assigned task. Report evidence, actions, and unresolved risks concisely.',
  ].filter((part): part is string => Boolean(part))
  return {
    id: `agent-${randomUUID()}`,
    name: input.spawn.name ?? input.template?.name ?? 'Dynamic Agent',
    role:
      input.spawn.role ??
      input.template?.description ??
      'delegated task specialist',
    templateId: input.template?.id ?? null,
    instructions: instructions.join('\n\n'),
    permissionPreset,
    permissionDomainId: input.permissionDomainId,
    allowedTools: [...allowedTools],
    canDelegate,
    createdAt: new Date().toISOString(),
  }
}
