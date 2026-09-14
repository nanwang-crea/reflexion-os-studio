import assert from 'node:assert/strict'
import { test } from 'node:test'
import { TerminalService } from '../dist/terminal/service.js'
import { SystemRuntimeError } from '../dist/system.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function b64(buf) {
  return buf.toString('base64')
}

/**
 * 可控假 SystemRuntimeClient：记录调用，按 behavior 决定 spawn 结果。
 * 错误两种形态（终审 #2 双路径覆盖）：*Code 给出 = 结构化 SystemRuntimeError
 * （真实 Rust 经 error.data.code 透传的形态）；不给 = 纯 message 文本
 * （legacy 子串兜底路径，W4-2b 前的唯一通路）。
 */
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
        if (behavior.spawn === 'error') {
          if (behavior.spawnCode) {
            throw new SystemRuntimeError(
              behavior.spawnMessage ?? 'openpty failed: No such file',
              behavior.spawnCode,
            )
          }
          throw new Error(behavior.spawnMessage ?? 'pty_error: spawn failed')
        }
        if (behavior.spawn === 'timeout')
          throw new Error('system request timeout: terminal.spawn')
        const result = {
          terminalId: params.terminalId,
          generation: gen.value,
          outputSeq: 0,
        }
        if (behavior.spawnShellArgv !== 'missing') {
          result.shellArgv = behavior.spawnShellArgv ?? ['/bin/sh']
        }
        return result
      }
      if (method === 'terminal.attach') return { replayedBytes: 0 }
      if (method === 'terminal.close') {
        if (behavior.closeFail) {
          throw new Error(behavior.closeFailMessage ?? 'io_error: kill failed')
        }
        return { closed: true }
      }
      if (method === 'terminal.write') {
        if (behavior.writeFail) {
          if (behavior.writeFailCode) {
            throw new SystemRuntimeError(
              behavior.writeFailMessage ?? 'rejected',
              behavior.writeFailCode,
            )
          }
          throw new Error(
            behavior.writeFailMessage ?? 'input_backpressure: queue full',
          )
        }
        return { acceptedBytes: params.data.length }
      }
      if (method === 'terminal.resize')
        return { rows: params.rows, cols: params.cols }
      if (method === 'terminal.ack') {
        if (behavior.ackFailCode) {
          throw new SystemRuntimeError(
            behavior.ackFailMessage ?? 'rejected',
            behavior.ackFailCode,
          )
        }
        return { ok: true }
      }
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
      closedRetentionMs: 60_000,
      inputBatchMaxBytes: 8 * 1024,
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

// ---------------- 1b. shellArgv 贯通（spec §4：元数据必须携带 shell） ----------------

test('create：Rust spawn 结果的 shellArgv 写入 meta（create + 幂等重放 + list）', async () => {
  const h = harness({ systemBehavior: { spawnShellArgv: ['/bin/zsh', '-i'] } })
  const { terminal } = await h.service.create('rSA', 'p1', 24, 80)
  assert.deepEqual(terminal.shellArgv, ['/bin/zsh', '-i'])
  const again = await h.service.create('rSA', 'p1', 24, 80)
  assert.deepEqual(again.terminal.shellArgv, ['/bin/zsh', '-i'])
  const [listed] = h.service.list('p1')
  assert.deepEqual(listed.shellArgv, ['/bin/zsh', '-i'])
})

test('create：旧 sidecar 结果缺 shellArgv → 保留现值不清空', async () => {
  const h = harness({ systemBehavior: { spawnShellArgv: 'missing' } })
  const { terminal } = await h.service.create('rSM', 'p1', 24, 80)
  assert.deepEqual(terminal.shellArgv, [])
})

// ---------------- 2. spawn 失败 / attach 超时（僵尸保护） ----------------

test('spawn error → failed 且无 running，事件带截断到 200 的 errorMessage', async () => {
  const h = harness({
    systemBehavior: {
      spawn: 'error',
      spawnMessage: `pty_error: ${'x'.repeat(300)}`,
    },
  })
  await assert.rejects(() => h.service.create('rE', 'p1', 24, 80))
  assert.deepEqual(h.stateEvents(), ['starting', 'failed'])
  const failed = h.events.filter(
    (e) => e.type === 'terminal.state' && e.status === 'failed',
  )
  assert.equal(failed.length, 1)
  assert.ok(failed[0].errorMessage.startsWith('pty_error:'))
  assert.equal(failed[0].errorMessage.length, 200)
})

test('attach 超时 → close 触发 + failed（事件带失败原因）+ 额度释放', async () => {
  const h = harness({
    config: { attachTimeoutMs: 30, maxActivePerProject: 1 },
  })
  const { terminal } = await h.service.create('rZ', 'p1', 24, 80)
  await sleep(80)
  assert.ok(h.stateEvents().includes('failed'))
  const failed = h.events.filter(
    (e) => e.type === 'terminal.state' && e.status === 'failed',
  )
  assert.match(failed[failed.length - 1].errorMessage, /attach timeout/)
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

/// 终审 #2：Rust error.data.code 经 SystemRuntimeError 结构化透传后，
/// create 失败必须带**同一**前端契约码（pty_error / too_many_terminals），
/// 不再是 index.ts 的 internal 兜底——上方 "spawn error → failed" 用例走
/// 的是 legacy message 子串路径，本用例走结构化路径，两条各钉一次。
test('create：结构化 pty_error 码贯通 → CommandError pty_error（非 internal）', async () => {
  const h = harness({
    systemBehavior: { spawn: 'error', spawnCode: 'pty_error' },
  })
  await assert.rejects(() => h.service.create('rEC', 'p1', 24, 80), {
    name: 'CommandError',
    code: 'pty_error',
  })
})

test('create：结构化 too_many_terminals 码贯通（Rust 侧额度满如实上报）', async () => {
  const h = harness({
    systemBehavior: {
      spawn: 'error',
      spawnCode: 'too_many_terminals',
      spawnMessage: 'active terminal limit reached',
    },
  })
  await assert.rejects(() => h.service.create('rET', 'p1', 24, 80), {
    code: 'too_many_terminals',
  })
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

/// 终审 #1 重写（spec §5「closed 不长期保留」+ 留存额度口径）：
/// retained 只计 exited/failed/disconnected 等**可见**留存标签；closed
/// 记录短暂驻留（可列、幂等窗口内可见）后由 create 时 TTL 清扫，不占额度。
test('配额：retained 满（exited）拒绝新建；close 收敛后额度即释放', async () => {
  const h = harness({ config: { maxRetained: 2, maxActiveGlobal: 16 } })
  const a = await running(h, 'r1')
  const b = await running(h, 'r2')
  h.service.handleRustNotification('terminal.state', {
    terminalId: a.terminal.terminalId,
    generation: a.terminal.generation,
    status: 'exited',
    exitCode: 0,
  })
  h.service.handleRustNotification('terminal.state', {
    terminalId: b.terminal.terminalId,
    generation: b.terminal.generation,
    status: 'exited',
    exitCode: 0,
  })
  await sleep(10) // 回收 close fire-and-forget 落 calls，不改状态
  await assert.rejects(() => h.service.create('r3', 'p1', 24, 80), {
    code: 'terminal_quota_retained',
  })
  // close 静默收敛 closed：退出可见集合 → 不再计 retained。
  await h.service.close('p1', a.terminal.terminalId)
  await h.service.close('p1', b.terminal.terminalId)
  const c = await h.service.create('r4', 'p1', 24, 80)
  assert.equal(c.terminal.status, 'running')
})

test('配额：closed 一律不占 retained——33× create+close 持续成功', async () => {
  // 旧口径（closed 计 retained）在第 3 轮即 terminal_quota_retained；
  // 新口径 + create 时 TTL 清扫双保险：maxRetained=1 也不该挡住 closed 循环。
  const h = harness({ config: { maxRetained: 1, closedRetentionMs: 5_000 } })
  for (let i = 0; i < 33; i += 1) {
    const { terminal } = await h.service.create(`loop${i}`, 'p1', 24, 80)
    await h.service.close('p1', terminal.terminalId)
  }
  assert.ok(true)
})

test('closed 记录：TTL 内仍可列，TTL 后被下一次 create 清扫出索引', async () => {
  const h = harness({ config: { closedRetentionMs: 20 } })
  const { terminal } = await running(h, 'r1')
  await h.service.close('p1', terminal.terminalId)
  assert.ok(
    h.service.list('p1').some((t) => t.terminalId === terminal.terminalId),
    'closed 短暂驻留期内应可列（幂等/竞态窗口）',
  )
  await sleep(30)
  const fresh = await running(h, 'r2')
  const listed = h.service.list('p1')
  assert.ok(
    !listed.some((t) => t.terminalId === terminal.terminalId),
    '过期 closed 必须已被 create 时清扫',
  )
  assert.deepEqual(
    listed.map((t) => t.terminalId),
    [fresh.terminal.terminalId],
  )
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

test('write 乱序 1,3,2 → 到 Rust 顺序为 [1,2,3]（乱序写等补齐后应答）', async () => {
  const h = harness()
  const { terminal } = await running(h)
  const id = terminal.terminalId
  await h.service.write('p1', id, 1, 'MQ==')
  const held = h.service.write('p1', id, 3, 'Mw==')
  await h.service.write('p1', id, 2, 'Mg==')
  assert.deepEqual(await held, { accepted: true, inputSeq: 3 })
  const writes = h.sys.calls
    .filter(([m]) => m === 'terminal.write')
    .map(([, p]) => Buffer.from(p.data, 'base64').toString())
  assert.deepEqual(writes, ['1', '2', '3'])
})

test('write 缓冲超 inputPendingMax → terminal_input_backpressure', async () => {
  const h = harness({ config: { inputPendingMax: 2 } })
  const { terminal } = await running(h)
  const id = terminal.terminalId
  await h.service.write('p1', id, 1, 'MQ==')
  const held3 = h.service.write('p1', id, 3, 'Mw==')
  const held4 = h.service.write('p1', id, 4, 'NA==')
  await assert.rejects(() => h.service.write('p1', id, 5, 'NQ=='), {
    code: 'terminal_input_backpressure',
  })
  await h.service.write('p1', id, 2, 'Mg==') // 补齐缺口 → 3、4 依序刷出
  await Promise.all([held3, held4])
})

/// W4-2b + 终审 #2（legacy 路径）：错误**不带**结构化码时，message 子串
/// input_backpressure 仍须还原为前端契约码 terminal_input_backpressure——
/// definite 错误回执触发 input-channel.ts 的一次退避重试；不映射会落
/// internal → halt。结构化主路径见下一条。
test('Rust input_backpressure（legacy message 子串）→ terminal_input_backpressure', async () => {
  const h = harness({ systemBehavior: { writeFail: true } })
  const { terminal } = await running(h)
  await assert.rejects(
    () => h.service.write('p1', terminal.terminalId, 1, 'MQ=='),
    { code: 'terminal_input_backpressure' },
  )
})

/// 终审 #2（结构化主路径）：Rust data.code=input_backpressure（真实形态：
/// message 不含码子串）必须映射为 terminal_input_backpressure。
test('Rust input_backpressure（结构化 data.code）→ terminal_input_backpressure', async () => {
  const h = harness({
    systemBehavior: {
      writeFail: true,
      writeFailCode: 'input_backpressure',
      writeFailMessage: 'queue full',
    },
  })
  const { terminal } = await running(h)
  await assert.rejects(
    () => h.service.write('p1', terminal.terminalId, 1, 'MQ=='),
    { code: 'terminal_input_backpressure' },
  )
})

test('Rust terminal_closed 在 write 路径仍透传为 terminal_closed（legacy）', async () => {
  const h = harness({
    systemBehavior: { writeFail: true, writeFailMessage: 'terminal_closed' },
  })
  const { terminal } = await running(h)
  await assert.rejects(
    () => h.service.write('p1', terminal.terminalId, 1, 'MQ=='),
    { code: 'terminal_closed' },
  )
})

test('Rust terminal_closed（结构化 data.code）→ write 拒绝；ack 吞掉、其余码上抛', async () => {
  const h = harness({
    systemBehavior: {
      writeFail: true,
      writeFailCode: 'terminal_closed',
      ackFailCode: 'terminal_closed',
    },
  })
  const { terminal } = await running(h)
  await assert.rejects(
    () => h.service.write('p1', terminal.terminalId, 1, 'MQ=='),
    { code: 'terminal_closed' },
  )
  // ack 守卫改按结构化码匹配（终审 #2）：terminal_closed 吞掉=幂等成功。
  await h.service.ack('p1', terminal.terminalId, 9)
  // 其他结构化码（io_error）不得被 ack 吞掉。
  const h2 = harness({
    systemBehavior: { ackFailCode: 'io_error', ackFailMessage: 'kill failed' },
  })
  const t2 = await running(h2)
  await assert.rejects(() => h2.service.ack('p1', t2.terminal.terminalId, 1), {
    code: 'io_error',
  })
})

/// 终审 #3（spec §6）：单输入批次解码后 >8 KiB → Runtime 层快拒
/// terminal_input_batch_too_large（前端已切批，正常不触发，防御性硬校验）。
test('write 批次 >8 KiB → terminal_input_batch_too_large；恰 8 KiB 合法', async () => {
  const h = harness()
  const { terminal } = await running(h)
  const over = b64(Buffer.alloc(8 * 1024 + 1, 0x61))
  await assert.rejects(
    () => h.service.write('p1', terminal.terminalId, 1, over),
    { code: 'terminal_input_batch_too_large' },
  )
  const exact = b64(Buffer.alloc(8 * 1024, 0x61))
  const ok = await h.service.write('p1', terminal.terminalId, 1, exact)
  assert.deepEqual(ok, { accepted: true, inputSeq: 1 })
  // 超限批次绝不转发 Rust：只有一笔恰好 8 KiB 的 write 到达。
  const writes = h.sys.calls.filter(([m]) => m === 'terminal.write')
  assert.equal(writes.length, 1)
})

test('输入间隙超时：缓冲的 seq=5 拒绝 terminal_input_out_of_order；seq=3 自愈', async () => {
  const h = harness({ config: { inputGapWaitMs: 20 } })
  const { terminal } = await running(h)
  const id = terminal.terminalId
  await h.service.write('p1', id, 1, 'MQ==')
  await h.service.write('p1', id, 2, 'Mg==')
  const held = h.service.write('p1', id, 5, 'NQ==')
  await assert.rejects(held, { code: 'terminal_input_out_of_order' })
  // 丢弃窗口内：晚到的乱序写立即拒绝（稳定码），直到期望 seq 到达。
  await assert.rejects(() => h.service.write('p1', id, 6, 'Ng=='), {
    code: 'terminal_input_out_of_order',
  })
  // 自愈：前端下一批会带 expected seq=3；落地即清除间隙状态。
  const healed = await h.service.write('p1', id, 3, 'Mw==')
  assert.deepEqual(healed, { accepted: true, inputSeq: 3 })
  const writes = h.sys.calls
    .filter(([m]) => m === 'terminal.write')
    .map(([, p]) => Buffer.from(p.data, 'base64').toString())
  assert.deepEqual(writes, ['1', '2', '3'])
})

test('间隙丢弃 stderr 指标行：terminalId + 丢弃数，不含内容', async () => {
  const h = harness({ config: { inputGapWaitMs: 20 } })
  const { terminal } = await running(h)
  const id = terminal.terminalId
  await h.service.write('p1', id, 1, 'MQ==')
  const held3 = h.service.write('p1', id, 3, 'Mw==')
  const held4 = h.service.write('p1', id, 4, 'NA==')
  const original = process.stderr.write.bind(process.stderr)
  let captured = ''
  process.stderr.write = (chunk) => {
    captured += String(chunk)
    return true
  }
  try {
    await assert.rejects(held3, { code: 'terminal_input_out_of_order' })
    await assert.rejects(held4, { code: 'terminal_input_out_of_order' })
  } finally {
    process.stderr.write = original
  }
  assert.match(captured, new RegExp(`terminal=${id}`))
  assert.match(captured, /dropped=2/)
  assert.ok(!captured.includes('Mw=='), '指标行不得含输入内容')
  assert.ok(!captured.includes('NA=='), '指标行不得含输入内容')
})

test('缓冲写未决时 close → 以 terminal_closed 拒绝（无悬挂 promise）', async () => {
  const h = harness({ config: { inputGapWaitMs: 5_000 } })
  const { terminal } = await running(h)
  const id = terminal.terminalId
  await h.service.write('p1', id, 1, 'MQ==')
  const held = h.service.write('p1', id, 3, 'Mw==')
  const assertion = assert.rejects(held, { code: 'terminal_closed' })
  await h.service.close('p1', id)
  await assertion
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

test('egress 饱和轮询：4 积压通道环形分发，无一饿死（W4 修复）', async () => {
  // 预算 ≈ 每 5-6 tick 发得出一个满事件：固定插入顺序开扫会让首个通道吞掉
  // 全部令牌、其后通道整段窗口 0 字节（W4 P1 实测钉出的缺陷）。
  const h = harness({
    config: { egressTickMs: 2, egressBudgetBytesPerSec: 2 * 1024 * 1024 },
  })
  const terms = []
  for (let i = 0; i < 4; i += 1) {
    terms.push((await running(h, `rr${i}`)).terminal)
  }
  for (const [i, term] of terms.entries()) {
    for (let f = 0; f < 10; f += 1) {
      h.service.handleRustNotification('terminal.output', {
        terminalId: term.terminalId,
        generation: term.generation,
        outputSeq: f,
        data: b64(Buffer.alloc(16 * 1024, i + 1)),
      })
    }
  }
  await sleep(250)
  const ids = h.events
    .filter((e) => e.type === 'terminal.output')
    .map((e) => e.terminalId)
  assert.ok(ids.length >= 8, `发出事件数过低: ${ids.length}`)
  const first = ids.slice(0, terms.length)
  assert.deepEqual(
    [...new Set(first)].sort(),
    terms.map((t) => t.terminalId).sort(),
    `前 ${terms.length} 个事件未覆盖全部通道（顺序: ${first.join(',')}）`,
  )
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

test('exited 后 close → 静默收敛 closed（免重复 Rust close），无重复 exited', async () => {
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
  // 回收语义（#2）：Rust close 已由 exited 回收发出，closeTab 不再二次调用，
  // 也不追加 closing/closed 事件——tab 直接消失，exited+exitCode 是展示契约。
  assert.ok(!statuses.includes('closed'))
  assert.ok(!statuses.includes('closing'))
  assert.equal(h.sys.calls.filter(([m]) => m === 'terminal.close').length, 1)
  const [listed] = h.service.list('p1')
  assert.equal(listed.status, 'closed')
})

// ---------------- 7b. exited 额度回收（Rust 表含 exited-not-closed） ----------------

const rustExited = (h, terminal, exitCode = 0) =>
  h.service.handleRustNotification('terminal.state', {
    terminalId: terminal.terminalId,
    generation: terminal.generation,
    status: 'exited',
    exitCode,
  })

test('exited 通知 → 发出一次 Rust close 回收额度', async () => {
  const h = harness()
  const { terminal } = await running(h)
  rustExited(h, terminal)
  await sleep(10)
  const closes = h.sys.calls.filter(([m]) => m === 'terminal.close')
  assert.equal(closes.length, 1)
  assert.equal(closes[0][1].terminalId, terminal.terminalId)
})

test('exited 后的 Rust closed 通知 → 吞掉：无新事件，meta 保持 exited+exitCode', async () => {
  const h = harness()
  const { terminal } = await running(h)
  const before = h.stateEvents().length
  rustExited(h, terminal, 7)
  await sleep(10)
  h.service.handleRustNotification('terminal.state', {
    terminalId: terminal.terminalId,
    generation: terminal.generation,
    status: 'closed',
    exitCode: null,
  })
  await sleep(10)
  const after = h.stateEvents()
  assert.equal(after.length, before + 1, 'closed 不得追加任何状态事件')
  assert.equal(after[after.length - 1], 'exited')
  const [listed] = h.service.list('p1')
  assert.equal(listed.status, 'exited')
  assert.equal(listed.exitCode, 7)
})

test('exited 额度释放：16 个 exited 不饿死新 spawn（TS active 与 Rust 表一致）', async () => {
  const h = harness({ config: { maxActiveGlobal: 2 } })
  const a = (await running(h, 'ra')).terminal
  const b = (await running(h, 'rb')).terminal
  await assert.rejects(() => h.service.create('rc', 'p1', 24, 80), {
    code: 'terminal_quota_global',
  })
  rustExited(h, a)
  rustExited(h, b)
  await sleep(10)
  const c = await h.service.create('rc', 'p1', 24, 80)
  assert.equal(c.terminal.status, 'running')
  // TS active 已排除 exited；Rust 表含 exited-not-closed → 必须看到回收 close。
  assert.equal(h.sys.calls.filter(([m]) => m === 'terminal.close').length, 2)
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

// ---------------- 10. closeProject（项目删除前的终端回收） ----------------

test('closeProject：全部终端收敛 closed、Rust close 各一次、索引清空', async () => {
  const h = harness()
  const a = await h.service.create('ra', 'p1', 24, 80)
  const b = await h.service.create('rb', 'p1', 24, 80)
  await h.service.closeProject('p1')
  const closes = h.sys.calls
    .filter(([m]) => m === 'terminal.close')
    .map(([, p]) => p.terminalId)
  assert.deepEqual(
    [...closes].sort(),
    [a.terminal.terminalId, b.terminal.terminalId].sort(),
  )
  assert.deepEqual(h.service.list('p1'), [])
  for (const id of closes) {
    const states = h.events
      .filter((e) => e.type === 'terminal.state' && e.terminalId === id)
      .map((e) => e.status)
    assert.equal(states.at(-1), 'closed')
  }
})

test('closeProject：Rust close 失败 → terminal_cleanup_failed 且记录保留（项目不被删）', async () => {
  const h = harness({ systemBehavior: { closeFail: true } })
  await h.service.create('ra', 'p1', 24, 80)
  await h.service.create('rb', 'p1', 24, 80)
  await assert.rejects(() => h.service.closeProject('p1'), {
    code: 'terminal_cleanup_failed',
  })
  assert.equal(h.service.list('p1').length, 2)
})
