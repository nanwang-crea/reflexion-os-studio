import { browserTools } from '../dist/agent/tools/browser.js'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:http'
import { fixture } from './fixtures/skill-packages.mjs'
import {
  createAgentInstance,
  INHERITABLE_CHILD_TOOLS,
} from '../dist/agent/delegation/instance.js'
import { createToolRegistry } from '../dist/agent/tools/index.js'
import { RunEventEmitter } from '../dist/events.js'
import { Store } from '../dist/store/index.js'
import { browserWorkerPaths } from '../dist/browser/agent/paths.js'

const browserNames = ['browser.navigate', 'browser.read', 'browser.close']
function instance(template, tools = INHERITABLE_CHILD_TOOLS) {
  return createAgentInstance({
    spawn: {},
    template,
    inheritedPreset: 'workspace-read',
    inheritedTools: new Set(tools),
    permissionDomainId: 'root',
    canDelegateByDepth: false,
  })
}

test('research browser tools remain an intersection of parent and template; old user roles are unchanged', (t) => {
  const f = fixture(t)
  const researcher = f.store.agents.get('researcher')
  for (const name of browserNames)
    assert.ok(instance(researcher).allowedTools.includes(name))
  const limited = instance(researcher, ['web.fetch', 'skill.use'])
  for (const name of browserNames)
    assert.ok(!limited.allowedTools.includes(name))
  assert.equal(limited.permissionPreset, 'workspace-read')
  const legacy = f.store.agents.saveUser({
    name: 'Existing researcher',
    description: 'Research',
    systemPrompt: 'Use supplied evidence.',
    enabled: true,
    allowedTools: ['web.fetch', 'skill.use'],
    canDelegate: false,
    permissionCeiling: 'workspace-read',
    projectId: f.project.id,
  })
  for (const name of browserNames)
    assert.ok(!instance(legacy).allowedTools.includes(name))
  const restarted = new Store(f.data)
  t.after(() => restarted.close())
  assert.deepEqual(restarted.agents.get(legacy.id).policy.allowedTools, [
    'web.fetch',
    'skill.use',
  ])
})

test('child registry exposes browser tools only when enabled and allowed, without a fictitious search tool', (t) => {
  const f = fixture(t)
  const session = f.store.sessions.create(f.project.id)
  const parent = f.store.runs.create({
    sessionId: session.id,
    providerId: 'test',
    model: 'test',
  })
  const child = f.store.runs.create({
    sessionId: session.id,
    providerId: 'test',
    model: 'test',
    parentRunId: parent.id,
  })
  const build = (enabled, allowedTools) =>
    createToolRegistry({
      store: f.store,
      runId: child.id,
      sessionId: session.id,
      messageId: 'test',
      projectId: f.project.id,
      workspaceRoot: f.workspace,
      skills: f.service.registry,
      emitter: new RunEventEmitter(child.id, () => {}),
      system: null,
      mcp: null,
      interactions: {},
      browser: { enabled },
      allowedTools: new Set(allowedTools),
    })
      .specs()
      .map((tool) => tool.name)
  const allowed = instance(f.store.agents.get('researcher')).allowedTools
  for (const name of browserNames)
    assert.ok(build(true, allowed).includes(name))
  for (const name of browserNames)
    assert.ok(!build(false, allowed).includes(name))
  for (const name of browserNames)
    assert.ok(!build(true, ['web.fetch']).includes(name))
  assert.ok(build(true, allowed).includes('web.fetch'))
  assert.ok(!build(true, allowed).includes('web_search'))
})

test('browser research gets a rendered search link and then reads the actual source', async () => {
  process.env.PLAYWRIGHT_BROWSERS_PATH = browserWorkerPaths().browsers
  const { PlaywrightBackend } = await import('./fixtures/browser-backend.mjs')
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'text/html')
    if (new URL(request.url, 'http://fixture.test').pathname === '/search')
      response.end(
        '<title>Search results</title><main id="results"></main><script>document.getElementById("results").innerHTML=\'<a href="/article">Actual research source</a>\'</script>',
      )
    else
      response.end(
        '<title>Research source</title><h1>Verified source</h1><p>The verified count is 42.</p>',
      )
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://research.test:${server.address().port}`
  const backend = new PlaywrightBackend()
  try {
    const search = await backend.navigate(
      `${origin}/search?q=${encodeURIComponent('公开资料')}`,
    )
    assert.equal(search.snapshot, undefined)
    const results = await backend.read(search.page)
    assert.match(results.snapshot, /Actual research source/)
    assert.ok(results.snapshot.includes('/article'))
    const source = await backend.navigate(`${origin}/article`)
    assert.match(
      (await backend.read(search.page)).snapshot,
      /verified count is 42/,
    )
    assert.match(
      (await backend.read(source.page)).snapshot,
      /verified count is 42/,
    )
  } finally {
    await backend.close()
    await new Promise((resolve) => server.close(resolve))
  }
})

test('legacy network denial recommends updating rather than treating it as empty search', async () => {
  const tool = browserTools({
    browser: {
      enabled: true,
      call: async () => {
        throw new Error('browser_network_denied')
      },
    },
    sessionId: 'session',
    runId: 'run',
  }).find((tool) => tool.name === 'browser.navigate')
  const result = await tool.execute({
    args: { url: 'https://www.google.com/search?q=public' },
    signal: new AbortController().signal,
  })
  assert.equal(result.isError, true)
  assert.equal(result.code, 'browser_network_denied')
  assert.match(result.content, /更新并重启/)
  assert.doesNotMatch(result.content, /请检查 DNS/)
  assert.match(result.content, /不代表搜索无结果/)
})
