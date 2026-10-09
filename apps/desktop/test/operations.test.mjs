import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
const compiled = await build({
  entryPoints: [
    fileURLToPath(new URL('../frontend/api/operations.ts', import.meta.url)),
  ],
  bundle: true,
  format: 'esm',
  write: false,
  plugins: [
    {
      name: 'transport',
      setup(build) {
        build.onResolve({ filter: /lib\/transport$/ }, (args) => ({
          path: args.path,
          namespace: 'mock',
        }))
        build.onLoad({ filter: /.*/, namespace: 'mock' }, () => ({
          contents: `export const newRequestId=()=>String(++globalThis.opTest.id); export const transport={request:(...args)=>globalThis.opTest.request(...args),onEvent:f=>{globalThis.opTest.event=f}};`,
        }))
      },
    },
  ],
})
async function setup(id, saved = '[]') {
  const storage = new Map([['operations.unconfirmed', saved]])
  globalThis.localStorage = {
    getItem: (k) => storage.get(k) ?? null,
    setItem: (k, v) => storage.set(k, v),
  }
  const harness = {
    id: 0,
    calls: [],
    result: null,
    request(method, params) {
      harness.calls.push([method, params])
      if (method === 'operation.get')
        return Promise.resolve({ operation: harness.result })
      return harness.write()
    },
  }
  globalThis.opTest = harness
  const api = await import(
    'data:text/javascript;base64,' +
      Buffer.from(compiled.outputFiles[0].text).toString('base64') +
      '#' +
      id
  )
  api.initializeOperations()
  return { api, harness, storage }
}
test('rapid duplicate clicks and ambiguous timeout never submit a second write', async () => {
  const { api, harness, storage } = await setup('timeout')
  let reject
  harness.write = () =>
    new Promise((_, r) => {
      reject = r
    })
  const first = api.performMutation('workspace.git_commit', { projectId: 'p' })
  await assert.rejects(
    api.performMutation('workspace.git_commit', { projectId: 'p' }),
    /避免重复写入/,
  )
  reject(new Error('runtime request timeout: workspace.git_commit'))
  await assert.rejects(first, /结果尚未确认/)
  await assert.rejects(
    api.performMutation('workspace.git_commit', { projectId: 'p' }),
    /避免重复写入/,
  )
  assert.equal(harness.calls.length, 1)
  assert.equal(api.getOperations()[0].phase, 'uncertain')
  assert.ok(
    storage.get('operations.unconfirmed').includes('workspace.git_commit'),
  )
  harness.result = {
    method: 'workspace.git_commit',
    requestId: '1',
    phase: 'succeeded',
    error: null,
  }
  await api.checkOperation('git:p')
  assert.equal(api.getOperations().length, 0)
  assert.equal(
    harness.calls.filter(([method]) => method === 'workspace.git_commit')
      .length,
    1,
  )
})
test('uncertainty survives startup; active requests cannot be acknowledged', async () => {
  const { api, harness } = await setup(
    'restart',
    JSON.stringify([
      { key: 'git:p', method: 'workspace.git_commit', requestId: 'old' },
    ]),
  )
  assert.equal(api.getOperations()[0].phase, 'uncertain')
  assert.equal(harness.calls.length, 0)
  harness.result = {
    requestId: 'old',
    method: 'workspace.git_commit',
    phase: 'running',
    error: null,
  }
  await api.checkOperation('git:p')
  api.acknowledgeOperation('git:p')
  assert.equal(api.getOperations().length, 1)
  harness.result = null
  await api.checkOperation('git:p')
  api.acknowledgeOperation('git:p')
  assert.equal(api.getOperations().length, 0)
  assert.deepEqual(
    harness.calls.map(([method]) => method),
    ['operation.get', 'operation.get'],
  )
})
test('a late success releases protection and a subsequent explicit operation can proceed', async () => {
  const { api, harness } = await setup('late')
  harness.write = async () => {
    throw new Error('runtime request timeout')
  }
  await assert.rejects(
    api.performMutation('workspace.write_file', {
      projectId: 'p',
      path: 'file.txt',
      content: 'original',
    }),
  )
  harness.event({
    type: 'operation.changed',
    operation: {
      method: 'workspace.write_file',
      requestId: '1',
      phase: 'succeeded',
      error: null,
    },
  })
  assert.equal(api.getOperations().length, 0)
  harness.write = async () => ({ ok: true })
  await api.performMutation('workspace.write_file', {
    projectId: 'p',
    path: 'file.txt',
    content: 'next',
  })
  assert.equal(harness.calls.length, 2)
})

test('settled feedback is removed without dropping uncertain writes', async () => {
  const { api, harness, storage } = await setup('bounded')
  harness.write = async () => {
    throw new Error('runtime request timeout')
  }
  await assert.rejects(
    api.performMutation('workspace.write_file', {
      projectId: 'p',
      path: 'pending.txt',
    }),
    /结果尚未确认/,
  )
  harness.write = async () => ({ ok: true })
  for (let i = 0; i < 60; i++) {
    await api.performMutation('workspace.write_file', {
      projectId: 'p',
      path: `file-${i}.txt`,
    })
  }
  assert.equal(api.getOperations().length, 1)
  assert.equal(api.getOperations()[0].phase, 'uncertain')
  assert.equal(JSON.parse(storage.get('operations.unconfirmed')).length, 1)
  await assert.rejects(
    api.performMutation('workspace.write_file', {
      projectId: 'p',
      path: 'pending.txt',
    }),
    /避免重复写入/,
  )
})

test('explicit failures are removed and can be retried', async () => {
  const { api, harness } = await setup('bounded-failures')
  harness.write = async () => {
    throw new Error('commit rejected')
  }
  for (let i = 0; i < 60; i++) {
    await assert.rejects(
      api.performMutation('workspace.git_commit', { projectId: 'p' }),
      /commit rejected/,
    )
  }
  assert.equal(api.getOperations().length, 0)
  harness.write = async () => ({ ok: true })
  await api.performMutation('workspace.git_commit', { projectId: 'p' })
  assert.equal(api.getOperations().length, 0)
})

test('completion is delivered once without retaining records or blocking the next operation', async () => {
  const { api, harness, storage } = await setup('completion')
  const completions = []
  const unsubscribe = api.subscribeOperationCompletions((item) => {
    assert.equal(api.getOperations().length, 0)
    completions.push(item)
  })
  harness.write = async () => {
    harness.event({
      type: 'operation.changed',
      operation: {
        method: 'workspace.git_commit',
        requestId: String(harness.id),
        phase: 'succeeded',
        error: null,
      },
    })
    return { ok: true }
  }
  await api.performMutation('workspace.git_commit', { projectId: 'p' })
  await api.performMutation('workspace.git_commit', { projectId: 'p' })
  assert.equal(completions.length, 2)
  assert.notEqual(completions[0].requestId, completions[1].requestId)
  assert.equal(storage.get('operations.unconfirmed'), '[]')
  unsubscribe()
  await api.performMutation('workspace.git_commit', { projectId: 'p' })
  assert.equal(completions.length, 2)
})

test('an old response cannot clear protection for a newer operation on the same resource', async () => {
  const { api, harness } = await setup('old-response')
  const resolves = []
  harness.write = () => new Promise((resolve) => resolves.push(resolve))
  const first = api.performMutation('workspace.write_file', {
    projectId: 'p',
    path: 'file.txt',
  })
  harness.event({
    type: 'operation.changed',
    operation: {
      method: 'workspace.write_file',
      requestId: '1',
      phase: 'succeeded',
      error: null,
    },
  })
  const second = api.performMutation('workspace.write_file', {
    projectId: 'p',
    path: 'file.txt',
  })
  resolves[0]({ ok: true })
  await first
  assert.equal(api.getOperations()[0].requestId, '2')
  await assert.rejects(
    api.performMutation('workspace.write_file', {
      projectId: 'p',
      path: 'file.txt',
    }),
    /避免重复写入/,
  )
  resolves[1]({ ok: true })
  await second
  assert.equal(api.getOperations().length, 0)
})
