import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { createWebFetchTool } from '../dist/agent/tools/web.js'
import { createToolRegistry } from '../dist/agent/tools/index.js'
import { executeToolBatch } from '../dist/agent/run/tool-scheduler.js'

async function fixture(t, handler) {
  const responses = []
  const seen = []
  const waiters = []
  let active = 0
  let peak = 0
  const server = createServer((req, res) => {
    active++
    peak = Math.max(peak, active)
    let finished = false
    const finish = () => {
      if (finished) return
      finished = true
      active--
    }
    res.once('finish', finish)
    res.once('close', finish)
    seen.push(req.url)
    responses.push(res)
    handler?.(req, res, seen.length)
    for (const waiter of waiters)
      if (seen.length >= waiter.count) waiter.resolve()
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => {
    server.closeAllConnections()
    return new Promise((resolve) => server.close(resolve))
  })
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    responses,
    seen,
    peak: () => peak,
    until: (count) =>
      seen.length >= count
        ? Promise.resolve()
        : new Promise((resolve) => waiters.push({ count, resolve })),
  }
}

function registry() {
  return createToolRegistry({
    store: { runs: { get: () => null } },
    skills: {},
    mcp: null,
    system: null,
    allowedTools: new Set(['web.fetch']),
  })
}

function batch(tools, requests, signal) {
  return executeToolBatch(
    {
      registry: tools,
      state: { precreatedToolCallRows: new Map() },
      executeOne: (request, signal) => tools.call(request, signal),
    },
    requests,
    signal,
  )
}

function invoke(url, signal) {
  // A distinct tool instance models a different Run/Agent.
  return createWebFetchTool().execute({ args: { url }, signal })
}

test(
  'same-origin reads overlap; separate Agent batches share ten slots and preserve order',
  { timeout: 4000 },
  async (t) => {
    const f = await fixture(t, (req, res, count) => {
      if (count > 10) {
        if (req.url === '/article/3') res.writeHead(503)
        res.end(req.url)
      }
    })
    const requests = Array.from({ length: 25 }, (_, i) => ({
      id: `fetch-${i}`,
      name: 'web.fetch',
      arguments: JSON.stringify({ url: `${f.base}/article/${i}` }),
    }))
    const pending = Promise.all([
      batch(registry(), requests.slice(0, 13), t.signal),
      batch(registry(), requests.slice(13), t.signal),
    ])
    pending.catch(() => {})
    await f.until(10)
    assert.equal(f.seen.length, 10)
    assert.equal(f.peak(), 10)
    // Deliberately return the first batch in reverse order, with one HTTP failure.
    for (let i = 9; i >= 0; i--) {
      if (f.seen[i] === '/article/3') f.responses[i].writeHead(503)
      f.responses[i].end(f.seen[i])
    }
    const results = (await pending).flat()
    assert.equal(f.seen.length, 25)
    assert.equal(f.peak(), 10)
    for (const [i, result] of results.entries()) {
      if (i === 3) {
        assert.equal(result.isError, true)
        assert.equal(result.code, 'web_fetch_error')
      } else {
        assert.equal(result.isError, false)
        assert.equal(result.data.text, `/article/${i}`)
      }
    }
  },
)

test(
  'queued cancellation skips HTTP and deadlines; active cancellation releases a slot',
  { timeout: 4000 },
  async (t) => {
    const f = await fixture(t, (req, res) => {
      if (req.url === '/next' || req.url === '/after') res.end(req.url)
    })
    const controllers = Array.from({ length: 10 }, () => new AbortController())
    t.after(() => controllers.forEach((controller) => controller.abort()))
    const held = Promise.allSettled(
      controllers.map((controller, i) =>
        invoke(
          `${f.base}/held/${i}`,
          AbortSignal.any([controller.signal, t.signal]),
        ),
      ),
    )
    await f.until(10)
    const timeout = AbortSignal.timeout.bind(AbortSignal)
    let deadlines = 0
    t.mock.method(AbortSignal, 'timeout', (ms) => {
      deadlines++
      return timeout(ms)
    })
    const cancelled = new AbortController()
    const queued = invoke(`${f.base}/cancelled`, cancelled.signal)
    cancelled.abort()
    await assert.rejects(queued, { name: 'AbortError' })
    assert.equal(
      deadlines,
      0,
      'queue waiting must not consume a request deadline',
    )
    const next = invoke(`${f.base}/next`, t.signal)
    assert.equal(deadlines, 0)
    controllers[0].abort()
    assert.equal((await next).isError, false)
    assert.equal(deadlines, 1)
    assert.ok(!f.seen.includes('/cancelled'))
    controllers.forEach((controller) => controller.abort())
    await held
    assert.equal((await invoke(`${f.base}/after`, t.signal)).isError, false)
  },
)

test(
  'request timeout returns a tool failure and releases capacity to a queued fetch',
  { timeout: 4000 },
  async (t) => {
    const f = await fixture(t, (req, res) => {
      if (req.url === '/queued') res.end('recovered')
    })
    const deadlines = []
    t.mock.method(AbortSignal, 'timeout', () => {
      const controller = new AbortController()
      deadlines.push(controller)
      return controller.signal
    })
    const controllers = Array.from({ length: 10 }, () => new AbortController())
    t.after(() => controllers.forEach((controller) => controller.abort()))
    const held = controllers.map((controller, i) =>
      invoke(
        `${f.base}/held/${i}`,
        AbortSignal.any([controller.signal, t.signal]),
      ),
    )
    const settled = Promise.allSettled(held)
    await f.until(10)
    const queued = invoke(`${f.base}/queued`, t.signal)
    assert.equal(deadlines.length, 10)
    deadlines[0].abort(new DOMException('request timeout', 'TimeoutError'))
    assert.equal((await held[0]).code, 'web_fetch_error')
    assert.equal((await queued).data.text, 'recovered')
    assert.equal(deadlines.length, 11)
    assert.ok(controllers.every((controller) => !controller.signal.aborted))
    controllers.forEach((controller) => controller.abort())
    await settled
  },
)
