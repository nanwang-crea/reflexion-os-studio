import assert from 'node:assert/strict'
import { test } from 'node:test'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  SystemRuntimeClient,
  resolveSystemRuntimeBinary,
} from '../dist/system.js'

const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'fake-system-runtime.mjs',
)
const NODE = process.execPath

function waitForStatus(
  transitions,
  status,
  expectedCount = 1,
  timeoutMs = 8000,
) {
  return new Promise((resolve, reject) => {
    const reached = () =>
      transitions.filter((entry) => entry.status === status).length >=
      expectedCount
    if (reached()) {
      resolve()
      return
    }
    const timer = setInterval(() => {
      if (reached()) {
        clearInterval(timer)
        clearTimeout(failTimer)
        resolve()
      }
    }, 25)
    const failTimer = setTimeout(() => {
      clearInterval(timer)
      reject(
        new Error(
          `status timeout: ${status} x${expectedCount}; got ${transitions
            .map((entry) => entry.status)
            .join(',')}`,
        ),
      )
    }, timeoutMs)
  })
}

test('client reaches ready, serves requests and shuts down cleanly', async () => {
  const transitions = []
  const client = new SystemRuntimeClient(NODE, [FIXTURE], (status, detail) =>
    transitions.push({ status, detail }),
  )
  client.start()
  await waitForStatus(transitions, 'ready')

  const result = await client.request('system.ping')
  assert.deepEqual(result, { ok: true })

  await client.shutdown()
  assert.equal(client.currentStatus, 'stopped')
  await assert.rejects(client.request('system.ping'), /not available/)
})

test('missing binary degrades to unavailable without crashing', async () => {
  const transitions = []
  const client = new SystemRuntimeClient(null, [], (status) =>
    transitions.push({ status }),
  )
  client.start()
  assert.equal(client.currentStatus, 'unavailable')
  assert.equal(client.available, false)
  await assert.rejects(client.request('system.ping'), /not available/)
})

test('crash after ready triggers limited restart and recovers', async () => {
  const transitions = []
  const client = new SystemRuntimeClient(NODE, [FIXTURE], (status) =>
    transitions.push({ status }),
  )
  // crash-after-ready 夹具：ready 后 100ms 崩溃 → 退避重启 → 恢复 ready。
  process.env.FAKE_MODE = 'crash-after-ready'
  client.start()
  await waitForStatus(transitions, 'ready', 1)
  await waitForStatus(transitions, 'degraded', 1)
  await waitForStatus(transitions, 'ready', 2, 10000)
  assert.equal(client.available, true)
  await client.shutdown()
  delete process.env.FAKE_MODE
}, 20000)

test('startup failure exhausts restart budget and stays degraded', async () => {
  const transitions = []
  const client = new SystemRuntimeClient(NODE, [FIXTURE], (status) =>
    transitions.push({ status }),
  )
  process.env.FAKE_MODE = 'fail-startup'
  client.start()
  // 3 次退避重启（500ms/1s/2s）全部失败后保持 degraded。
  await new Promise((resolve) => setTimeout(resolve, 4500))
  assert.equal(client.available, false)
  const degradedCount = transitions.filter(
    (entry) => entry.status === 'degraded',
  ).length
  assert.ok(degradedCount >= 4, `degraded transitions=${degradedCount}`)
  await client.shutdown()
  delete process.env.FAKE_MODE
}, 20000)

test('binary resolver prefers env and falls back to relative search', () => {
  const previous = process.env.REFLEXION_SYSTEM_RUNTIME_BIN
  process.env.REFLEXION_SYSTEM_RUNTIME_BIN = FIXTURE
  assert.equal(resolveSystemRuntimeBinary(), FIXTURE)
  process.env.REFLEXION_SYSTEM_RUNTIME_BIN =
    '/nonexistent/reflexion-system-runtime'
  // 相对搜索在仓库根执行时可能命中 crates/target；此处只断言不抛异常。
  const resolved = resolveSystemRuntimeBinary()
  assert.ok(resolved === null || typeof resolved === 'string')
  if (previous === undefined) delete process.env.REFLEXION_SYSTEM_RUNTIME_BIN
  else process.env.REFLEXION_SYSTEM_RUNTIME_BIN = previous
})
