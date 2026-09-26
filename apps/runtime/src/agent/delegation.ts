import type {
  ProviderProfile,
  Run,
  Session,
} from '@reflexion-os-studio/contracts'
import { RunEventEmitter, type EventNotifier } from '../events.js'
import type { Store } from '../store/index.js'
import { ChildLimitError } from './errors.js'
import { createPendingAssistantMessage, type RunLauncher } from './launcher.js'
import type { ToolContext } from './tools/shared.js'

/** 子 Agent 默认工具白名单：纯计算 + 只读文件查询，不暴露写/Shell/MCP，且无 task(不递归)。 */
const CHILD_DEFAULT_TOOLS: ReadonlySet<string> = new Set([
  'get_current_time',
  'web.fetch',
  'skill.use',
  'file.read',
  'file.list',
  'file.glob',
  'file.grep',
])

/**
 * 子 Run 委派启动器工厂：闭包持有父 Run 级计数（maxChildRuns / maxParallelChildren），
 * 单次父执行内累计，父 Run 结束后随闭包释放，无需跨 Run 清理。
 * Phase 3A 委派边界：顶层深度为 0；子 Run 固定 workspace-read，
 * 不继承父会话审批、Danger 租约或可写能力。
 */
export function createChildRunStarter(
  deps: {
    store: Store
    notifier: EventNotifier
    launcher: RunLauncher
    profile: ProviderProfile
    apiKey: string
    model: string
    sampling: { temperature?: number; maxTokens?: number }
  },
  parentRun: Run,
  parentSession: Session,
): NonNullable<ToolContext['childRunStarter']> {
  let childCount = 0
  let activeChildren = 0
  const settings = deps.store.agentSettings.get()
  return async ({ task, agentId, signal }) => {
    const parentDepth = deps.launcher.depthOf(parentRun.id)
    const { profile, apiKey } = deps
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
    const agent = deps.store.agents.get(agentId)
    if (!agent || !agent.enabled) {
      throw new Error(`agent not found or disabled: ${agentId}`)
    }
    // 委派限额强制：深度 / 总子数 / 并行数，超出抛稳定 code（由 task 工具透传）。
    const childDepth = parentDepth + 1
    if (settings.maxDepth != null && childDepth > settings.maxDepth) {
      throw new ChildLimitError(
        'child_limit_depth',
        `子 Agent 委派深度超过上限 ${settings.maxDepth}`,
      )
    }
    if (settings.maxChildRuns != null && childCount >= settings.maxChildRuns) {
      throw new ChildLimitError(
        'child_limit_runs',
        `子 Agent 数量超过上限 ${settings.maxChildRuns}`,
      )
    }
    if (
      settings.maxParallelChildren != null &&
      activeChildren >= settings.maxParallelChildren
    ) {
      throw new ChildLimitError(
        'child_limit_parallel',
        `子 Agent 并行数超过上限 ${settings.maxParallelChildren}`,
      )
    }
    childCount += 1
    activeChildren += 1

    const execution = {
      version: 1 as const,
      depth: childDepth,
      providerId: profile.id,
      model: deps.model,
      permissionPreset: 'workspace-read' as const,
      allowedTools: [...CHILD_DEFAULT_TOOLS],
      timeoutSec: settings.maxChildTimeoutSec,
      tokenBudget: settings.maxChildTotalTokens,
    }
    const setup = (() => {
      try {
        return deps.store.transaction(() => {
          const session = deps.store.sessions.create(
            parentSession.projectId,
            `子任务：${task.slice(0, 40)}`,
          )
          const delegation = deps.store.delegations.create({
            sessionId: parentSession.id,
            parentRunId: parentRun.id,
            parentAgentId: parentRun.agentId,
            agentId,
            task,
            childSessionId: session.id,
            execution,
          })
          const run = deps.store.runs.create({
            sessionId: session.id,
            providerId: profile.id,
            model: deps.model,
            parentRunId: parentRun.id,
            delegationId: delegation.id,
            agentId,
          })
          deps.store.delegations.attachChildRun(delegation.id, run.id)
          const running = deps.store.delegations.update(
            delegation.id,
            'running',
          )
          deps.store.messages.create({
            sessionId: session.id,
            runId: run.id,
            role: 'user',
            content: task,
            status: 'completed',
          })
          const assistant = createPendingAssistantMessage(
            deps.store,
            session.id,
            run,
          )
          return { session, delegation, run, assistant, running }
        })
      } catch (error) {
        childCount -= 1
        activeChildren -= 1
        throw error
      }
    })()
    const { session, delegation, run, assistant, running } = setup
    const emitter = new RunEventEmitter(run.id, deps.notifier)
    emitter.next({ type: 'delegation.created', delegation })
    emitter.next({ type: 'delegation.updated', delegation: running })

    // 子 Run 独立 AbortController：父取消传导为取消；超时以 ChildLimitError 中止
    //（不触碰父 signal，避免把子超时误标为父取消）。
    const childController = new AbortController()
    const onParentAbort = (): void => {
      childController.abort(signal.reason)
    }
    signal.addEventListener('abort', onParentAbort, { once: true })
    // signal 可能在首次检查与监听注册之间被取消；注册后重检，避免漏停子 Run。
    if (signal.aborted) onParentAbort()
    let timer: ReturnType<typeof setTimeout> | undefined
    if (settings.maxChildTimeoutSec != null) {
      timer = setTimeout(
        () =>
          childController.abort(
            new ChildLimitError(
              'child_timeout',
              `子 Run 超时(${settings.maxChildTimeoutSec}s)`,
            ),
          ),
        settings.maxChildTimeoutSec * 1000,
      )
    }
    try {
      return await new Promise<string>((resolve, reject) => {
        deps.launcher.launch({
          run,
          session,
          profile,
          apiKey,
          model: deps.model,
          sampling: deps.sampling,
          // 子 Run 权限只降不升：预设固定为最窄日常档（白名单本就无写/Shell，
          // Danger/高权限一律不继承；子会话独立，父覆盖项不外溢）。
          permissionPreset: 'workspace-read',
          depth: childDepth,
          skill: null,
          systemPrompt: agent.systemPrompt,
          assistantMessage: assistant,
          emitter,
          // child 默认无 task：不注入 childRunStarter，子 Run 不能再委派；
          // 工具白名单只允许只读能力，写/Shell/MCP 对子 Agent 默认关闭。
          childRunStarter: undefined,
          allowedTools: CHILD_DEFAULT_TOOLS,
          isolatedContext: true,
          parentSignal: childController.signal,
          childTokenBudget: settings.maxChildTotalTokens ?? undefined,
          onResult: (value) => {
            const updated = deps.store.delegations.update(
              delegation.id,
              'completed',
              value,
            )
            emitter.next({ type: 'delegation.updated', delegation: updated })
            resolve(value)
          },
          onFailure: (error) => {
            const updated = deps.store.delegations.update(
              delegation.id,
              'failed',
              null,
              error.message,
            )
            emitter.next({ type: 'delegation.updated', delegation: updated })
            const childRun = deps.store.runs.get(run.id)
            reject(
              childRun?.errorCode
                ? new ChildLimitError(childRun.errorCode, error.message)
                : error,
            )
          },
          onCancel: () => {
            const updated = deps.store.delegations.update(
              delegation.id,
              'cancelled',
              null,
              '父 Run 已取消',
            )
            emitter.next({ type: 'delegation.updated', delegation: updated })
            reject(new DOMException('The operation was aborted.', 'AbortError'))
          },
        })
      })
    } finally {
      activeChildren -= 1
      if (timer !== undefined) clearTimeout(timer)
      signal.removeEventListener('abort', onParentAbort)
    }
  }
}
