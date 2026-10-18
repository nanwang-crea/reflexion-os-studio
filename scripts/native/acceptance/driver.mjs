// Only selected by debug + cef-acceptance Cargo feature. Product builds never load this file.
import '../../../apps/runtime/dist/index.js'
import assert from 'node:assert/strict'
import { runRegression } from './regression.mjs'
import { createInterface } from 'node:readline'
import { createServer } from 'node:http'
import { writeFile } from 'node:fs/promises'
import { HostBrowserTransport } from '../../../apps/runtime/dist/browser/agent/embedded/host.js'
import { EmbeddedConnection } from '../../../apps/runtime/dist/browser/agent/embedded/connection.js'
import { PlaywrightBackend } from '../../../apps/runtime/dist/browser/agent/worker/backend.js'
const output = process.env.CEF_ACCEPTANCE_OUTPUT
if (!output) throw new Error('CEF_ACCEPTANCE_OUTPUT required')
const host = new HostBrowserTransport((message) =>
  process.stdout.write(JSON.stringify(message) + '\n'),
)
createInterface({ input: process.stdin }).on('line', (line) => {
  try {
    const message = JSON.parse(line)
    if (message.id?.startsWith?.('host-browser:') && message.error)
      process.stderr.write(`[cef-acceptance-host] ${message.error.message}\n`)
    host.receive(message)
  } catch {
    /* Runtime handles unrelated input. */
  }
})
let livePosts = 0
const live = process.env.CEF_ACCEPTANCE_LIVE === '1'
const fixture = createServer((request, response) => {
  if (request.url === '/sw.js') {
    response.setHeader('content-type', 'application/javascript')
    response.end(
      "self.addEventListener('install',()=>self.skipWaiting());self.addEventListener('activate',event=>event.waitUntil(self.clients.claim()));self.addEventListener('fetch',event=>{if(new URL(event.request.url).pathname==='/sw-probe')event.respondWith(new Response('worker-active'))})",
    )
    return
  }
  if (request.url === '/agent-search') {
    assert.equal(request.method, 'POST')
    livePosts++
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ result: '北京旅游结果' }))
    return
  }
  if (request.url === '/native-download') {
    response.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-disposition': 'attachment; filename="cef-cancel-test.txt"',
    })
    response.end('Synthetic cancel fixture')
    return
  }
  response.setHeader('content-type', 'text/html; charset=utf-8')
  response.end(
    `<!doctype html><title>CEF 接管验收</title><style>body{font:18px system-ui;padding:24px;background:#f7f9fb}input,button{font:inherit;padding:12px;margin:10px}output{display:block;margin:20px}</style><h1>CEF 共用页面验收</h1><label>公开查询<input aria-label="公开查询"></label><button onclick="document.querySelector('output').textContent=document.querySelector('input').value">应用</button><button onclick="fetch('/agent-search',{method:'POST',body:document.querySelector('input').value}).then(r=>r.json()).then(result=>{history.pushState({},'', '/search_result');document.querySelector('output').textContent=result.result})">POST 搜索</button><button onclick="window.open('/script-popup','_blank')">脚本新窗口</button><output>等待输入</output><p>仅包含合成测试数据。</p><a id="native-popup" href="/native-result" target="_blank">新窗口结果</a><a id="native-download" href="/native-download">取消下载验收</a><script>${live ? "navigator.serviceWorker.register('/sw.js')" : ''}</script>`,
  )
})
const checks = {}
const progress = async (phase, detail = {}) =>
  writeFile(output, JSON.stringify({ phase, ...checks, ...detail }) + '\n')
const waitControl = (paused) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe()
      reject(new Error('handoff timeout'))
    }, 600000)
    const unsubscribe = host.onControl((_lease, value) => {
      if (value === paused) {
        clearTimeout(timer)
        unsubscribe()
        resolve()
      }
    })
  })
let first, second
async function run() {
  await new Promise((resolve) => fixture.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${fixture.address().port}`
  const backend = (session) =>
    new PlaywrightBackend(
      'headed',
      undefined,
      new EmbeddedConnection(host, session),
    )
  if (process.env.CEF_ACCEPTANCE_NETWORK_URL) {
    const probe = backend('cef-network-acceptance')
    try {
      const page = await probe.navigate(process.env.CEF_ACCEPTANCE_NETWORK_URL)
      await probe.read(page.page)
      process.stderr.write(
        `[cef-network-probe] ${JSON.stringify({ title: page.title, sourceUrl: page.sourceUrl })}\n`,
      )
    } finally {
      await probe.close()
    }
  }
  first = backend('cef-acceptance-a')
  const initial = await first.navigate(origin + '/')
  await first.read(initial.page)
  await progress('navigated', {
    viewport: await first.context.pages()[0].evaluate(() => ({
      width: globalThis.innerWidth,
      height: globalThis.innerHeight,
    })),
  })
  process.stderr.write(
    `[cef-acceptance-viewport] ${JSON.stringify(await first.context.pages()[0].evaluate(() => ({ width: globalThis.innerWidth, height: globalThis.innerHeight })))}\n`,
  )
  if (live) {
    const ownedPage = first.context.pages()[0]
    await ownedPage.waitForFunction(
      () => navigator.serviceWorker.controller !== null,
    )
    assert.equal(
      await ownedPage.evaluate(() =>
        fetch('/sw-probe').then((response) => response.text()),
      ),
      'worker-active',
    )
    checks.serviceWorker = true
    const search = await first.execute({
      mode: 'actions',
      page: initial.page,
      steps: [
        {
          action: 'type',
          target: { role: 'textbox', name: '公开查询' },
          text: '北京旅游',
        },
        { action: 'click', target: { role: 'button', name: 'POST 搜索' } },
        { action: 'wait', milliseconds: 200 },
        { action: 'read' },
      ],
    })
    assert.equal(search.error, null)
    assert.equal(livePosts, 1)
    assert.match(search.document.snapshot, /北京旅游结果/)
    assert.equal(
      (await first.read(initial.page)).page.tabId,
      initial.page.tabId,
    )
    await first.navigate(origin + '/')
    const popup = await first.execute({
      mode: 'actions',
      page: initial.page,
      steps: [
        { action: 'click', target: { role: 'button', name: '脚本新窗口' } },
        { action: 'wait', milliseconds: 200 },
        { action: 'read' },
      ],
    })
    assert.equal(popup.error, null)
    assert.match(popup.document.sourceUrl, /script-popup/)
    assert.equal(popup.document.page.tabId, initial.page.tabId)
    await first.navigate(origin + '/')
    checks.livePostSearch = true
    checks.stableTabRead = true
    checks.popupInOwnedTab = true
    process.stderr.write('[cef-live-probe] passed\n')
  }
  const edited = await first.execute({
    mode: 'actions',
    page: initial.page,
    steps: [
      {
        action: 'type',
        target: { role: 'textbox', name: '公开查询' },
        text: 'Agent 中文输入',
      },
      { action: 'click', target: { role: 'button', name: '应用' } },
    ],
  })
  if (edited.error)
    process.stderr.write(`[cef-acceptance-actions] ${JSON.stringify(edited)}\n`)
  assert.equal(edited.error, null)
  const firstDocument = await first.read(edited.document.page)
  assert.match(firstDocument.snapshot, /Agent 中文输入/)
  second = backend('cef-acceptance-b')
  const isolated = await second.navigate(origin + '/')
  const isolatedDocument = await second.read(isolated.page)
  assert.doesNotMatch(isolatedDocument.snapshot, /Agent 中文输入/)
  await second.close()
  second = undefined
  await progress('await-takeover', { isolation: true, agentInput: true })
  await waitControl(true)
  await assert.rejects(first.navigate(origin + '/'), /browser_user_control/)
  await progress('await-resume', { takeoverBlocksAgent: true })
  await waitControl(false)
  const resumed = await first.navigate(origin + '/')
  const resumedDocument = await first.read(resumed.page)
  assert.match(resumedDocument.snapshot, /人工接管输入/)
  const screenshot = await first.execute({
    mode: 'actions',
    page: resumed.page,
    steps: [{ action: 'screenshot', fullPage: false }],
  })
  assert.equal(screenshot.error, null)
  assert.equal(screenshot.screenshots.length, 1)
  let nativeRegression
  if (process.env.CEF_NATIVE_REGRESSION === '1') {
    nativeRegression = await runRegression(
      first.embedded.endpoint,
      `http://127.0.0.1:${fixture.address().port}/native`,
      progress,
    )
  }
  await progress('passed', {
    nativeNavigationRounds: nativeRegression?.rounds ?? 0,
    isolation: true,
    agentInput: true,
    takeoverBlocksAgent: true,
    manualStatePreserved: true,
    screenshot: true,
  })
}
setTimeout(() => {
  void run()
    .catch(async (error) => {
      await progress('failed', {
        error: String(error),
        cause: String(error.cause ?? ''),
      })
      process.stderr.write(`[cef-acceptance] ${error.stack}\n`)
    })
    .finally(async () => {
      await Promise.allSettled([first?.close(), second?.close()])
      fixture.closeAllConnections()
      fixture.close()
      host.dispose()
    })
}, 1500)
