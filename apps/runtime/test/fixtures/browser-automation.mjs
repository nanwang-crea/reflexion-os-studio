import { createServer } from 'node:http'
import { browserWorkerPaths } from '../../dist/browser/agent/paths.js'
import { createBrowserProxy } from '../../dist/browser/agent/security/proxy.js'
process.env.PLAYWRIGHT_BROWSERS_PATH = browserWorkerPaths().browsers
const { PlaywrightBackend } =
  await import('../../dist/browser/agent/worker/backend.js')

export async function browserAutomationFixture(t, display = 'headless') {
  let writes = 0
  const server = createServer((request, response) => {
    if (request.method !== 'GET') writes++
    response.setHeader('content-type', 'text/html; charset=utf-8')
    response.end(`<title>Automation fixture</title><style>body{margin:0}button,input,select{margin:12px}#drop,#source{display:inline-block;padding:20px;background:#ddd}</style>
      <form action="/results"><label>Query<input type="search" name="q"></label><button>Search</button></form>
      <label>Choice<select onchange="document.querySelector('#choice').textContent=this.value"><option value="a">Alpha</option><option value="b">Beta</option></select></label><span id="choice">a</span>
      <button aria-label="Counter" onclick="window.clicks=(window.clicks||0)+1;this.textContent=window.clicks">0</button>
      <button onmouseover="document.querySelector('#detail').textContent='Hover works'">Hover target</button>
      <button onclick="document.querySelector('#detail').textContent='Expanded detail'">Expand</button><p id="detail">Collapsed detail</p>
      <div role="button" aria-label="Drag source" draggable="true" id="source" ondragstart="event.dataTransfer.setData('text/plain','fixture')">Source</div>
      <div role="button" aria-label="Drop target" id="drop" ondragover="event.preventDefault()" ondrop="event.preventDefault();window.drops=(window.drops||0)+1">Drop</div>
      <button onclick="fetch('/write',{method:'POST',body:'public fixture'}).catch(()=>{})">Attempt write</button>
      <div style="height:1800px;background:linear-gradient(#aaf,#faa)">Scrollable public content</div><h2>Footer</h2>
      <label>Secret field<input type="password" autocomplete="current-password" value="synthetic_fixture_only"></label>
      <div style="height:300px;background:green">End</div>`)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://fixture.test:${server.address().port}`
  const backend = new PlaywrightBackend(
    (approved) => createBrowserProxy(approved, async () => '127.0.0.1'),
    async () => '93.184.216.34',
    display,
  )
  t.after(async () => {
    await backend.close()
    await new Promise((resolve) => server.close(resolve))
  })
  const metadata = await backend.navigate(origin + '/')
  return { backend, origin, metadata, writes: () => writes }
}
