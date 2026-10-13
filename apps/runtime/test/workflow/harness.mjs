import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { Store } from '../../dist/store/index.js'
import { WorkflowService } from '../../dist/workflow/service.js'
import { saveWorkflowDefinition } from '../../dist/workflow/definitions/service.js'
import { workflowFixture } from '../../../../packages/contracts/test/fixtures/workflow.mjs'

export async function until(predicate, message = 'condition') {
  for (let i = 0; i < 300; i++) {
    const result = predicate()
    if (result) return result
    await delay(5)
  }
  throw new Error(`Timed out: ${message}`)
}
export function harness(t, execute, definition = workflowFixture()) {
  const dir = mkdtempSync(join(tmpdir(), 'reflexion-workflow-run-'))
  const store = new Store(dir)
  const project = store.projects.create({ name: 'Synthetic', folderPath: dir })
  store.providers.upsert({
    id: 'fixture',
    name: 'Synthetic',
    baseUrl: 'http://127.0.0.1:1/v1',
    models: ['text'],
    capabilities: ['chat'],
    secretRef: 'synthetic-reference',
    enabled: true,
    apiFormat: 'openai-chat',
    headers: [],
    temperature: null,
    maxTokens: null,
    contextWindow: null,
    contextBudget: null,
    reasoningEffort: null,
  })
  const version = saveWorkflowDefinition(store, {
    projectId: project.id,
    baseRevision: 0,
    definition,
    origin: 'manual',
  })
  const calls = [],
    events = [],
    cleared = []
  const executor = {
    async execute(input) {
      calls.push(input)
      const setup = store.transaction(() => {
        const session = store.sessions.create(project.id, 'Synthetic node')
        const run = store.runs.create({
          sessionId: session.id,
          providerId: 'fixture',
          model: 'text',
        })
        store.workflowAttempts.update({
          ...store.workflowAttempts.get(input.attemptId),
          agentRunId: run.id,
          sessionId: session.id,
        })
        return { session, run }
      })
      try {
        input.onModelResult({ promptTokens: 5, completionTokens: 5 })
        const outputs = execute
          ? await execute(input, store)
          : {
              text: {
                type: 'text',
                value: `${input.inputs.text?.value ?? ''}/${input.node.id}`,
              },
            }
        store.transaction(() => {
          store.workflowAttempts.stageResult({
            attemptId: input.attemptId,
            values: outputs,
            errorCode: null,
          })
          store.runs.finalize(setup.run.id, 'completed')
        })
        return {
          agentRunId: setup.run.id,
          sessionId: setup.session.id,
          outputs,
        }
      } catch (error) {
        store.runs.finalize(
          setup.run.id,
          input.signal.aborted ? 'cancelled' : 'failed',
          'synthetic_failure',
        )
        throw error
      }
    },
  }
  const deps = {
    store,
    executor,
    availableTools: () =>
      new Set(['file.read', 'file.write', 'shell.execute', 'fixture/tool']),
    validateResources: async () => {},
    notify: (event) => events.push(event),
    clearPermissionDomain: (id) => cleared.push(id),
  }
  const service = new WorkflowService(deps)
  t.after(async () => {
    await service.dispose()
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })
  const start = {
    requestId: randomUUID(),
    projectId: project.id,
    definitionId: version.definitionId,
    revision: 1,
    inputs: { text: { type: 'text', value: 'topic' } },
    defaultModel: { providerId: 'fixture', model: 'text' },
    permissionPreset: 'workspace-read',
    approvalOverride: 'default',
  }
  return {
    dir,
    store,
    project,
    version,
    service,
    deps,
    calls,
    events,
    cleared,
    start,
  }
}
