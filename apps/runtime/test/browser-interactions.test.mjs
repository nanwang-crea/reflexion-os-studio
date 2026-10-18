import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:http'
import { browserWorkerPaths } from '../dist/browser/agent/paths.js'
process.env.PLAYWRIGHT_BROWSERS_PATH = browserWorkerPaths().browsers
const { PlaywrightBackend } = await import('./fixtures/browser-backend.mjs')

function target(document, name) {
  const line = document.snapshot
    .split('\n')
    .find((line) => line.includes(`"${name}"`))
  const ref = /\[ref=((?:f\d+)?e\d+)\]/.exec(line ?? '')?.[1]
  assert.ok(ref, `missing control ${name}`)
  return { page: document.page, ref, element: name }
}
const fixtureHtml = `<title>Public interaction fixture</title>
<form action="/results" method="get"><label>Search query<input name="q"></label><button>Search</button></form>
<button onclick="document.querySelector('#detail').textContent='Expanded public detail'">Expand</button><p id="detail">Collapsed</p>
<a href="/next">Next page</a><a href="http://other.test/forbidden">Other site</a>
<button onclick="fetch('/write',{method:'POST',body:'synthetic public text'}).catch(()=>{})">Try request</button>
<label>Security code<input autocomplete="one-time-code"></label><form action="/login" method="get"><label>密码<input name="passphrase" type="password" autocomplete="current-password"></label><button>Sign in</button></form><button aria-label="Pay">Pay</button>`

for (const display of ['headless', 'headed']) {
  test(
    `${display}: real MCP fills, expands, searches and navigates with new page identities`,
    {
      skip:
        display === 'headed' && process.platform !== 'darwin'
          ? 'Windows/Linux GUI acceptance pending'
          : false,
    },
    async () => {
      let forbiddenHits = 0
      const server = createServer((request, response) => {
        response.setHeader('content-type', 'text/html; charset=utf-8')
        if (request.method === 'POST' || request.url === '/forbidden')
          ++forbiddenHits
        response.end(
          request.url.startsWith('/results')
            ? `<title>Search results</title><h1>Found public results</h1><a href="/next">Next page</a>`
            : fixtureHtml,
        )
      })
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
      const origin = `http://fixture.test:${server.address().port}`
      const backend = new PlaywrightBackend(display)
      try {
        let metadata = await backend.navigate(origin + '/')
        const originalBrowser = backend.browser
        let document = await backend.read(metadata.page)
        const original = target(document, 'Search query')
        metadata = await backend.interact('type', {
          ...original,
          text: 'public sample',
          submit: false,
        })
        assert.equal(
          metadata.snapshot,
          undefined,
          'action cannot disclose body before read approval',
        )
        assert.notDeepEqual(metadata.page, original.page)
        await assert.rejects(
          backend.interact('click', target(document, 'Expand')),
          /browser_page_stale/,
        )
        document = await backend.read(metadata.page)
        assert.match(document.snapshot, /public sample/)
        await assert.rejects(
          backend.interact('click', {
            ...target(document, 'Expand'),
            element: 'Misleading label',
          }),
          /browser_interaction_denied/,
        )
        metadata = await backend.interact('click', target(document, 'Expand'))
        document = await backend.read(metadata.page)
        assert.match(document.snapshot, /Expanded public detail/)
        metadata = await backend.interact('type', {
          ...target(document, 'Security code'),
          text: '123456',
        })
        document = await backend.read(metadata.page)
        metadata = await backend.interact('type', {
          ...target(document, '密码'),
          text: 'synthetic_fixture_only',
        })
        document = await backend.read(metadata.page)
        metadata = await backend.interact('click', target(document, 'Sign in'))
        assert.match(
          metadata.sourceUrl,
          /\/login\?passphrase=synthetic_fixture_only/,
        )
        document = await backend.read(metadata.page)
        await assert.rejects(
          backend.interact('click', target(document, 'Pay')),
          /browser_interaction_denied/,
        )
        await assert.rejects(
          backend.interact('click', target(document, 'Other site')),
          /browser_interaction_denied/,
        )
        metadata = await backend.interact('type', {
          ...target(document, 'Search query'),
          text: 'public query',
          submit: true,
        })
        assert.match(metadata.sourceUrl, /\/results\?q=public\+query/)
        document = await backend.read(metadata.page)
        assert.match(document.snapshot, /Found public results/)
        metadata = await backend.interact(
          'click',
          target(document, 'Next page'),
        )
        document = await backend.read(metadata.page)
        assert.equal(metadata.sourceUrl, origin + '/next')
        assert.equal(backend.browser, originalBrowser)
        await assert.rejects(
          backend.interact('click', target(document, 'Try request')),
          /browser_interaction_network_denied/,
        )
        assert.equal(forbiddenHits, 0)
        assert.equal(
          originalBrowser.isConnected(),
          true,
          'denied interaction must not flash-close the window',
        )
        const restored = await backend.navigate(origin + '/')
        const restoredDocument = await backend.read(restored.page)
        assert.match(restoredDocument.snapshot, /Search query/)
        const page = backend.context.pages()[0]
        const locator = page.locator.bind(page)
        page.locator = (...args) => {
          const result = locator(...args)
          result.click = async () => {
            throw new Error('browser_operation_failed')
          }
          return result
        }
        await assert.rejects(
          backend.interact('click', target(restoredDocument, 'Expand')),
          /browser_interaction_failed/,
        )
        assert.equal(originalBrowser.isConnected(), true)
        page.locator = locator
      } finally {
        await backend.close()
        await new Promise((resolve) => server.close(resolve))
      }
    },
  )
}
