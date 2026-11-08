import type { ModelMessage } from '@reflexion-os-studio/agent-core'
import type { Store } from '../../store/index.js'
import {
  restoreFileWrites,
  fileWriteProgress,
} from '../tools/file-writing/state.js'

/**
 * 单次 Run 内的缓存：会话/项目/计划与用户指令在同一次 Run 内不会变化
 *（新用户消息会启动新 Run），只有文件写入进度需要每轮刷新。用它避免
 * 每轮重复全量读取 history 来重建任务上下文。
 */
export interface TaskContextCache {
  session?: ReturnType<Store['sessions']['get']>
  workspaceRoot?: string | null
  instructions?: { planId: string | null; values: string[] }
}

export function createTaskContextCache(): TaskContextCache {
  return {}
}

/** Canonical 任务状态每轮刷新；保持 user 权限，不把用户内容提升为 system。 */
export function withTaskContext(
  store: Store,
  sessionId: string,
  messages: ModelMessage[],
  cache?: TaskContextCache,
): ModelMessage[] {
  const plan = store.plans.getActive(sessionId)
  const session = cache?.session ?? store.sessions.get(sessionId)
  if (cache) cache.session = session ?? null
  const workspaceRoot =
    cache?.workspaceRoot !== undefined
      ? (cache.workspaceRoot ?? undefined)
      : session?.projectId
        ? store.projects.get(session.projectId)?.folderPath
        : undefined
  if (cache) cache.workspaceRoot = workspaceRoot ?? null
  const activeFileWrites = workspaceRoot
    ? [...restoreFileWrites(store, sessionId, workspaceRoot).values()]
        .filter((state) => state.phase === 'active')
        .map(fileWriteProgress)
    : []
  // 完成计划后保留原目标，但写入进度始终从 canonical 结果刷新。
  const existing = messages.find(
    (message) => message.role === 'user' && message.control === 'task_context',
  )
  if (!plan && existing) {
    try {
      const saved = JSON.parse(
        existing.content.slice(existing.content.indexOf('\n') + 1),
      )
      return messages.map((message) =>
        message === existing
          ? {
              ...message,
              content: `${existing.content.split('\n')[0]}\n${JSON.stringify({ ...saved, activeFileWrites })}`,
            }
          : message,
      )
    } catch {
      // 旧的非结构化上下文按当前用户请求重建。
    }
  }
  const planId = plan?.id ?? null
  const cachedInstructions =
    cache?.instructions !== undefined && cache.instructions.planId === planId
      ? cache.instructions.values
      : null
  let instructions: string[]
  if (cachedInstructions !== null) {
    instructions = cachedInstructions
  } else {
    const history = store.messages.listBySession(sessionId)
    let anchor = plan?.messageId
      ? history.findIndex((message) => message.id === plan.messageId)
      : -1
    // 计划可能绑定创建它的 assistant 消息，回溯到触发该计划的用户请求。
    while (anchor > 0 && history[anchor].role !== 'user') anchor -= 1
    instructions = (anchor >= 0 ? history.slice(anchor) : history)
      .filter((message) => message.role === 'user')
      .map((message) => message.content)
    if (cache) cache.instructions = { planId, values: instructions }
  }
  const task = {
    goal: plan?.goal ?? instructions.at(-1) ?? null,
    // 无活动计划时保留本次请求；有计划时保留原请求与后续用户约束。
    userInstructions: plan ? instructions : instructions.slice(-1),
    activeFileWrites,
    plan: plan
      ? {
          id: plan.id,
          steps: plan.steps.map(({ title, status, note }) => ({
            title,
            status,
            note,
          })),
        }
      : null,
  }
  const clean = messages.filter(
    (message) => message.role !== 'user' || message.control !== 'task_context',
  )
  if (task.goal === null) return clean
  // 紧随 system，避免把任务摘要伪装成最新用户输入。
  clean.splice(clean[0]?.role === 'system' ? 1 : 0, 0, {
    role: 'user',
    control: 'task_context',
    content: `[当前任务与用户约束，计划仅表示进度，不要求额外完成检查]\n${JSON.stringify(task)}`,
  })
  return clean
}
