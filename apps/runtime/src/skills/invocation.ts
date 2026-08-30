import type { SkillDefinition } from './types.js'

/** 斜杠命令前缀：/<skillId> 后跟空格或行尾；id 形如 code-review。 */
const SLASH_INVOCATION_RE = /^\/([a-z0-9][a-z0-9-]*)(?:\s|$)/

export interface ResolvedInvocation {
  /** 激活的 Skill；普通消息为 null。 */
  skill: SkillDefinition | null
  /** 激活来源：显式参数 / 斜杠命令 / 未激活。 */
  via: 'explicit' | 'slash' | 'none'
}

/**
 * 解析一次消息发送的 Skill 激活：显式 skillId 优先（未知 id 抛错，客户端写错了要立刻反馈），
 * 否则识别消息开头的 /<skillId>（不匹配任何技能时视为普通文本，不报错）。
 */
export function resolveInvocation(
  content: string,
  explicitSkillId: string | undefined,
  registry: { get(id: string): SkillDefinition | null },
): ResolvedInvocation {
  if (explicitSkillId !== undefined) {
    const skill = registry.get(explicitSkillId)
    if (!skill) {
      throw new Error(`unknown skillId: ${explicitSkillId}`)
    }
    return { skill, via: 'explicit' }
  }
  const slash = SLASH_INVOCATION_RE.exec(content.trimStart())
  if (slash) {
    const skill = registry.get(slash[1])
    if (skill) return { skill, via: 'slash' }
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
  }[],
): string {
  if (manifests.length === 0) return ''
  const lines = manifests.map(
    (manifest) =>
      `- /${manifest.id} — ${manifest.name}：${manifest.description}${
        manifest.argumentHint
          ? `（用法：/${manifest.id} ${manifest.argumentHint}）`
          : ''
      }`,
  )
  return [
    '',
    '## 可用 Skills',
    '以下技能封装了完成一类任务的既定做法。用户消息以 /<id> 开头表示要使用该技能；',
    '未用斜杠但任务与某个技能高度匹配时，先调用 skill.use 加载完整说明再行动。',
    ...lines,
  ].join('\n')
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
