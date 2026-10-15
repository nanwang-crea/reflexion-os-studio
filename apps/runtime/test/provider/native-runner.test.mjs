import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ToolRegistry } from '@reflexion-os-studio/agent-core'
import { Store } from '../../dist/store/index.js'
import { RunRunner } from '../../dist/agent/run/runner.js'
import { RunEventEmitter } from '../../dist/events.js'
import {
  ApprovalGateway,
  PermissionGate,
} from '../../dist/agent/permissions/index.js'
import {
  options,
  anthropicEvents,
  responsesEvents,
  withMock,
} from '../fixtures/native-thinking.mjs'

for (const [format, events, finalEvents] of [
  [
    'anthropic',
    anthropicEvents,
    [
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'done' },
      },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
    ],
  ],
  [
    'openai-responses',
    responsesEvents,
    [
      { type: 'response.output_text.delta', delta: 'done' },
      { type: 'response.completed', response: { status: 'completed' } },
    ],
  ],
]) {
  test(`${format} RunRunner persists native data and uses it in the next actual request`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'native-runner-'))
    const store = new Store(dir)
    const firstEvents = JSON.parse(
      JSON.stringify(events).replaceAll('file_read', 'get_current_time'),
    )
    try {
      await withMock(
        (count) => (count === 1 ? firstEvents : finalEvents),
        async (bodies) => {
          const session = store.sessions.create(null)
          const run = store.runs.create({
            sessionId: session.id,
            providerId: null,
            model: options.model,
          })
          const firstAssistantMessage = store.messages.create({
            sessionId: session.id,
            runId: run.id,
            role: 'assistant',
            content: '',
            status: 'pending',
          })
          const registry = new ToolRegistry()
          registry.register({
            name: 'get_current_time',
            description: 'test clock',
            parameters: { type: 'object' },
            execution: { effect: 'pure' },
            execute: async () => ({ content: 'ok', isError: false }),
          })
          await new RunRunner(store).execute({
            run,
            provider: { ...options, apiFormat: format },
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
            settings: { maxTurns: 2 },
            controller: new AbortController(),
            emitter: new RunEventEmitter(run.id, () => {}),
            firstAssistantMessage,
          })
          assert.equal(store.runs.get(run.id).status, 'completed')
          const saved = store.messages.listBySession(session.id)[0]
            .providerContinuation
          assert.equal(saved.apiFormat, format)
          assert.equal(bodies.length, 2)
          if (format === 'anthropic') {
            assert.deepEqual(bodies[1].messages[1].content, saved.blocks)
            assert.equal(bodies[1].messages[2].role, 'user')
          } else {
            assert.deepEqual(
              bodies[1].input.slice(1, 1 + saved.items.length),
              saved.items,
            )
            assert.equal(bodies[1].input.at(-1).call_id, 'call_1')
          }
        },
      )
    } finally {
      store.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
}
