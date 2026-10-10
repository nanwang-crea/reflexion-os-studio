import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../dist/store/index.js'
import { RunRunner } from '../dist/agent/run/runner.js'
import { RunEventEmitter } from '../dist/events.js'
import {
  ApprovalGateway,
  PermissionGate,
} from '../dist/agent/permissions/index.js'
import { ToolRegistry } from '@reflexion-os-studio/agent-core'
import { startServer } from './fixtures/provider-server.mjs'

for (const mode of [
  'text',
  'tools',
  'empty',
  'reasoning',
  'reasoning-success',
]) {
  test(`runner persists ${mode} truncation without executing partial tools`, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'output-recovery-'))
    let store = new Store(directory)
    const project = store.projects.create({ name: 'p', folderPath: directory })
    const session = store.sessions.create(project.id)
    const run = store.runs.create({
      sessionId: session.id,
      providerId: 'p',
      model: 'm',
    })
    const message = store.messages.create({
      sessionId: session.id,
      runId: run.id,
      role: 'assistant',
      content: '',
      status: 'pending',
    })
    let requests = 0
    let executed = 0
    const registry = new ToolRegistry()
    registry.register({
      name: 'probe',
      description: 'probe',
      parameters: { type: 'object', properties: {} },
      execution: { effect: 'pure' },
      execute: async () => {
        executed++
        return { content: 'ok', isError: false }
      },
    })
    const server = await startServer((_request, response) => {
      requests++
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      const delta =
        mode === 'tools'
          ? {
              content: 'partial',
              tool_calls: [
                {
                  index: 0,
                  id: 'c',
                  type: 'function',
                  function: { name: 'probe', arguments: '{' },
                },
              ],
            }
          : {
              content:
                mode === 'text'
                  ? 'last fragment'
                  : mode === 'reasoning-success' && requests === 2
                    ? 'answer'
                    : '',
              reasoning_content: mode === 'empty' ? '' : 'thinking',
            }
      response.end(
        `data: ${JSON.stringify({ choices: [{ delta }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: mode === 'reasoning-success' && requests === 2 ? 'stop' : 'length' }], usage: { prompt_tokens: 2, completion_tokens: 3 } })}\n\ndata: [DONE]\n\n`,
      )
    })
    try {
      await new RunRunner(store).execute({
        run,
        provider: {
          baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
          apiKey: 'test',
          model: 'm',
          maxRetries: 0,
        },
        buildHistory: async () => [{ role: 'user', content: 'task' }],
        registry,
        workspaceRoot: null,
        gate: new PermissionGate({
          preset: 'workspace-write',
          hasWorkspace: false,
          approvalOverride: 'default',
          dangerActive: () => false,
        }),
        approvals: new ApprovalGateway(),
        settings: {
          maxContinuationTurns: mode.startsWith('reasoning') ? 1 : 0,
        },
        controller: new AbortController(),
        emitter: new RunEventEmitter(run.id, () => {}),
        firstAssistantMessage: message,
        rootRunId: run.id,
        permissionDomainId: run.id,
      })
      assert.equal(executed, 0)
      assert.equal(
        requests,
        mode === 'tools' || mode.startsWith('reasoning') ? 2 : 1,
      )
      assert.equal(store.toolCalls.listByRun(run.id).length, 0)
      assert.equal(
        store.runs.get(run.id).errorCode,
        mode === 'tools'
          ? 'tool_output_truncated'
          : mode === 'empty'
            ? 'output_empty'
            : mode === 'reasoning-success'
              ? null
              : 'output_truncated',
      )
      assert.equal(
        store.turnExecutions.latestForRun(run.id).runtimeState.finishReason,
        mode === 'reasoning-success' ? 'stop' : 'length',
      )
      assert.equal(
        store.turnExecutions.latestForRun(run.id).modelRequest.outputReserve,
        4096,
      )
      store.close()
      store = new Store(directory)
      const persisted = store.messages.listBySession(session.id)
      assert.equal(persisted.length, requests)
      assert.equal(
        persisted.at(-1).content,
        mode === 'tools'
          ? 'partial'
          : mode === 'text'
            ? 'last fragment'
            : mode === 'reasoning-success'
              ? 'answer'
              : '',
      )
      assert.equal(
        persisted[0].reasoning,
        mode === 'tools' || mode === 'empty' ? '' : 'thinking',
      )
      assert.equal(store.runs.get(run.id).usage.completionTokens, requests * 3)
    } finally {
      server.close()
      store.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })
}
