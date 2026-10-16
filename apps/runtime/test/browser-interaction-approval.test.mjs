import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ToolRegistry } from '@reflexion-os-studio/agent-core'
import {
  BrowserExecuteJsonSchema,
  AgentBrowserClickJsonSchema,
  AgentBrowserTypeJsonSchema,
} from '@reflexion-os-studio/contracts'
import { Store } from '../dist/store/index.js'
import {
  PermissionGate,
  ApprovalGateway,
  buildApprovalSubject,
} from '../dist/agent/permissions/index.js'
import { executeToolCall } from '../dist/agent/run/tool-executor.js'
import { createRunExecutionState } from '../dist/agent/run/run-state.js'
import {
  validBrowserArgs,
  redactBrowserCalls,
} from '../dist/agent/run/browser-admission.js'

const page = {
  tabId: randomUUID(),
  origin: 'https://example.com',
  pageVersion: randomUUID(),
}
const target = { page, ref: 'e2', element: 'Search' }

test('interaction admission denies secret-shaped text and selector injection before persistence', () => {
  const invalid = [
    { ...target, text: 'api_key=synthetic_fixture_value' },
    { ...target, text: 'ordinary', ref: 'body >> input' },
    { ...target, text: 'ordinary', evaluate: 'document.cookie' },
  ]
  for (const args of invalid) {
    assert.equal(validBrowserArgs('browser.type', args), false)
    assert.equal(
      redactBrowserCalls([
        { id: 'bad', name: 'browser.type', arguments: JSON.stringify(args) },
      ])[0].arguments,
      '{}',
    )
  }
  const base = { ...target, text: 'public query', submit: false }
  const digest = buildApprovalSubject('browser.type', base).digest
  for (const args of [
    { ...base, text: 'other query' },
    { ...base, ref: 'e3' },
    { ...base, submit: true },
    { ...base, page: { ...page, pageVersion: randomUUID() } },
  ])
    assert.notEqual(buildApprovalSubject('browser.type', args).digest, digest)
})

for (const operation of ['click', 'type', 'execute']) {
  for (const choice of ['allow-once', 'deny']) {
    test(`${operation} ${choice}: always asks even with automatic read-only, full permissions and Danger`, async () => {
      const root = mkdtempSync(join(tmpdir(), 'browser-action-approval-'))
      const store = new Store(root)
      const session = store.sessions.create(null)
      const run = store.runs.create({
        sessionId: session.id,
        providerId: 'fixture',
        model: 'fixture',
      })
      const state = createRunExecutionState()
      state.lastAssistantMessageId = store.messages.create({
        sessionId: session.id,
        runId: run.id,
        role: 'assistant',
        content: '',
        status: 'pending',
      }).id
      const approvals = new ApprovalGateway()
      const registry = new ToolRegistry()
      let executions = 0
      const name = `browser.${operation}`
      registry.register({
        name,
        description: 'Public interaction',
        parameters:
          operation === 'execute'
            ? BrowserExecuteJsonSchema
            : operation === 'click'
              ? AgentBrowserClickJsonSchema
              : AgentBrowserTypeJsonSchema,
        execute: async () => {
          executions++
          return { content: 'Action completed', isError: false }
        },
      })
      const events = []
      const args =
        operation === 'execute'
          ? { mode: 'script', page, script: 'await page.mouse.wheel(0, 500)' }
          : operation === 'click'
            ? target
            : { ...target, text: 'public query', submit: true }
      const gate = new PermissionGate({
        preset: 'workspace-full',
        hasWorkspace: false,
        approvalOverride: 'default',
        dangerActive: () => true,
        browserApproval: () => 'allow-read-only',
      })
      try {
        const result = await executeToolCall(
          {
            store,
            run,
            state,
            registry,
            approvals,
            emitter: {
              runId: run.id,
              next(event) {
                events.push(event)
                if (event.type === 'approval.required')
                  queueMicrotask(() =>
                    approvals.resolveChoice(event.toolCallId, choice),
                  )
              },
            },
            workspaceRoot: null,
            permissionDomainId: session.id,
            rootRunId: run.id,
            sandboxProvider: 'seatbelt',
            gate,
          },
          { id: 'action', name, arguments: JSON.stringify(args) },
          new AbortController().signal,
        )
        const approval = events.find(
          (event) => event.type === 'approval.required',
        )
        assert.ok(approval, JSON.stringify(result))
        assert.equal(approval.subject.kind, 'browser-page')
        assert.equal(approval.risk, 'warning')
        if (operation === 'execute') {
          const review = JSON.parse(approval.context.review)
          assert.equal(review.script, args.script)
          assert.equal(review.compiledPlan.steps[0].action, 'scroll')
        } else {
          assert.deepEqual(approval.subject.target, {
            ref: 'e2',
            element: 'Search',
          })
          assert.deepEqual(JSON.parse(approval.context.review), args)
        }
        assert.deepEqual(
          approval.choices.map((choice) => choice.id),
          ['allow-once', 'deny'],
        )
        assert.equal(executions, choice === 'allow-once' ? 1 : 0)
        assert.equal(result.isError, choice === 'deny')
        const planning = new PermissionGate({
          preset: 'workspace-full',
          hasWorkspace: true,
          approvalOverride: 'default',
          dangerActive: () => true,
          executionMode: () => 'plan',
        })
        assert.equal(
          planning.decisionFor({
            toolName: name,
            subject: buildApprovalSubject(name, args).subject,
            escalation: false,
          }),
          'denied',
        )
      } finally {
        store.close()
        rmSync(root, { recursive: true, force: true })
      }
    })
  }
}

test('service dispatches actions against the current page and rejects body leaks or unchanged action versions', async () => {
  const { BrowserAgentService } =
    await import('../dist/browser/agent/service.js')
  for (const invalid of [null, 'same-version', 'body-leak']) {
    let current = page
    let disposed = false
    const operations = []
    const service = new BrowserAgentService(
      { browserSettings: { get: () => ({ agentBrowserEnabled: true }) } },
      () => ({
        connect: async () => {},
        disposeAndWait: async () => {
          disposed = true
        },
        callTool: async (operation, args) => {
          operations.push(operation)
          if (operation === 'click' || operation === 'type') {
            assert.deepEqual(args.page, current)
            if (invalid !== 'same-version')
              current = { ...page, pageVersion: randomUUID() }
          }
          return JSON.stringify({
            page: current,
            sourceUrl: 'https://example.com/',
            title: 'Public fixture',
            truncated: false,
            injectionWarning: false,
            ...(operation === 'read' ||
            (invalid === 'body-leak' && operation === 'type')
              ? { snapshot: '- heading "Public result"' }
              : {}),
          })
        },
      }),
    )
    const signal = new AbortController().signal
    try {
      await service.call(
        'chat',
        'run',
        'navigate',
        { url: 'https://example.com/' },
        signal,
      )
      const action = service.call(
        'chat',
        'run',
        'type',
        { ...target, text: 'public query' },
        signal,
      )
      if (invalid) {
        await assert.rejects(action, /browser_response_invalid/)
        assert.equal(disposed, true)
      } else {
        const updated = await action
        assert.notDeepEqual(updated.page, page)
        await assert.rejects(
          service.call('chat', 'run', 'read', page, signal),
          /browser_page_stale/,
        )
        assert.match(
          (await service.call('chat', 'run', 'read', updated.page, signal))
            .snapshot,
          /Public result/,
        )
        assert.deepEqual(operations, ['navigate', 'type', 'read'])
      }
    } finally {
      await service.shutdown()
    }
  }
})
