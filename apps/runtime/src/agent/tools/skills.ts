import type { ToolDefinition } from '@reflexion-os-studio/agent-core'
import type { SkillRegistry } from '../../skills/index.js'
import { requireString } from './shared.js'

/**
 * Skill 加载工具（纯 TS）：把指定技能的完整说明返回给模型。
 * 模型先从 system prompt 的"可用 Skills"清单挑选，再由此工具取正文；
 * 技能只约定"怎么做"，能力仍来自已注册的工具与权限策略。
 */
export function createSkillUseTool(registry: SkillRegistry): ToolDefinition {
  return {
    name: 'skill.use',
    description:
      '加载一个可用 Skill 的完整执行说明。任务与 system prompt 中"可用 Skills"列表里的某项匹配时，先调用本工具再按说明行动。',
    parameters: {
      type: 'object',
      properties: {
        skillId: {
          type: 'string',
          description: 'Skill 的稳定 id，如 code-review',
        },
      },
      required: ['skillId'],
    },
    execute: ({ args }) => {
      const skillId = requireString(args, 'skillId')
      const skill = registry.get(skillId)
      if (!skill) {
        const known = registry
          .list()
          .map((manifest) => manifest.id)
          .join(', ')
        return {
          content: `未找到 Skill：${skillId}。可用：${known || '（无）'}`,
          isError: true,
          code: 'skill_not_found',
        }
      }
      const manifest = skill.manifest
      return {
        content: [
          `Skill：${manifest.name}（/${manifest.id} v${manifest.version}）`,
          `适用：${manifest.description}`,
          '',
          skill.instructions,
        ].join('\n'),
        isError: false,
      }
    },
  }
}
