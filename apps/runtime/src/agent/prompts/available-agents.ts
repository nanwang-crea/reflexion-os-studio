import type {
  AgentDefinition,
  AgentTemplate,
} from '@reflexion-os-studio/contracts'

/** 把 Registry 中当前可委派定义投影到 Primary prompt；执行权限仍由 Runtime 强制。 */
export function availableAgentsPromptSection(
  agents: readonly AgentDefinition[],
): string {
  const enabled = agents.filter((agent) => agent.enabled)
  if (enabled.length === 0) return ''
  const lines = enabled.map((agent) => {
    const template = agent as Partial<AgentTemplate>
    const model =
      template.modelBinding?.mode === 'fixed'
        ? `${template.modelBinding.providerId}/${template.modelBinding.model}`
        : '继承当前模型'
    const policy = agent.policy
    return `- ${agent.id}: ${agent.name} — ${agent.description}；领域：${template.domains?.join('、') || '通用'}；模型：${model}；权限上限：${policy.permissionCeiling}；工具：${policy.allowedTools.join('、')}；继续委派：${policy.canDelegate ? '允许' : '不允许'}`
  })
  return `\n\n[可用子 Agent]（可选模板）\n模板不是固定角色。调用 task 时可选择 templateId，也可不选模板并动态给出 name、role、instructions。\n${lines.join('\n')}`
}
