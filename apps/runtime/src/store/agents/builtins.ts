import type { AgentDefinition } from '@reflexion-os-studio/contracts'

type BuiltinAgentDefinition = Pick<
  AgentDefinition,
  'id' | 'name' | 'description' | 'systemPrompt' | 'policy' | 'enabled'
>

const READ_TOOLS = [
  'task.inspect',
  'get_current_time',
  'web.fetch',
  'skill.use',
  'file.read',
  'file.list',
  'file.glob',
  'file.grep',
]

function readOnlyPolicy(
  canDelegate: boolean,
  browser = false,
): AgentDefinition['policy'] {
  return {
    version: 1,
    permissionCeiling: 'workspace-read',
    allowedTools: [
      ...READ_TOOLS,
      ...(browser ? ['browser.navigate', 'browser.read', 'browser.close'] : []),
      ...(canDelegate ? ['task'] : []),
    ],
    canDelegate,
  }
}

/** Phase 3A 内置只读子 Agent；执行边界由 delegation.ts 统一强制。 */
export const BUILTIN_AGENTS: readonly BuiltinAgentDefinition[] = [
  {
    id: 'worker',
    name: 'Worker Agent',
    description: '处理边界清晰的通用只读子任务。',
    systemPrompt:
      'Complete the assigned task using only available evidence. Return a concise result with relevant file references.',
    policy: readOnlyPolicy(true),
    enabled: true,
  },
  {
    id: 'researcher',
    name: 'Research Agent',
    description: '并行检索项目或公开资料并归纳证据。',
    systemPrompt:
      'Research the assigned question. Use skill.use(web-research) for public web research: discover real URLs with browser.navigate/read, then verify source pages. web.fetch only reads a known URL; never invent article links. If browser tools are unavailable, report that limitation and use supplied evidence. Distinguish facts from inference and return citations.',
    policy: readOnlyPolicy(true, true),
    enabled: true,
  },
  {
    id: 'reviewer',
    name: 'Review Agent',
    description: '独立审查实现、风险与遗漏，不执行修改。',
    systemPrompt:
      'Review the assigned scope independently. Prioritize concrete correctness, security, and regression risks, then report concise findings.',
    policy: readOnlyPolicy(false),
    enabled: true,
  },
]
