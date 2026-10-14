import type { ToolDefinition } from '@reflexion-os-studio/agent-core'
import type { SkillRegistry } from '../../skills/index.js'
import { requireString } from './shared.js'

/**
 * Skill 加载工具（纯 TS）：把指定技能的完整说明返回给模型。
 * 模型先从 system prompt 的"可用 Skills"清单挑选，再由此工具取正文；
 * 技能只约定"怎么做"，能力仍来自已注册的工具与权限策略。
 */
export function createSkillUseTool(
  registry: SkillRegistry,
  projectId: string | null,
): ToolDefinition {
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
      const skill = registry.get(skillId, projectId)
      if (!skill) {
        const known = registry
          .list(projectId)
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
          ...(manifest.whenToUse ? [`触发时机：${manifest.whenToUse}`] : []),
          '',
          skill.instructions,
          '',
          '包内 scripts/references/assets 路径相对技能目录。需要资源时调用 skill.prepare 获取临时快照目录与文件清单；按需脚本通过 shell.execute 执行，沿用当前工具权限与沙箱，不在加载时执行。',
        ].join('\n'),
        isError: false,
      }
    },
  }
}
