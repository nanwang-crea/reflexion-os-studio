import type {
  DelegationResult,
  PermissionPreset,
  ProviderProfile,
  Run,
  Session,
} from '@reflexion-os-studio/contracts'
import { RunEventEmitter, type EventNotifier } from '../../events.js'
import type { Store } from '../../store/index.js'
import { ChildLimitError } from '../errors.js'
import { createPendingAssistantMessage, type RunLauncher } from '../launcher.js'
import type { ToolContext } from '../tools/shared.js'
import { DelegationBudgetCoordinator } from './budget.js'
import { RootMutationCoordinator } from './mutations.js'
import { createAgentInstance, INHERITABLE_CHILD_TOOLS } from './instance.js'

export interface ChildRunDependencies {
  store: Store
  notifier: EventNotifier
  launcher: RunLauncher
  profile: ProviderProfile
  apiKey: string
  model: string
  sampling: { temperature?: number; maxTokens?: number }
  budget?: DelegationBudgetCoordinator
  permissionPreset?: PermissionPreset
  permissionDomainId?: string
  inheritedTools?: ReadonlySet<string>
  mutationCoordinator?: RootMutationCoordinator
  defaultTemplateId?: string
}

export function createChildRunStarter(
  deps: ChildRunDependencies,
  parentRun: Run,
  parentSession: Session,
): NonNullable<ToolContext['childRunStarter']> {
  const settings = deps.store.agentSettings.get()
  const budget =
    deps.budget ??
    new DelegationBudgetCoordinator(
      parentRun.parentRunId ?? parentRun.id,
      settings,
      deps.store.delegations.listByRootRun(
        parentRun.parentRunId ?? parentRun.id,
      ).length,
    )
  const childDeps = { ...deps, budget }
  return async (input) => {
    const { task, signal } = input
    const legacyAgentId = (input as unknown as { agentId?: string }).agentId
    const requestedSpawn = input.agent ?? {
      templateId: legacyAgentId,
    }
    const spawn = {
      ...requestedSpawn,
      templateId: deps.defaultTemplateId ?? requestedSpawn.templateId,
    }
    const permissionDomainId = deps.permissionDomainId ?? parentSession.id
    const mutationCoordinator =
      deps.mutationCoordinator ?? new RootMutationCoordinator()
    const parentPreset =
      deps.permissionPreset ??
      deps.launcher.permissionPresetOf?.(parentRun.id) ??
      'workspace-read'
    const inheritedTools =
      deps.inheritedTools ?? new Set(INHERITABLE_CHILD_TOOLS)
    const childDepth = deps.launcher.depthOf(parentRun.id) + 1
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
    if (
      childDepth > 4 ||
      (settings.maxDepth !== null && childDepth > settings.maxDepth)
    ) {
      throw new ChildLimitError(
        'child_limit_depth',
        `子 Agent 委派深度超过上限 ${Math.min(settings.maxDepth ?? 4, 4)}`,
      )
    }
    const template = spawn.templateId
      ? deps.store.agents.get(spawn.templateId)
      : null
    if (spawn.templateId && (!template || !template.enabled)) {
      throw new Error(`agent not found or disabled: ${spawn.templateId}`)
    }
    const lease = budget.acquire()
    const instance = createAgentInstance({
      spawn,
      template,
      inheritedPreset: parentPreset,
      inheritedTools,
      permissionDomainId,
      canDelegateByDepth:
        settings.enableChildRuns &&
        childDepth < Math.min(settings.maxDepth ?? 4, 4),
    })
    const { permissionPreset, canDelegate } = instance
    const allowedTools = new Set(instance.allowedTools)
    const execution = {
      version: 3 as const,
      rootRunId: budget.rootRunId,
      permissionDomainId,
      depth: childDepth,
      providerId: deps.profile.id,
      model: deps.model,
      permissionPreset,
      allowedTools: [...allowedTools],
      instance,
      timeoutSec: settings.maxChildTimeoutSec,
      tokenBudget: settings.maxChildTotalTokens,
      treeRunBudget: settings.maxChildRuns,
      treeParallelBudget: settings.maxParallelChildren,
    }
    let setup
    try {
      setup = deps.store.transaction(() => {
        const session = deps.store.sessions.create(
          parentSession.projectId,
          `子任务：${task.slice(0, 40)}`,
        )
        const delegation = deps.store.delegations.create({
          sessionId: parentSession.id,
          parentRunId: parentRun.id,
          rootRunId: budget.rootRunId,
          parentAgentId: parentRun.agentId,
          agentId: instance.id,
          agentInstance: instance,
          task,
          childSessionId: session.id,
          execution,
        })
        const run = deps.store.runs.create({
          sessionId: session.id,
          providerId: deps.profile.id,
          model: deps.model,
          parentRunId: parentRun.id,
          delegationId: delegation.id,
          agentId: instance.id,
        })
        deps.store.delegations.attachChildRun(delegation.id, run.id)
        const running = deps.store.delegations.update(delegation.id, 'running')
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
      lease.rollback()
      throw error
    }
    const { session, delegation, run, assistant, running } = setup
    const emitter = new RunEventEmitter(run.id, deps.notifier)
    emitter.next({ type: 'delegation.created', delegation })
    emitter.next({ type: 'delegation.updated', delegation: running })
    const controller = new AbortController()
    const abort = (): void => controller.abort(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    const timer =
      settings.maxChildTimeoutSec === null
        ? undefined
        : setTimeout(
            () =>
              controller.abort(
                new ChildLimitError(
                  'child_timeout',
                  `子 Run 超时(${settings.maxChildTimeoutSec}s)`,
                ),
              ),
            settings.maxChildTimeoutSec * 1000,
          )
    try {
      return await new Promise<DelegationResult>((resolve, reject) => {
        deps.launcher.launch({
          run,
          session,
          profile: deps.profile,
          apiKey: deps.apiKey,
          model: deps.model,
          sampling: deps.sampling,
          permissionPreset,
          permissionDomainId,
          rootRunId: budget.rootRunId,
          mutationCoordinator,
          depth: childDepth,
          skill: null,
          systemPrompt: instance.instructions,
          assistantMessage: assistant,
          emitter,
          childRunStarter: canDelegate
            ? createChildRunStarter(
                {
                  ...childDeps,
                  permissionPreset,
                  permissionDomainId,
                  inheritedTools: allowedTools,
                  mutationCoordinator,
                },
                run,
                session,
              )
            : undefined,
          allowedTools,
          isolatedContext: true,
          parentSignal: controller.signal,
          childTokenBudget: settings.maxChildTotalTokens ?? undefined,
          onResult: (summary) => {
            const result = deps.store.delegations.buildStructuredResult(
              run.id,
              summary,
            )
            const updated = deps.store.delegations.update(
              delegation.id,
              'completed',
              summary,
              null,
              result,
            )
            emitter.next({ type: 'delegation.updated', delegation: updated })
            resolve(result)
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
      lease.release()
      if (timer !== undefined) clearTimeout(timer)
      signal.removeEventListener('abort', abort)
    }
  }
}
