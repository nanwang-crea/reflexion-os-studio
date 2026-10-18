import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ToolRegistry } from '@reflexion-os-studio/agent-core'
import { AgentBrowserNavigateJsonSchema } from '@reflexion-os-studio/contracts'
import { Store } from '../dist/store/index.js'
import {
  ApprovalGateway,
  PermissionGate,
} from '../dist/agent/permissions/index.js'
import { executeToolCall } from '../dist/agent/run/tool-executor.js'
import { createRunExecutionState } from '../dist/agent/run/run-state.js'
import { McpClient } from '../dist/mcp/client.js'
import { browserWorkerPaths } from '../dist/browser/agent/paths.js'

for (const [policy, override, choice] of [
  ['ask', 'default', 'deny'],
  ['ask', 'default', 'allow-once'],
  ['follow-session', 'default', 'automatic'],
  ['allow-read-only', 'default', 'automatic'],
  ['follow-session', 'ask-everything', 'deny'],
  ['allow-read-only', 'ask-everything', 'deny'],
]) {
  test(`browser execution policy ${policy}, override ${override}, result ${choice}`, async () => {
    const store = new Store(
      mkdtempSync(join(tmpdir(), 'reflexion-browser-approval-')),
    )
    const session = store.sessions.create(null)
    const run = store.runs.create({
      sessionId: session.id,
      providerId: 'fixture',
      model: 'fixture',
    })
    const message = store.messages.create({
      sessionId: session.id,
      runId: run.id,
      role: 'assistant',
      content: '',
      status: 'pending',
    })
    const state = createRunExecutionState()
    state.lastAssistantMessageId = message.id
    const approvals = new ApprovalGateway()
    const events = []
    let calls = 0
    const registry = new ToolRegistry()
    registry.register({
      name: 'browser.navigate',
      description: 'browser',
      parameters: AgentBrowserNavigateJsonSchema,
      execute: async () => {
        ++calls
        return { content: 'Navigated', isError: false }
      },
    })
    const emitter = {
      runId: run.id,
      next(event) {
        events.push(event)
        if (event.type === 'approval.required')
          queueMicrotask(() =>
            approvals.resolveChoice(event.toolCallId, choice),
          )
      },
    }
    try {
      const result = await executeToolCall(
        {
          store,
          run,
          state,
          registry,
          approvals,
          emitter,
          workspaceRoot: null,
          permissionDomainId: session.id,
          rootRunId: run.id,
          sandboxProvider: 'seatbelt',
          gate: new PermissionGate({
            preset: 'workspace-full',
            hasWorkspace: false,
            approvalOverride: override,
            dangerActive: () => true,
            browserApproval: () => policy,
          }),
        },
        {
          id: 'nav',
          name: 'browser.navigate',
          arguments: JSON.stringify({ url: 'https://example.com/' }),
        },
        new AbortController().signal,
      )
      const approval = events.find(
        (event) => event.type === 'approval.required',
      )
      if (choice === 'automatic') {
        assert.equal(approval, undefined)
        assert.equal(calls, 1)
        assert.equal(result.isError, false)
        return
      }
      assert.ok(approval)
      assert.equal(approval.subject.kind, 'browser-page')
      assert.equal(approval.context.network, true)
      assert.equal(approval.context.sandboxProvider, null)
      assert.deepEqual(
        approval.choices.map((item) => item.id),
        ['allow-once', 'deny'],
      )
      assert.equal(calls, choice === 'deny' ? 0 : 1)
      assert.equal(result.isError, choice === 'deny')
    } finally {
      store.close()
    }
  })
}

test('managed stdio worker exposes only the adapter and refuses script tools and restricted URLs', async () => {
  const paths = browserWorkerPaths()
  const client = new McpClient({
    command: process.execPath,
    args: [paths.worker],
    env: { PLAYWRIGHT_BROWSERS_PATH: paths.browsers },
    managed: true,
  })
  try {
    await client.connect()
    assert.deepEqual(
      (await client.listTools()).map((tool) => tool.name),
      ['execute', 'navigate', 'click', 'type', 'read', 'close'],
    )
    await assert.rejects(
      client.callTool('browser_run_code', { code: '1+1' }),
      /browser_operation_failed/,
    )
    await assert.rejects(
      client.callTool('navigate', { url: 'http://localhost/' }),
      /browser_operation_failed/,
    )
    assert.deepEqual(JSON.parse(await client.callTool('close', {})), {
      closed: true,
    })
  } finally {
    await client.disposeAndWait()
  }
})

test('browser policy matrix is narrow and honors live configuration', async () => {
  const { browserDecision } =
    await import('../dist/agent/permissions/browser-policy.js')
  for (const operation of [
    'browser.navigate',
    'browser.read',
    'browser.close',
  ]) {
    for (const preset of [
      'workspace-read',
      'workspace-write',
      'workspace-full',
    ]) {
      assert.equal(
        browserDecision(operation, 'follow-session', preset),
        preset === 'workspace-full' ? 'automatic' : 'ask',
      )
      assert.equal(browserDecision(operation, 'ask', preset), 'ask')
      assert.equal(
        browserDecision(operation, 'allow-read-only', preset),
        'automatic',
      )
      assert.equal(
        browserDecision(operation, 'allow-read-only', preset, 'ask-everything'),
        'ask',
      )
    }
  }
  for (const name of ['browser.click', 'server/browser_navigate'])
    assert.equal(
      browserDecision(name, 'allow-read-only', 'workspace-full'),
      'ask',
    )
  let policy = 'follow-session'
  const gate = new PermissionGate({
    preset: 'workspace-full',
    hasWorkspace: false,
    approvalOverride: 'default',
    dangerActive: () => false,
    browserApproval: () => policy,
  })
  const request = {
    toolName: 'browser.navigate',
    subject: { kind: 'browser-page' },
  }
  assert.equal(gate.decisionFor(request), 'automatic')
  policy = 'ask'
  assert.equal(gate.decisionFor(request), 'ask')
})
