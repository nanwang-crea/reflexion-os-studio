import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { BrowserAgentService } from '../dist/browser/agent/service.js'

for (const failure of [
  'browser_page_stale',
  'browser_sensitive_content',
  'browser_operation_failed',
]) {
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
