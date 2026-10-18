import assert from 'node:assert/strict'
import { test } from 'node:test'
import http from 'node:http'
import { once } from 'node:events'
import { safeFetch } from '../dist/agent/tools/web-security.js'

async function fixture(t, handler) {
  const server = http.createServer(handler)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise((resolve) => server.close(resolve)))
  return `http://127.0.0.1:${server.address().port}`
}
const init = () => ({ signal: AbortSignal.timeout(3000), headers: {} })

test('web fetch allows system-routable local targets and follows redirects', async (t) => {
  const seen = []
  const base = await fixture(t, (req, res) => {
    seen.push(req.url)
    if (req.url === '/start') res.writeHead(302, { location: '/article' })
    res.end('article fixture')
  })
  const result = await safeFetch(new URL(`${base}/start`), init())
  assert.equal(result.finalUrl, `${base}/article`)
  assert.equal(result.redirects, 1)
  assert.equal(
    Buffer.from(await result.response.arrayBuffer()).toString(),
    'article fixture',
  )
  assert.deepEqual(seen, ['/start', '/article'])
})

test('web fetch rejects unsupported protocols and URL credentials on each redirect', async (t) => {
  for (const url of [
    'file:///tmp/example',
    'https://user:password@example.com',
  ])
    await assert.rejects(safeFetch(new URL(url), init()))
  const base = await fixture(t, (_req, res) => {
    res.writeHead(302, { location: 'http://user:password@localhost/private' })
    res.end()
  })
  await assert.rejects(safeFetch(new URL(base), init()), /凭据/)
})

test('web fetch bounds redirects and buffered response bytes', async (t) => {
  const base = await fixture(t, (req, res) => {
    if (req.url === '/loop') {
      res.writeHead(302, { location: '/loop' })
      res.end()
    } else res.end('x'.repeat(2 * 1024 * 1024 + 1))
  })
  await assert.rejects(safeFetch(new URL(`${base}/loop`), init()), /重定向次数/)
  const { response } = await safeFetch(new URL(base), init())
  assert.equal((await response.arrayBuffer()).byteLength, 2 * 1024 * 1024)
  assert.equal(response.bodyTruncated, true)
})

test('web fetch preserves cancellation before and during a request', async (t) => {
  await assert.rejects(
    safeFetch(new URL('https://example.com'), {
      headers: {},
      signal: AbortSignal.abort(),
    }),
    { name: 'AbortError' },
  )
  const controller = new AbortController()
  const base = await fixture(t, (_req, res) => {
    res.write('partial')
    controller.abort()
  })
  await assert.rejects(
    safeFetch(new URL(base), {
      headers: {},
      signal: controller.signal,
    }),
    { name: 'AbortError' },
  )
})
