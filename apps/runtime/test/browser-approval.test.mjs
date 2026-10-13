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

for (const choice of ['deny', 'allow-once']) {
  test(`browser execution under Danger still requires explicit ${choice} choice`, async () => {
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
            approvalOverride: 'default',
            dangerActive: () => true,
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

test('managed stdio worker exposes only the adapter and refuses script tools and private network access', async () => {
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
      ['navigate', 'read', 'close'],
    )
    await assert.rejects(
      client.callTool('browser_run_code', { code: '1+1' }),
      /browser_operation_failed/,
    )
    await assert.rejects(
      client.callTool('navigate', { url: 'http://127.0.0.1/' }),
      /browser_network_denied/,
    )
    assert.deepEqual(JSON.parse(await client.callTool('close', {})), {
      closed: true,
    })
  } finally {
    await client.disposeAndWait()
  }
})
