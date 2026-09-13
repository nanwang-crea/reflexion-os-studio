import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { SystemRuntimeClient } from '../dist/system.js'

const here = dirname(fileURLToPath(import.meta.url))
const FIXTURE = join(here, 'fixtures', 'terminal-fake-system-runtime.mjs')

function waitForStatus(
  transitions,
  status,
  expectedCount = 1,
  timeoutMs = 8000,
) {
  return new Promise((resolve, reject) => {
    const reached = () =>
      transitions.filter((entry) => entry === status).length >= expectedCount
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
          `status timeout: ${status} x${expectedCount}; got ${transitions.join(',')}`,
        ),
      )
    }, timeoutMs)
  })
}

test('Rust 通知经 onNotification 路由，且不影响请求响应关联', async () => {
  const notifications = []
  let readyResolve
  const ready = new Promise((resolve) => {
    readyResolve = resolve
  })
  const client = new SystemRuntimeClient(
    process.execPath,
    [FIXTURE],
    (status) => {
      if (status === 'ready') readyResolve()
    },
    (method, params) => notifications.push({ method, params }),
  )
  client.start()
  await ready
  const result = await client.request('system.ping')
  assert.deepEqual(result, { ok: true })
  assert.deepEqual(
    notifications.map((n) => n.method),
    ['terminal.output', 'terminal.state'],
  )
  assert.equal(notifications[0].params.terminalId, 't1')
  assert.equal(notifications[1].params.status, 'running')
  await client.shutdown()
})

// 代际规则（spec §4）的单元保证是 handleLine 里旧代际早退（early-return）那一行；
// 端到端「旧代际迟到帧必须被丢弃」的断言需要 Rust 侧真实 terminal 帧驱动，
// 归入 Task 13 的 spike。此处覆盖崩溃重启（代际 +1）期间路由不抛错、
// 新代际请求-响应与通知路由恢复正常的真实路径。
test('崩溃重启（代际切换）期间通知路由不抛错且新代际恢复正常', async () => {
  const notifications = []
  const transitions = []
  const client = new SystemRuntimeClient(
    process.execPath,
    [FIXTURE],
    (status) => transitions.push(status),
    (method, params) => notifications.push({ method, params }),
  )
  client.start()
  await waitForStatus(transitions, 'ready')
  await client.request('system.ping')
  assert.equal(notifications.length, 2)

  // test.crash：夹具收到请求后直接退出，pending 请求随异常退出被拒绝（既有行为）。
  await client.request('test.crash').catch(() => undefined)
  await waitForStatus(transitions, 'degraded')
  await waitForStatus(transitions, 'ready', 2, 10000)

  const result = await client.request('system.ping')
  assert.deepEqual(result, { ok: true })
  assert.deepEqual(
    notifications.map((n) => n.method),
    ['terminal.output', 'terminal.state', 'terminal.output', 'terminal.state'],
  )
  await client.shutdown()
}, 20000)
