import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { ToolRegistry } from '@reflexion-os-studio/agent-core'
import { Store } from '../../dist/store/index.js'
import { RunRunner } from '../../dist/agent/run/runner.js'
import { RunEventEmitter } from '../../dist/events.js'
import {
  ApprovalGateway,
  PermissionGate,
} from '../../dist/agent/permissions/index.js'

const attempt = {
  id: 'attempt-1',
  attempt: 1,
  status: 'running',
  phase: 'stream',
  startedAt: new Date().toISOString(),
  completedAt: null,
  durationMs: 100,
  maxIdleMs: 50,
  receivedBytes: 10,
  content: 'partial',
  reasoning: 'thought',
}

test('v49 migration preserves messages and recovers request checkpoints after restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'attempt-migration-'))
  let store = new Store(dir)
  try {
    const session = store.sessions.create(null)
    const message = store.messages.create({
      sessionId: session.id,
      runId: null,
      role: 'assistant',
      content: 'old',
      status: 'pending',
    })
    store.close()
    const db = new DatabaseSync(join(dir, 'reflexion.db'))
    db.exec('ALTER TABLE messages DROP COLUMN request_attempts_json')
    db.exec('PRAGMA user_version = 49')
    db.close()
    store = new Store(dir)
    assert.equal(store.messages.listBySession(session.id)[0].content, 'old')
    store.messages.recordAttempt(message.id, attempt)
    store.messages.markStreaming(message.id)
    store.close()
    store = new Store(dir)
    const saved = store.messages.listBySession(session.id)[0]
    assert.equal(saved.status, 'interrupted')
    assert.equal(saved.requestAttempts[0].status, 'interrupted')
    assert.equal(saved.requestAttempts[0].content, 'partial')
    assert.ok(saved.requestAttempts[0].completedAt)
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a completed response checkpoint survives a crash before canonical message commit', () => {
  const dir = mkdtempSync(join(tmpdir(), 'attempt-commit-'))
  let store = new Store(dir)
  try {
    const session = store.sessions.create(null)
    const message = store.messages.create({
      sessionId: session.id,
      runId: null,
      role: 'assistant',
      content: '',
      status: 'pending',
    })
    store.messages.recordAttempt(message.id, {
      ...attempt,
      status: 'completed',
      content: 'complete but uncommitted',
    })
    store.close()
    store = new Store(dir)
    const saved = store.messages.listBySession(session.id)[0]
    assert.equal(saved.requestAttempts[0].content, 'complete but uncommitted')
    assert.equal(saved.requestAttempts[0].status, 'interrupted')
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

for (const completes of [true, false])
  test(`RunRunner retains failed output after ${completes ? 'successful retry' : 'retry exhaustion'} and restart`, async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'attempt-runner-'))
    let store = new Store(dir)
    const original = globalThis.fetch
    t.after(() => {
      globalThis.fetch = original
    })
    let requests = 0
    const bodies = []
    globalThis.fetch = async (_url, init) => {
      bodies.push(JSON.parse(init.body))
      requests++
      const events =
        requests === 1 || !completes
          ? [
              {
                choices: [
                  {
                    delta: {
                      content:
                        requests === 1
                          ? 'partial synthetic-key'
                          : 'second fragment',
                      reasoning_content: 'thinking',
                    },
                  },
                ],
              },
              { error: { type: 'overloaded_error', message: 'busy' } },
            ]
          : [
              {
                choices: [
                  { delta: { content: 'final answer' }, finish_reason: 'stop' },
                ],
              },
              '[DONE]',
            ]
      return new Response(
        events
          .map(
            (event) =>
              `data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`,
          )
          .join(''),
      )
    }
    try {
      const session = store.sessions.create(null)
      const run = store.runs.create({
        sessionId: session.id,
        providerId: null,
        model: 'test',
      })
      const message = store.messages.create({
        sessionId: session.id,
        runId: run.id,
        role: 'assistant',
        content: '',
        status: 'pending',
      })
      const events = []
      await new RunRunner(store).execute({
        run,
        provider: {
          apiKey: 'synthetic-key',
          baseUrl: 'https://mock.invalid',
          model: 'test',
          maxRetries: 1,
          apiFormat: 'openai-chat',
        },
        buildHistory: async () => [{ role: 'user', content: 'task' }],
        registry: new ToolRegistry(),
        workspaceRoot: null,
        gate: new PermissionGate({
          preset: 'workspace-write',
          hasWorkspace: false,
          approvalOverride: 'default',
          dangerActive: () => false,
        }),
        approvals: new ApprovalGateway(),
        settings: { maxTurns: 1 },
        controller: new AbortController(),
        emitter: new RunEventEmitter(run.id, (event) => events.push(event)),
        firstAssistantMessage: message,
      })
      assert.equal(
        store.runs.get(run.id).status,
        completes ? 'completed' : 'failed',
      )
      store.close()
      store = new Store(dir)
      const saved = store.messages.listBySession(session.id)[0]
      assert.equal(
        saved.content,
        completes ? 'final answer' : 'second fragment',
      )
      assert.equal(saved.requestAttempts.length, 2)
      assert.equal(saved.requestAttempts[0].content, 'partial [redacted]')
      assert.equal(saved.requestAttempts[0].reasoning, 'thinking')
      assert.equal(
        saved.requestAttempts[1].content,
        completes ? '' : 'second fragment',
      )
      assert.deepEqual(bodies[0].messages, bodies[1].messages)
      assert.ok(!JSON.stringify(bodies[1]).includes('partial'))
      assert.equal(
        events.filter((event) => event.type === 'message.attempt').length,
        2,
      )
    } finally {
      store.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
