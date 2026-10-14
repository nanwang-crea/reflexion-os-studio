import { randomUUID } from 'node:crypto'
import {
  SkillAuthorInputSchema,
  SkillPrepareInputSchema,
  skillAuthoringParameters,
  type JsonValue,
} from '@reflexion-os-studio/contracts'
import type { ToolDefinition } from '@reflexion-os-studio/agent-core'
import type { ToolContext } from './shared.js'
import { validateAuthoredSkill } from '../../skills/authoring/validation.js'

export function skillSaveReview(
  ctx: Pick<ToolContext, 'store' | 'projectId'>,
  args: JsonValue,
): string {
  try {
    const input = SkillAuthorInputSchema.parse(args)
    if (input.scope === 'project' && ctx.projectId === null)
      throw new Error('当前会话没有项目')
    const projectId = input.scope === 'project' ? ctx.projectId : null
    validateAuthoredSkill(ctx.store, {
      ...input,
      projectId,
      requestId: 'review',
    })
    return JSON.stringify({ ...input, projectId }, null, 2)
  } catch {
    return 'Skill 配置尚未通过校验，保存工具会返回原因；不会安装或覆盖。'
  }
}

export function createSkillSaveTool(ctx: ToolContext): ToolDefinition {
  return {
    name: 'skill.save',
    description:
      '经一次审批保存标准 Skill 和文本 scripts/references/assets。scope 为当前项目或全局；更新必须传 mode=update 和 expectedVersion，保留未提供的资源。不会执行资源脚本或修改内置 Skill。',
    parameters: skillAuthoringParameters.save as JsonValue,
    execution: { effect: 'state', idempotent: false },
    async execute({ args, signal }) {
      if (ctx.store.runs.get(ctx.runId)?.parentRunId !== null)
        throw new Error('仅主 Agent 可保存技能')
      if (ctx.store.sessions.get(ctx.sessionId)?.executionMode === 'plan')
        throw new Error('计划模式不能保存技能')
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
      if (!ctx.skillTools) throw new Error('Skill 保存服务不可用')
      const input = SkillAuthorInputSchema.parse(args)
      if (input.scope === 'project' && ctx.projectId === null)
        throw new Error('当前会话没有项目')
      const plugin = await ctx.skillTools.save({
        ...input,
        projectId: input.scope === 'project' ? ctx.projectId : null,
        requestId: randomUUID(),
      })
      const data = {
        id: plugin.id,
        version: plugin.version,
        scope: plugin.scope,
        projectId: plugin.projectId,
        enabled: plugin.enabled,
      }
      return { content: JSON.stringify(data), data, isError: false }
    },
  }
}

export function createSkillPrepareTool(ctx: ToolContext): ToolDefinition {
  return {
    name: 'skill.prepare',
    description:
      '准备当前项目可见且已启用 Skill 的 Run 临时资源快照，返回 scripts/references/assets 文件清单、快照目录和实际 Node 解释器路径；resource 可按需读文本。仅复制资源，不执行脚本。使用 shell.execute 按现有会话权限运行，cwd 使用工作区相对路径（通常为 .），产物写工作区而非快照；退出当前 Run 后快照失效。',
    parameters: skillAuthoringParameters.prepare as JsonValue,
    execution: { effect: 'read', resourceKeys: () => [] },
    execute({ args, signal }) {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
      const input = SkillPrepareInputSchema.parse(args)
      if (!ctx.skillTools) throw new Error('Skill 资源服务不可用')
      const data = ctx.skillTools.prepare(
        input.skillId,
        ctx.projectId,
        ctx.runId,
        input.resource,
      )
      return { content: JSON.stringify(data), data, isError: false }
    },
  }
}
