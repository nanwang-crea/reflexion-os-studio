import assert from 'node:assert/strict'
import { test } from 'node:test'
import { TerminalService } from '../dist/terminal/service.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function b64(buf) {
  return buf.toString('base64')
}

/** 可控假 SystemRuntimeClient：记录调用，按 behavior 决定 spawn 结果。 */
function fakeSystem(behavior = {}) {
  const calls = []
  const gen = { value: behavior.generation ?? 1 }
  return {
    calls,
    gen,
    get currentGeneration() {
      return gen.value
    },
    async request(method, params) {
      calls.push([method, params])
      if (method === 'terminal.spawn') {
        if (behavior.spawn === 'error')
          throw new Error('pty_error: spawn failed')
        if (behavior.spawn === 'timeout')
          throw new Error('system request timeout: terminal.spawn')
        return {
          terminalId: params.terminalId,
          generation: gen.value,
          outputSeq: 0,
        }
      }
      if (method === 'terminal.attach') return { replayedBytes: 0 }
      if (method === 'terminal.close') return { closed: true }
      if (method === 'terminal.write')
        return { acceptedBytes: params.data.length }
      if (method === 'terminal.resize')
        return { rows: params.rows, cols: params.cols }
      if (method === 'terminal.ack') return { ok: true }
      throw new Error(`unexpected method ${method}`)
    },
  }
}

function harness(opts = {}) {
  const { systemBehavior = {}, config = {}, projects } = opts
  const sys = fakeSystem(systemBehavior)
  const events = []
  const folderPathOf =
    projects ?? ((id) => (id === 'p1' ? { folderPath: '/ws/p1' } : null))
  const service = new TerminalService({
    getProject: folderPathOf,
    system: sys,
    notify: (e) => events.push(e),
    config: {
      attachTimeoutMs: 60_000,
      createTimeoutMs: 2_000,
      egressTickMs: 5,
      egressBudgetBytesPerSec: 50 * 1024 * 1024,
      maxActivePerProject: 8,
      maxActiveGlobal: 16,
      maxRetained: 32,
      inputPendingMax: 4,
      inputGapWaitMs: 200,
      ...config,
    },
  })
  const terminalEvents = () =>
    events.filter((e) => e.type.startsWith('terminal.'))
  const stateEvents = () =>
    events.filter((e) => e.type === 'terminal.state').map((e) => e.status)
  return { service, sys, events, terminalEvents, stateEvents }
}

async function running(h, requestId = 'req') {
  const result = await h.service.create(requestId, 'p1', 24, 80)
  await h.service.attach('p1', result.terminal.terminalId, 'c1')
  return result
}

// ---------------- 1. create happy + 幂等 ----------------

test('create: starting→running，spawn 携带 folderPath cwd', async () => {
  const h = harness()
  const { terminal } = await h.service.create('r1', 'p1', 24, 80)
  assert.equal(terminal.status, 'running')
  assert.equal(terminal.initialCwd, '/ws/p1')
  assert.deepEqual(h.stateEvents(), ['starting', 'running'])
  const spawn = h.sys.calls.find(([m]) => m === 'terminal.spawn')
  assert.equal(spawn[1].cwd, '/ws/p1')
  assert.equal(spawn[1].rows, 24)
})

test('create 并发同 requestId → 只 spawn 一次、同一 terminalId', async () => {
  const h = harness()
  const [a, b] = await Promise.all([
    h.service.create('rX', 'p1', 24, 80),
    h.service.create('rX', 'p1', 24, 80),
  ])
  assert.equal(a.terminal.terminalId, b.terminal.terminalId)
  const spawns = h.sys.calls.filter(([m]) => m === 'terminal.spawn')
  assert.equal(spawns.length, 1)
})

test('create 顺序同 requestId → 复用留存记录，不重生', async () => {
  const h = harness()
  const a = await h.service.create('rY', 'p1', 24, 80)
  const b = await h.service.create('rY', 'p1', 24, 80)
  assert.equal(a.terminal.terminalId, b.terminal.terminalId)
  assert.equal(h.sys.calls.filter(([m]) => m === 'terminal.spawn').length, 1)
})

// ---------------- 2. spawn 失败 / attach 超时（僵尸保护） ----------------

test('spawn error → failed 且无 running', async () => {
  const h = harness({ systemBehavior: { spawn: 'error' } })
  await assert.rejects(() => h.service.create('rE', 'p1', 24, 80))
  assert.deepEqual(h.stateEvents(), ['starting', 'failed'])
})

test('attach 超时 → close 触发 + failed + 额度释放', async () => {
  const h = harness({
    config: { attachTimeoutMs: 30, maxActivePerProject: 1 },
  })
  const { terminal } = await h.service.create('rZ', 'p1', 24, 80)
  await sleep(80)
  assert.ok(h.stateEvents().includes('failed'))
  const closes = h.sys.calls.filter(([m]) => m === 'terminal.close')
  assert.equal(closes[0][1].terminalId, terminal.terminalId)
  // 失败记录以 failed 留存（不计 active）→ active 额度已释放，故新 create 成功。
  const a = await h.service.create('a', 'p1', 24, 80)
  assert.equal(a.terminal.status, 'running')
})

test('spawn 超时 → 幂等 close 兜底 + failed', async () => {
  const h = harness({ systemBehavior: { spawn: 'timeout' } })
  await assert.rejects(() => h.service.create('rT', 'p1', 24, 80))
  assert.deepEqual(h.stateEvents(), ['starting', 'failed'])
  assert.ok(h.sys.calls.some(([m]) => m === 'terminal.close'))
})

// ---------------- 3. 配额 ----------------

test('配额：per-project / global / retained', async () => {
  const h = harness({
    config: { maxActivePerProject: 2, maxActiveGlobal: 3, maxRetained: 2 },
  })
  await running(h, 'a')
  await running(h, 'b')
  await assert.rejects(() => h.service.create('c', 'p1', 24, 80), {
    code: 'terminal_quota_project',
  })
})

test('配额：global 上限跨项目生效', async () => {
  const h = harness({
    projects: (id) =>
      id === 'p1'
        ? { folderPath: '/ws/p1' }
        : id === 'p2'
          ? { folderPath: '/ws/p2' }
          : null,
    config: { maxActivePerProject: 8, maxActiveGlobal: 2 },
  })
  await running(h, 'a')
  await h.service.create('b', 'p2', 24, 80)
  await assert.rejects(() => h.service.create('c', 'p2', 24, 80), {
    code: 'terminal_quota_global',
  })
})

test('配额：retained 满时拒绝新建', async () => {
  const h = harness({ config: { maxRetained: 2, maxActiveGlobal: 16 } })
  const t1 = await h.service.create('r1', 'p1', 24, 80)
  const t2 = await h.service.create('r2', 'p1', 24, 80)
  await h.service.close('p1', t1.terminal.terminalId)
  await h.service.close('p1', t2.terminal.terminalId)
  await assert.rejects(() => h.service.create('r3', 'p1', 24, 80), {
    code: 'terminal_quota_retained',
  })
})

// ---------------- 4. 作用域 / 状态守卫 ----------------

test('跨项目操作一律 terminal_not_found', async () => {
  const h = harness()
  const { terminal } = await running(h)
  await assert.rejects(
    () => h.service.attach('other', terminal.terminalId, 'c'),
    { code: 'terminal_not_found' },
  )
  await assert.rejects(
    () => h.service.write('other', terminal.terminalId, 1, 'aGk='),
    { code: 'terminal_not_found' },
  )
  await assert.rejects(() => h.service.close('other', terminal.terminalId), {
    code: 'terminal_not_found',
  })
})

test('exited 终端 write → terminal_not_running', async () => {
  const h = harness()
  const { terminal } = await running(h)
  h.service.handleRustNotification('terminal.state', {
    terminalId: terminal.terminalId,
    generation: terminal.generation,
    status: 'exited',
    exitCode: 0,
  })
  await assert.rejects(
    () => h.service.write('p1', terminal.terminalId, 1, 'aGk='),
    { code: 'terminal_not_running' },
  )
})

// ---------------- 5. 输入序号串行化 ----------------

test('write 重复序号 → 确认但不重发', async () => {
  const h = harness()
  const { terminal } = await running(h)
  await h.service.write('p1', terminal.terminalId, 1, 'AAA=')
  await h.service.write('p1', terminal.terminalId, 1, 'AAA=')
  const writes = h.sys.calls.filter(([m]) => m === 'terminal.write')
  assert.equal(writes.length, 1)
})

test('write 乱序 1,3,2 → 到 Rust 顺序为 [1,2,3]', async () => {
  const h = harness()
  const { terminal } = await running(h)
  await h.service.write('p1', terminal.terminalId, 1, 'MQ==')
  await h.service.write('p1', terminal.terminalId, 3, 'Mw==')
  await h.service.write('p1', terminal.terminalId, 2, 'Mg==')
  const writes = h.sys.calls
    .filter(([m]) => m === 'terminal.write')
    .map(([, p]) => Buffer.from(p.data, 'base64').toString())
  assert.deepEqual(writes, ['1', '2', '3'])
})

test('write 缓冲超 inputPendingMax → terminal_input_backpressure', async () => {
  const h = harness({ config: { inputPendingMax: 2 } })
  const { terminal } = await running(h)
  await h.service.write('p1', terminal.terminalId, 1, 'MQ==')
  await h.service.write('p1', terminal.terminalId, 3, 'Mw==')
  await h.service.write('p1', terminal.terminalId, 4, 'NA==')
  await assert.rejects(
    () => h.service.write('p1', terminal.terminalId, 5, 'NQ=='),
    { code: 'terminal_input_backpressure' },
  )
})

// ---------------- 6. egress 合并 / 限速 / 公平 ----------------

test('egress 合并 ≤16KiB 事件，outputSeq=尾帧，字节稠密有序', async () => {
  const h = harness({ config: { egressTickMs: 2 } })
  const { terminal } = await running(h)
  const frames = []
  for (let i = 0; i < 40; i++) {
    const bytes = Buffer.alloc(1024, i % 256)
    frames.push(bytes)
    h.service.handleRustNotification('terminal.output', {
      terminalId: terminal.terminalId,
      generation: terminal.generation,
      outputSeq: i,
      data: b64(bytes),
    })
  }
  await sleep(40)
  const outputs = h.events.filter((e) => e.type === 'terminal.output')
  const reassembled = Buffer.concat(
    outputs.map((e) => Buffer.from(e.data, 'base64')),
  )
  assert.equal(reassembled.length, 40 * 1024)
  assert.deepEqual(reassembled, Buffer.concat(frames))
  for (const e of outputs) {
    assert.ok(Buffer.from(e.data, 'base64').length <= 16 * 1024)
  }
  // seq 稠密递增，末事件覆盖到尾帧 39。
  assert.equal(outputs[outputs.length - 1].outputSeq, 39)
  for (let i = 1; i < outputs.length; i++) {
    assert.ok(outputs[i].outputSeq > outputs[i - 1].outputSeq)
  }
})

test('egress 预算耗尽暂停且无丢帧（close 冲刷剩余 → 全量守恒）', async () => {
  const h = harness({
    config: { egressTickMs: 5, egressBudgetBytesPerSec: 1024 },
  })
  const { terminal } = await running(h)
  for (let i = 0; i < 40; i++) {
    h.service.handleRustNotification('terminal.output', {
      terminalId: terminal.terminalId,
      generation: terminal.generation,
      outputSeq: i,
      data: b64(Buffer.alloc(1024, i % 256)),
    })
  }
  await sleep(40)
  const outputs = h.events.filter((e) => e.type === 'terminal.output')
  // 预算极小：只发得出第一个满事件（16KiB），随后暂停。
  assert.equal(outputs.length, 1)
  assert.equal(Buffer.from(outputs[0].data, 'base64').length, 16 * 1024)
  // close 冲刷剩余 24 帧，总量守恒 → 暂停期间无丢帧。
  await h.service.close('p1', terminal.terminalId)
  const all = h.events.filter((e) => e.type === 'terminal.output')
  const total = all.reduce(
    (n, e) => n + Buffer.from(e.data, 'base64').length,
    0,
  )
  assert.equal(total, 40 * 1024)
})

test('egress 两终端轮询公平（交替发出）', async () => {
  const h = harness({ config: { egressTickMs: 2 } })
  const a = (await running(h, 'ra')).terminal
  const bb = (await running(h, 'rb')).terminal
  for (let i = 0; i < 3; i++) {
    h.service.handleRustNotification('terminal.output', {
      terminalId: a.terminalId,
      generation: a.generation,
      outputSeq: i,
      data: b64(Buffer.alloc(16 * 1024, 1)),
    })
    h.service.handleRustNotification('terminal.output', {
      terminalId: bb.terminalId,
      generation: bb.generation,
      outputSeq: i,
      data: b64(Buffer.alloc(16 * 1024, 2)),
    })
  }
  await sleep(40)
  const ids = h.events
    .filter((e) => e.type === 'terminal.output')
    .map((e) => e.terminalId)
  // 轮询：a、b 交替出现，绝不先把一个终端排空再轮到另一个。
  for (let i = 1; i < ids.length; i++) {
    if (i < 5)
      assert.notEqual(ids[i], ids[i - 1], `顺序未交替: ${ids.join(',')}`)
  }
  assert.ok(ids.includes(a.terminalId) && ids.includes(bb.terminalId))
})

// ---------------- 7. 通知接线与顺序 ----------------

test('旧代际通知丢弃', async () => {
  const h = harness()
  const { terminal } = await running(h)
  h.service.handleRustNotification('terminal.output', {
    terminalId: terminal.terminalId,
    generation: terminal.generation + 1,
    outputSeq: 0,
    data: b64(Buffer.from('x')),
  })
  assert.equal(h.events.filter((e) => e.type === 'terminal.output').length, 0)
})

test('exited 事件仅一次', async () => {
  const h = harness()
  const { terminal } = await running(h)
  const n = () =>
    h.events.filter((e) => e.type === 'terminal.state' && e.status === 'exited')
      .length
  h.service.handleRustNotification('terminal.state', {
    terminalId: terminal.terminalId,
    generation: terminal.generation,
    status: 'exited',
    exitCode: 3,
  })
  h.service.handleRustNotification('terminal.state', {
    terminalId: terminal.terminalId,
    generation: terminal.generation,
    status: 'exited',
    exitCode: 3,
  })
  assert.equal(n(), 1)
})

test('exited 后 close → 收敛 closed，无重复 exited', async () => {
  const h = harness()
  const { terminal } = await running(h)
  h.service.handleRustNotification('terminal.state', {
    terminalId: terminal.terminalId,
    generation: terminal.generation,
    status: 'exited',
    exitCode: 0,
  })
  await h.service.close('p1', terminal.terminalId)
  const statuses = h.stateEvents()
  assert.equal(statuses.filter((s) => s === 'exited').length, 1)
  assert.equal(statuses[statuses.length - 1], 'closed')
})

test('close 前冲刷尾部输出：output 事件先于 closed 状态', async () => {
  const h = harness({
    config: { egressTickMs: 5, egressBudgetBytesPerSec: 512 },
  })
  const { terminal } = await running(h)
  for (let i = 0; i < 3; i++) {
    h.service.handleRustNotification('terminal.output', {
      terminalId: terminal.terminalId,
      generation: terminal.generation,
      outputSeq: i,
      data: b64(Buffer.from(`out-${i}`)),
    })
  }
  await h.service.close('p1', terminal.terminalId)
  const tail = h.events
    .filter(
      (e) =>
        e.type === 'terminal.output' ||
        (e.type === 'terminal.state' && e.status === 'closed'),
    )
    .map((e) => e.type)
  const closedIdx = tail.lastIndexOf('terminal.state')
  assert.ok(closedIdx > 0, 'closed 前应有输出冲刷')
  for (let i = 0; i < closedIdx; i++) {
    assert.equal(tail[i], 'terminal.output')
  }
})

// ---------------- 8. 降级断开 ----------------

test('markAllDisconnected：running→disconnected 且 write 被拒', async () => {
  const h = harness()
  const { terminal } = await running(h)
  const count = h.service.markAllDisconnected('degraded')
  assert.equal(count, 1)
  assert.ok(h.stateEvents().includes('disconnected'))
  await assert.rejects(
    () => h.service.write('p1', terminal.terminalId, 2, 'AAA='),
    { code: 'terminal_not_running' },
  )
})

test('断开后新代际 spawn 正常', async () => {
  const h = harness()
  await running(h, 'old')
  h.service.markAllDisconnected('degraded')
  h.sys.gen.value = 2
  const fresh = await h.service.create('new', 'p1', 30, 100)
  assert.equal(fresh.terminal.status, 'running')
  assert.equal(fresh.terminal.generation, 2)
})

// ---------------- 9. ack 单调 ----------------

test('ack 只向 Rust 转发更大值', async () => {
  const h = harness()
  const { terminal } = await running(h)
  await h.service.ack('p1', terminal.terminalId, 5)
  await h.service.ack('p1', terminal.terminalId, 3)
  await h.service.ack('p1', terminal.terminalId, 7)
  const acks = h.sys.calls
    .filter(([m]) => m === 'terminal.ack')
    .map(([, p]) => p.throughOutputSeq)
  assert.deepEqual(acks, [5, 7])
})
