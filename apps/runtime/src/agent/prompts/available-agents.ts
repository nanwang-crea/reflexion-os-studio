import type { AgentDefinition } from '@reflexion-os-studio/contracts'

/** 把 Registry 中当前可委派定义投影到 Primary prompt；执行权限仍由 Runtime 强制。 */
export function availableAgentsPromptSection(
  agents: readonly AgentDefinition[],
): string {
  const enabled = agents.filter((agent) => agent.enabled)
  if (enabled.length === 0) return ''
  const lines = enabled.map(
    (agent) => `- ${agent.id}: ${agent.name} — ${agent.description}`,
  )
  return `\n\n[可用子 Agent]（可选模板）\n模板不是固定角色。调用 task 时可选择 templateId，也可不选模板并动态给出 name、role、instructions。\n${lines.join('\n')}`
}
