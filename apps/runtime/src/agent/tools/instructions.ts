import type { ToolDefinition } from '@reflexion-os-studio/agent-core'
import { remember } from '../instructions/service.js'
import { requireString, type ToolContext } from './shared.js'

/**
 * memory.remember（纯 TS 工具）：把稳定记忆追加进应用自管的 MEMORY.md。
 * 只写数据目录，不碰用户仓库里的 AGENTS.md；免审批（permissions 白名单），
 * 可感知性由工具轨迹卡承担。
 */
export function createMemoryRememberTool(ctx: ToolContext): ToolDefinition {
  return {
    name: 'memory.remember',
    description:
      '追加一条稳定的长期记忆到 MEMORY.md。适合：用户明确纠正/表达的稳定偏好、项目纪律与踩过的坑。只记结论不记流水账，≤200 字，禁止包含任何凭据；scope=global 为跨项目偏好，scope=project 为本项目纪律（会话需已关联项目）。写错内容会被拒绝并说明原因。',
    parameters: {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: ['global', 'project'] },
        content: { type: 'string', description: '一句话、独立可读的记忆内容' },
      },
      required: ['scope', 'content'],
    },
    execute: async ({ args }) => {
      const scope = requireString(args, 'scope')
      if (scope !== 'global' && scope !== 'project') {
        return {
          content: 'scope 必须是 global 或 project。',
          isError: true,
          code: 'invalid_request',
        }
      }
      const content = requireString(args, 'content')
      const session = ctx.store.sessions.get(ctx.sessionId)
      const outcome = await remember({
        store: ctx.store,
        scope,
        content,
        projectId: session?.projectId ?? null,
      })
      return outcome.ok
        ? { content: outcome.message, isError: false }
        : { content: outcome.message, isError: true, code: outcome.code }
    },
  }
}
