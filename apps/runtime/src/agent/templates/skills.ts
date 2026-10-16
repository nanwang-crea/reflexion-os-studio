import type {
  AgentTemplate,
  AgentTemplateSaveParams,
} from '@reflexion-os-studio/contracts'
import type { SkillRegistry } from '../../skills/registry.js'

export function resolveRoleSkills(
  input: Pick<AgentTemplateSaveParams, 'skills' | 'projectId' | 'allowedTools'>,
  registry: SkillRegistry,
) {
  const bindings = input.skills ?? []
  if (
    bindings.some((item) => item.mode === 'preferred') &&
    !input.allowedTools.includes('skill.use')
  )
    throw new Error('按需优先技能需要允许 skill.use 工具')
  const resolved = bindings.map((binding) => {
    const skill = registry.get(binding.skillId, input.projectId ?? null)
    if (!skill)
      throw new Error(`角色技能不可用或不属于当前作用域：${binding.skillId}`)
    return { binding, skill }
  })
  const instructionBytes = resolved
    .filter(({ binding }) => binding.mode === 'startup')
    .reduce(
      (total, { skill }) =>
        total + Buffer.byteLength(skill.instructions, 'utf8'),
      0,
    )
  if (instructionBytes > 100 * 1024)
    throw new Error('启动技能说明合计超过 100KB，请改为按需优先')
  return resolved
}

/** Resolve before a child is created; instructions and versions become instance snapshots. */
export function roleSkillsSnapshot(
  template: AgentTemplate | null,
  registry?: SkillRegistry,
  projectId?: string | null,
) {
  if (!template?.skills?.length) return { instructions: '', skills: [] }
  if (!registry) throw new Error('角色技能注册表不可用')
  const resolved = resolveRoleSkills(
    {
      ...template,
      projectId: projectId ?? null,
      allowedTools: template.policy.allowedTools,
    },
    registry,
  )
  return {
    skills: resolved.map(({ binding, skill }) => ({
      ...binding,
      version: skill.manifest.version,
    })),
    instructions: [
      '角色关联技能（不改变工具权限与审批）：',
      ...resolved.map(({ binding, skill }) =>
        binding.mode === 'startup'
          ? `Skill ${skill.manifest.id} v${skill.manifest.version}（启动加载）\n${skill.instructions}\n包内资源按需通过 skill.prepare 获取；脚本仅经 shell.execute 执行。`
          : `优先技能 ${skill.manifest.id} v${skill.manifest.version}：${skill.manifest.description}。任务匹配时先调用 skill.use 加载完整说明。`,
      ),
    ].join('\n\n'),
  }
}
