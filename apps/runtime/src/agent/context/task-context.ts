import type { ModelMessage } from '@reflexion-os-studio/agent-core'
import type { Store } from '../../store/index.js'

/** Canonical 任务状态每轮刷新；保持 user 权限，不把用户内容提升为 system。 */
export function withTaskContext(
  store: Store,
  sessionId: string,
  messages: ModelMessage[],
): ModelMessage[] {
  const plan = store.plans.getActive(sessionId)
  // 本 Run 完成计划后仍保留已有目标，避免临近收尾退回仅有“继续”。
  if (
    !plan &&
    messages.some(
      (message) =>
        message.role === 'user' && message.control === 'task_context',
    )
  )
    return messages
  const history = store.messages.listBySession(sessionId)
  let anchor = plan?.messageId
    ? history.findIndex((message) => message.id === plan.messageId)
    : -1
  // 计划可能绑定创建它的 assistant 消息，回溯到触发该计划的用户请求。
  while (anchor > 0 && history[anchor].role !== 'user') anchor -= 1
  const instructions = (anchor >= 0 ? history.slice(anchor) : history)
    .filter((message) => message.role === 'user')
    .map((message) => message.content)
  const task = {
    goal: plan?.goal ?? instructions.at(-1) ?? null,
    // 无活动计划时保留本次请求；有计划时保留原请求与后续用户约束。
    userInstructions: plan ? instructions : instructions.slice(-1),
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
