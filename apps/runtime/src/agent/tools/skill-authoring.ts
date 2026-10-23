import { randomUUID } from 'node:crypto'
import {
  SkillAuthorInputSchema,
  SkillPrepareInputSchema,
  skillAuthoringParameters,
  type JsonValue,
  type SkillPrepared,
} from '@reflexion-os-studio/contracts'
import type { ToolDefinition } from '@reflexion-os-studio/agent-core'
import type { ToolContext } from './shared.js'
import { validateAuthoredSkill } from '../../skills/authoring/validation.js'
import { MODEL_TOOL_RESULT_MAX_CHARS } from '../run/toolResults.js'

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
      '准备当前项目可见且已启用 Skill 的 Run 临时资源快照，返回 scripts/references/assets 文件清单、快照目录和实际 Node 解释器路径；resource 按需分页读 UTF-8 文本，offset 为字节偏移，limit 默认且最多 100000 字节。大文件自动返回第一页；hasMore=true 时用 nextOffset 继续读取，不要把第一页当全文。仅复制资源，不执行脚本。使用 shell.execute 按现有会话权限运行，cwd 使用工作区相对路径（通常为 .），产物写工作区而非快照；退出当前 Run 后快照失效。',
    parameters: skillAuthoringParameters.prepare as JsonValue,
    execution: { effect: 'read', resourceKeys: () => [] },
    execute({ args, signal }) {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
      try {
        const input = SkillPrepareInputSchema.parse(args)
        if (!ctx.skillTools) throw new Error('Skill 资源服务不可用')
        const data = fitResourcePage(
          ctx.skillTools.prepare(
            input.skillId,
            ctx.projectId,
            ctx.runId,
            input.resource,
            { offset: input.offset, limit: input.limit },
          ),
        )
        return { content: serializePrepared(data), data, isError: false }
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') throw error
        const message = error instanceof Error ? error.message : String(error)
        return {
          content: `Skill 资源准备失败：${message}`,
          isError: true,
          code: 'tool_error',
        }
      }
    },
  }
}

/** Snapshot metadata is available separately; keep page feedback focused. */
function serializePrepared(data: SkillPrepared): string {
  if (data.resource === null) return JSON.stringify(data)
  return JSON.stringify({
    skillId: data.skillId,
    version: data.version,
    resource: data.resource,
  })
}

/** Keep complete page text inside model feedback; truncation would skip bytes. */
function fitResourcePage(data: SkillPrepared): SkillPrepared {
  if (
    data.resource === null ||
    serializePrepared(data).length <= MODEL_TOOL_RESULT_MAX_CHARS
  )
    return data
  const page = data.resource
  const bomBytes = page.bytesRead - Buffer.byteLength(page.content, 'utf8')
  const prefix = (length: number): SkillPrepared => {
    const content = page.content
      .slice(0, length)
      .replace(/[\uD800-\uDBFF]$/, '')
    const bytesRead = bomBytes + Buffer.byteLength(content, 'utf8')
    const nextOffset = page.offset + bytesRead
    return {
      ...data,
      resource: {
        ...page,
        content,
        bytesRead,
        hasMore: nextOffset < page.totalBytes,
        nextOffset: nextOffset < page.totalBytes ? nextOffset : null,
      },
    }
  }
  let low = 0
  let high = page.content.length
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (serializePrepared(prefix(middle)).length <= MODEL_TOOL_RESULT_MAX_CHARS)
      low = middle
    else high = middle - 1
  }
  return prefix(low)
}
