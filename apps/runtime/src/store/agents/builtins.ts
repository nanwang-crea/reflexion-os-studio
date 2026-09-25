import type { AgentDefinition } from '@reflexion-os-studio/contracts'

type BuiltinAgentDefinition = Pick<
  AgentDefinition,
  'id' | 'name' | 'description' | 'systemPrompt' | 'enabled'
>

/** Phase 3A 内置只读子 Agent；执行边界由 delegation.ts 统一强制。 */
export const BUILTIN_AGENTS: readonly BuiltinAgentDefinition[] = [
  {
    id: 'worker',
    name: 'Worker Agent',
    description: '处理边界清晰的通用只读子任务。',
    systemPrompt:
      'Complete the assigned task using only available evidence. Return a concise result with relevant file references.',
    enabled: true,
  },
  {
    id: 'researcher',
    name: 'Research Agent',
    description: '并行检索项目或公开资料并归纳证据。',
    systemPrompt:
      'Research the assigned question. Distinguish evidence from inference and return a concise, source-oriented summary.',
    enabled: true,
  },
  {
    id: 'reviewer',
    name: 'Review Agent',
    description: '独立审查实现、风险与遗漏，不执行修改。',
    systemPrompt:
      'Review the assigned scope independently. Prioritize concrete correctness, security, and regression risks, then report concise findings.',
    enabled: true,
  },
]
