import type { SkillDefinition } from './types.js'

const SKILL_INVOCATION_RE = /^([/$])([a-z0-9][a-z0-9-]*)(?:\s|$)/
const MAX_DESCRIPTION_CHARS = 250
const MAX_SKILL_METADATA_CHARS = 6_000

export interface ResolvedInvocation {
  /** 激活的 Skill；普通消息为 null。 */
  skill: SkillDefinition | null
  /** 激活来源：显式参数 / 命令前缀 / 未激活。 */
  via: 'explicit' | 'slash' | 'dollar' | 'none'
}

/**
 * 解析一次消息发送的 Skill 激活：显式 skillId 优先（未知 id 抛错，客户端写错了要立刻反馈），
 * 否则识别消息开头的 /<skillId>（不匹配任何技能时视为普通文本，不报错）。
 */
export function resolveInvocation(
  content: string,
  explicitSkillId: string | undefined,
  registry: {
    get(id: string, projectId?: string | null): SkillDefinition | null
  },
  projectId: string | null = null,
): ResolvedInvocation {
  if (explicitSkillId !== undefined) {
    const skill = registry.get(explicitSkillId, projectId)
    if (!skill) {
      throw new Error(`unknown skillId: ${explicitSkillId}`)
    }
    return { skill, via: 'explicit' }
  }
  const invocation = SKILL_INVOCATION_RE.exec(content.trimStart())
  if (invocation) {
    const skill = registry.get(invocation[2], projectId)
    if (skill) {
      return { skill, via: invocation[1] === '$' ? 'dollar' : 'slash' }
    }
  }
  return { skill: null, via: 'none' }
}

/** 供 system prompt 注入的可用 Skills 清单段落。 */
export function skillsPromptSection(
  manifests: {
    id: string
    name: string
    description: string
    argumentHint: string | null
    whenToUse?: string | null
  }[],
): string {
  if (manifests.length === 0) return ''
  const detailedLines = manifests.map(
    (manifest) =>
      `- $${manifest.id} — ${manifest.name}：${skillTriggerDescription(manifest).slice(0, MAX_DESCRIPTION_CHARS)}${
        manifest.argumentHint
          ? `（用法：$${manifest.id} ${manifest.argumentHint}）`
          : ''
      }`,
  )
  const detailed = detailedLines.join('\n')
  const lines =
    detailed.length <= MAX_SKILL_METADATA_CHARS
      ? detailedLines
      : manifests.map((manifest) => `- $${manifest.id} — ${manifest.name}`)
  return [
    '',
    '## 可用 Skills',
    '以下技能封装了完成一类任务的既定做法。用户消息以 $<id> 或 /<id> 开头表示要使用该技能；',
    '未显式指定但任务与某个技能高度匹配时，先调用 skill.use 加载完整说明再行动。',
    ...lines,
  ].join('\n')
}

function skillTriggerDescription(manifest: {
  description: string
  whenToUse?: string | null
}): string {
  return manifest.whenToUse
    ? `${manifest.description}；触发时机：${manifest.whenToUse}`
    : manifest.description
}

/** 已激活 Skill 的注入段落：完整 instructions + 生效声明。 */
export function activeSkillPromptSection(skill: SkillDefinition): string {
  return [
    '',
    `## 已激活 Skill：${skill.manifest.name}（/${skill.manifest.id} v${skill.manifest.version}）`,
    '本次回复必须按以下技能说明执行；说明与用户最新要求冲突时，以用户要求为准并说明取舍。',
    '',
    skill.instructions,
  ].join('\n')
}
