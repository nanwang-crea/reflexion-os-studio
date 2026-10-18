import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { BrowserAgentService } from '../dist/browser/agent/service.js'

for (const failure of ['browser_page_stale', 'browser_operation_failed']) {
  test(`read ${failure} preserves only recoverable browser workers`, async () => {
    let disposed = false
    let version = randomUUID()
    const tabId = randomUUID()
    const page = () => ({
      tabId,
      origin: 'https://example.com',
      pageVersion: version,
    })
    const service = new BrowserAgentService(
      { browserSettings: { get: () => ({ agentBrowserEnabled: true }) } },
      () => ({
        connect: async () => {},
        disposeAndWait: async () => {
          disposed = true
        },
        callTool: async (operation) => {
          if (operation === 'read') throw new Error(failure)
          version = randomUUID()
          return JSON.stringify({
            page: page(),
            sourceUrl: 'https://example.com/',
            title: 'Public page',
            truncated: false,
            injectionWarning: false,
          })
        },
      }),
    )
    try {
      const signal = new AbortController().signal
      const first = await service.call(
        'session',
        'run',
        'navigate',
        { url: 'https://example.com/' },
        signal,
      )
      await assert.rejects(
        service.call('session', 'run', 'read', first.page, signal),
        new RegExp(failure),
      )
      assert.equal(disposed, failure !== 'browser_page_stale')
      if (failure === 'browser_page_stale') {
        const next = await service.call(
          'session',
          'run',
          'navigate',
          { url: 'https://example.com/next' },
          signal,
        )
        assert.equal(disposed, false)
        assert.notDeepEqual(next.page, first.page)
        await assert.rejects(
          service.call('session', 'run', 'read', first.page, signal),
          /browser_page_stale/,
        )
      }
    } finally {
      await service.shutdown()
    }
    assert.equal(disposed, true)
  })
}

test('service retains browser across credential-shaped title, read and execute results', async () => {
  let disposed = false
  const page = {
    tabId: randomUUID(),
    origin: 'https://example.com',
    pageVersion: randomUUID(),
  }
  const document = {
    page,
    sourceUrl: 'https://example.com/login',
    title: 'password: required',
    truncated: false,
    injectionWarning: false,
  }
  const snapshot = 'api_key=synthetic_fixture_value'
  const service = new BrowserAgentService(
    { browserSettings: { get: () => ({ agentBrowserEnabled: true }) } },
    () => ({
      connect: async () => {},
      disposeAndWait: async () => {
        disposed = true
      },
      callTool: async (operation) =>
        JSON.stringify(
          operation === 'execute'
            ? {
                document: { ...document, snapshot },
                completed: 1,
                failedStep: null,
                error: null,
                screenshots: [],
              }
            : operation === 'read'
              ? { ...document, snapshot }
              : document,
        ),
    }),
  )
  const signal = new AbortController().signal
  try {
    await service.call(
      'session',
      'run',
      'navigate',
      { url: document.sourceUrl },
      signal,
    )
    assert.equal(
      (await service.call('session', 'run', 'read', page, signal)).snapshot,
      snapshot,
    )
    const result = await service.call(
      'session',
      'run',
      'execute',
      { mode: 'actions', page, steps: [{ action: 'read' }] },
      signal,
    )
    assert.equal(result.document.snapshot, snapshot)
    assert.equal(disposed, false)
  } finally {
    await service.shutdown()
  }
})
