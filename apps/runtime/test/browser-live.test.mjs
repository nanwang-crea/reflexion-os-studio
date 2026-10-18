import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:http'
import { browserWorkerPaths } from '../dist/browser/agent/paths.js'
import { browserFailure } from '../dist/browser/agent/worker/errors.js'
process.env.PLAYWRIGHT_BROWSERS_PATH = browserWorkerPaths().browsers
const { PlaywrightBackend } = await import('./fixtures/browser-backend.mjs')

test('dynamic search submits POST, follows SPA updates and crosses sites in one owned tab', async () => {
  let posts = 0
  const server = createServer((request, response) => {
    if (request.url === '/broken') {
      request.socket.destroy()
      return
    }
    if (request.url === '/api/search') {
      assert.equal(request.method, 'POST')
      posts++
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ result: '北京旅游结果' }))
      return
    }
    response.setHeader('content-type', 'text/html; charset=utf-8')
    response.end(`<title>Live search fixture</title><form><label>Query<input type="search"></label></form><h1>Home</h1><aside>0</aside><script>
      setInterval(()=>document.querySelector('aside').textContent=String(Date.now()),40);
      document.querySelector('form').onsubmit=async(event)=>{
        event.preventDefault();const q=document.querySelector('input').value;
        const result=await fetch('/api/search',{method:'POST',body:q}).then(r=>r.json());
        setTimeout(()=>{history.pushState({},'', '/search_result?keyword='+encodeURIComponent(q));document.querySelector('h1').textContent=result.result},80)
      };
    </script>`)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://fixture.test:${server.address().port}`
  const other = `http://other.test:${server.address().port}`
  const backend = new PlaywrightBackend()
  try {
    const initial = await backend.navigate(origin + '/')
    const browser = backend.browser
    const first = await backend.read(initial.page)
    const result = await backend.execute({
      mode: 'actions',
      page: first.page,
      steps: [
        {
          action: 'type',
          target: { role: 'searchbox', name: 'Query' },
          text: '北京旅游',
          submit: true,
        },
        { action: 'wait', milliseconds: 200 },
        { action: 'screenshot' },
        { action: 'read' },
      ],
    })
    assert.equal(result.error, null)
    assert.equal(result.completed, 4)
    assert.equal(result.screenshots.length, 1)
    assert.equal(posts, 1)
    assert.match(result.document.snapshot, /北京旅游结果/)
    assert.match(result.document.sourceUrl, /search_result\?keyword=/)
    const current = await backend.read(initial.page)
    assert.equal(current.page.tabId, initial.page.tabId)
    assert.match(current.snapshot, /北京旅游结果/)
    const cross = await backend.execute({
      mode: 'actions',
      page: current.page,
      steps: [{ action: 'goto', url: other + '/arrived' }, { action: 'read' }],
    })
    assert.equal(cross.error, null)
    assert.equal(cross.document.page.origin, other)
    assert.equal(cross.document.page.tabId, initial.page.tabId)
    assert.equal(backend.browser, browser)
    await assert.rejects(
      backend.navigate(origin + '/broken'),
      /browser_navigation_failed/,
    )
    assert.equal(backend.browser, browser)
    assert.equal(browser.isConnected(), true)
    const recovered = await backend.navigate(origin + '/')
    assert.equal(recovered.page.tabId, initial.page.tabId)
    assert.match((await backend.read(initial.page)).snapshot, /Home/)
  } finally {
    await backend.close()
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  }
})

test('browser errors preserve useful categories without returning raw diagnostics', () => {
  for (const [raw, code] of [
    [
      'net::ERR_NAME_NOT_RESOLVED at https://example.test/',
      'browser_network_dns_failed',
    ],
    ['net::ERR_CONNECTION_REFUSED', 'browser_network_connection_refused'],
    ['net::ERR_CERT_AUTHORITY_INVALID', 'browser_network_certificate'],
    ['Timeout 15000ms exceeded', 'browser_navigation_timeout'],
    ['net::ERR_BLOCKED_BY_CLIENT', 'browser_navigation_blocked'],
    ['net::ERR_EMPTY_RESPONSE', 'browser_navigation_failed'],
  ])
    assert.equal(browserFailure(raw).message, code)
})
