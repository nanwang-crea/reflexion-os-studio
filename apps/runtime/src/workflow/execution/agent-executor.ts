import { assertWorkflowValuesSafe } from '../security/content.js'
import { ChildLimitError } from '../../agent/errors.js'
import { loadSecret } from '../../secrets.js'
import { randomUUID } from 'node:crypto'
import { WorkflowValuesSchema } from '@reflexion-os-studio/contracts'
import type { ChatAgent } from '../../agent/index.js'
import type { Store } from '../../store/index.js'
import { createPendingAssistantMessage } from '../../agent/launcher.js'
import { resolveSampling } from '../../agent/provider-resolver.js'
import { workflowNodePrompt } from '../../agent/prompts/workflow-node.js'
import { RunEventEmitter, type EventNotifier } from '../../events.js'
import { effectiveNodePolicy } from './preflight.js'
import { validatePortValues } from '../graph/ports.js'
import type { WorkflowAgentExecutor } from './types.js'

export class AgentWorkflowExecutor implements WorkflowAgentExecutor {
  constructor(
    private readonly store: Store,
    private readonly agent: ChatAgent,
    private readonly notifier: EventNotifier,
  ) {}

  async execute(
    input: Parameters<WorkflowAgentExecutor['execute']>[0],
  ): ReturnType<WorkflowAgentExecutor['execute']> {
    if (input.signal.aborted) throw new DOMException('Aborted', 'AbortError')
    const live = this.store.providers.get(input.providerId)
    if (
      !live?.enabled ||
      !live.capabilities.includes('chat') ||
      !live.models.includes(input.model) ||
      live.secretRef !== input.profile.secretRef
    )
      throw new Error('workflow_configuration_unavailable')
    const apiKey = loadSecret(input.profile.secretRef)
    if (!apiKey) throw new Error('workflow_configuration_unavailable')
    const resolved = { profile: input.profile, apiKey, model: input.model }
    if (
      input.node.role.policy.allowedTools.some(
        (tool) => !this.agent.workflow.tools(input.projectId).has(tool),
      )
    )
      throw new Error('workflow_configuration_unavailable')
    const policy = effectiveNodePolicy(
      input.node,
      input.permissionPreset,
      this.agent.workflow.tools(input.projectId),
    )
    let nodeTokens = 0
    const setup = this.store.transaction(() => {
      const attempt = this.store.workflowAttempts.get(input.attemptId)
      if (
        !attempt ||
        attempt.status !== 'running' ||
        attempt.agentRunId !== null
      )
        throw new Error('workflow_attempt_already_started')
      const session = this.store.sessions.create(
        input.projectId,
        `Workflow: ${input.node.name}`,
      )
      const run = this.store.runs.create({
        sessionId: session.id,
        providerId: resolved.profile.id,
        model: resolved.model,
        agentId: randomUUID(),
      })
      this.store.workflowAttempts.update({
        ...attempt,
        agentRunId: run.id,
        sessionId: session.id,
      })
      this.store.messages.create({
        sessionId: session.id,
        runId: run.id,
        role: 'user',
        content: JSON.stringify({
          task: input.node.taskPrompt,
          inputs: input.inputs,
          provenance: 'upstream_data_untrusted',
        }),
        status: 'completed',
      })
      const assistant = createPendingAssistantMessage(
        this.store,
        session.id,
        run,
      )
      return { session, run, assistant }
    })
    const settings = this.store.agentSettings.get()
    const { run, session, assistant } = setup
    return new Promise((resolve, reject) => {
      const fail = (error: unknown) =>
        reject(
          error instanceof Error ? error : new Error('workflow_node_failed'),
        )
      try {
        this.agent.workflow.launch({
          run,
          session,
          profile: resolved.profile,
          apiKey: resolved.apiKey,
          model: resolved.model,
          sampling: {
            ...resolveSampling(resolved.profile),
            maxTokens: Math.min(
              resolved.profile.maxTokens ?? input.node.budget.maxTokens,
              input.node.budget.maxTokens,
            ),
          },
          permissionPreset: policy.permissionPreset,
          approvalOverride: input.approvalOverride,
          permissionDomainId: input.permissionDomainId,
          rootRunId: run.id,
          workflowRunId: input.workflowRunId,
          mutationCoordinator: input.mutationCoordinator,
          skill: null,
          systemPrompt: workflowNodePrompt(input.node),
          assistantMessage: assistant,
          emitter: new RunEventEmitter(run.id, this.notifier),
          allowedTools: new Set(policy.allowedTools),
          parentSignal: input.signal,
          isolatedContext: true,
          runSettings: {
            ...settings,
            maxRunTotalTokens: Math.min(
              input.node.budget.maxTokens,
              settings.maxRunTotalTokens ?? Infinity,
            ),
            maxToolCalls: Math.min(
              input.node.budget.maxToolCalls,
              settings.maxToolCalls ?? Infinity,
            ),
            maxRunTimeoutSec: Math.min(
              input.node.budget.maxExecutionSec,
              settings.maxRunTimeoutSec ?? Infinity,
            ),
          },
          onBeforeModel: input.onBeforeModel,
          onToolBatch: input.onToolBatch,
          beforeToolInvoke: input.beforeToolInvoke,
          onModelResult: (usage, estimated) => {
            input.onModelResult(usage, estimated)
            nodeTokens += usage.promptTokens + usage.completionTokens
            if (nodeTokens > input.node.budget.maxTokens)
              throw new ChildLimitError(
                'run_token_budget',
                'Node token budget exhausted',
              )
          },
          persistResult: (content) => {
            let values = null
            try {
              if (content.length > 2 * 1024 * 1024)
                throw new Error('output_limit')
              const parsed = WorkflowValuesSchema.parse(JSON.parse(content))
              assertWorkflowValuesSafe(parsed)
              if (!validatePortValues(input.node.outputs, parsed).length)
                values = parsed
            } catch {
              /* Invalid output is a durable validation failure, never repaired by re-execution. */
            }
            this.store.workflowAttempts.stageResult({
              attemptId: input.attemptId,
              values,
              errorCode: values === null ? 'output_validation_failed' : null,
            })
          },
          onResult: () => {
            const result = this.store.workflowAttempts.result(input.attemptId)
            if (!result?.values) {
              fail(new Error('output_validation_failed'))
              return
            }
            resolve({
              agentRunId: run.id,
              sessionId: session.id,
              outputs: result.values,
            })
          },
          onFailure: (error) =>
            fail(
              new ChildLimitError(
                this.store.runs.get(run.id)?.errorCode ??
                  'workflow_node_failed',
                error.message,
              ),
            ),
          onCancel: () => fail(new DOMException('Aborted', 'AbortError')),
        })
      } catch (error) {
        this.store.runs.finalize(run.id, 'failed', 'workflow_launch_failed')
        this.store.messages.finalize(assistant.id, '', 'failed', '')
        fail(error)
      }
    })
  }
}
