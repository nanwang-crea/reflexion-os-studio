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
  assert.equal(api.getOperations()[0].phase, 'succeeded')
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
  assert.equal(api.getOperations()[0].phase, 'succeeded')
  harness.write = async () => ({ ok: true })
  await api.performMutation('workspace.write_file', {
    projectId: 'p',
    path: 'file.txt',
    content: 'next',
  })
  assert.equal(harness.calls.length, 2)
})
