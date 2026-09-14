#!/usr/bin/env node
// 终端纵向切片验证 harness（AGENTS §7 冒烟模式的延伸）：
// 驱动 debug 二进制验证 PTY 启动、分帧、UTF-8、Ctrl+C、resize、回收、幂等、关停。
// 用法：cargo build --manifest-path crates/Cargo.toml && node scripts/terminal-spike.mjs
import { spawn, execFileSync } from 'node:child_process'
import { createInterface } from 'node:readline'
import { setTimeout as delay } from 'node:timers/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const bin = join(root, 'crates/target/debug/reflexion-system-runtime')

const child = spawn(bin, [], { stdio: ['pipe', 'pipe', 'inherit'] })
const rl = createInterface({ input: child.stdout })
let id = 0
const pending = new Map()
const notifications = []
// W2-2：Rust 侧未确认窗口 256 KiB——spike 模拟 TS 消费者，跟踪每终端收到的
// 最大 outputSeq 并定期累计 ack（见下方 ackTimer）。
const lastSeq = new Map()
rl.on('line', (line) => {
  let message
  try {
    message = JSON.parse(line)
  } catch {
    return
  }
  if (message.method === 'system.ready') return
  if (message.id !== undefined && pending.has(message.id)) {
    pending.get(message.id)(message)
    pending.delete(message.id)
    return
  }
  if (message.method === 'terminal.output') {
    lastSeq.set(message.params.terminalId, message.params.outputSeq)
  }
  if (message.method) notifications.push(message)
})

function request(method, params) {
  const requestId = ++id
  child.stdin.write(
    `${JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params })}\n`,
  )
  return new Promise((resolve) => pending.set(requestId, resolve))
}

// W2-2：Rust 输出交付需先 attach 开门控；ack 心跳见上方 lastSeq/ackTimer。
const ackTimer = setInterval(() => {
  for (const [terminalId, seq] of lastSeq) {
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'terminal.ack', params: { terminalId, throughOutputSeq: seq } })}\n`,
    )
  }
}, 100)
ackTimer.unref()

const framesFor = (terminalId) =>
  notifications
    .filter((n) => n.method === 'terminal.output')
    .filter((n) => n.params.terminalId === terminalId)
    .map((n) => Buffer.from(n.params.data, 'base64'))

const seqsFor = (terminalId) =>
  notifications
    .filter((n) => n.method === 'terminal.output')
    .filter((n) => n.params.terminalId === terminalId)
    .map((n) => n.params.outputSeq)

const decode = (terminalId) =>
  Buffer.concat(framesFor(terminalId)).toString('utf8')

const results = []
function check(name, pass, detail = '') {
  results.push({ name, pass, detail })
  console.log(
    `${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`,
  )
}

// 1. spawn
const spawnReply = await request('terminal.spawn', {
  terminalId: 's1',
  cwd: tmpdir(),
  rows: 24,
  cols: 80,
})
check(
  'spawn 返回元数据',
  spawnReply.result?.terminalId === 's1' &&
    typeof spawnReply.result?.generation === 'number',
)
await request('terminal.attach', { terminalId: 's1', consumerId: 'spike' })
await delay(300) // 等 shell 提示符输出

// 2. echo 往返（UTF-8 中文/emoji）
await request('terminal.write', {
  terminalId: 's1',
  data: Buffer.from('echo 终端-OK-✅\r', 'utf8').toString('base64'),
})
await delay(600)
check('UTF-8 中文/emoji 往返', decode('s1').includes('终端-OK-✅'))

// 3. 洪泛：帧上限、seq 连续、吞吐记录；Ctrl+C 后 shell 仍可响应
const before = framesFor('s1').length
const floodStart = Date.now()
await request('terminal.write', {
  terminalId: 's1',
  data: Buffer.from('yes\r', 'utf8').toString('base64'),
})
await delay(3000)
const floodElapsedMs = Date.now() - floodStart
const floodBytes = framesFor('s1')
  .slice(before)
  .reduce((sum, frame) => sum + frame.length, 0)
console.log(
  `flood: frames=${framesFor('s1').length - before} bytes=${floodBytes} rate=${(floodBytes / (floodElapsedMs / 1000) / 1024).toFixed(1)} KiB/s`,
)
await request('terminal.write', {
  terminalId: 's1',
  data: Buffer.from('\x03', 'utf8').toString('base64'),
})
await delay(300)
const flood = framesFor('s1').slice(before)
check('洪泛产生大量帧', flood.length > 50, `frames=${flood.length}`)
check(
  '单帧 ≤16 KiB',
  flood.every((frame) => frame.length <= 16 * 1024),
  `max=${Math.max(...flood.map((frame) => frame.length))}B`,
)
const floodSeqs = seqsFor('s1').slice(before)
check(
  'outputSeq 连续无缺口',
  floodSeqs.every(
    (seq, index) => index === 0 || seq === floodSeqs[index - 1] + 1,
  ),
)
const afterCtrlC = framesFor('s1').length
await request('terminal.write', {
  terminalId: 's1',
  data: Buffer.from('echo ctrlc-survived\r', 'utf8').toString('base64'),
})
await delay(600)
check(
  'Ctrl+C 后 shell 仍可执行命令',
  Buffer.concat(framesFor('s1').slice(afterCtrlC))
    .toString('utf8')
    .includes('ctrlc-survived'),
)

// 4. resize
await request('terminal.resize', { terminalId: 's1', rows: 30, cols: 100 })
await request('terminal.write', {
  terminalId: 's1',
  data: Buffer.from('stty size\r', 'utf8').toString('base64'),
})
await delay(600)
check('resize 生效（stty size = 30 100）', decode('s1').includes('30 100'))

// 5. 回收：后台 sleep 子进程必须随 close 消失
await request('terminal.write', {
  terminalId: 's1',
  data: Buffer.from('sleep 300 & sleep 300\r', 'utf8').toString('base64'),
})
await delay(400)
await request('terminal.close', { terminalId: 's1' })
lastSeq.delete('s1')
await delay(500)
let survivors = ''
try {
  survivors = execFileSync('pgrep', ['-fl', 'sleep 300'], { encoding: 'utf8' })
} catch {
  survivors = ''
}
check(
  'close 后无 sleep 300 残留',
  survivors.trim() === '',
  survivors.trim().slice(0, 120),
)

// 6. 幂等 close
const again = await request('terminal.close', { terminalId: 's1' })
check('重复 close 幂等成功', again.result?.closed === true)

// 7. 双终端并行输出互不串扰
await request('terminal.spawn', {
  terminalId: 'a',
  cwd: tmpdir(),
  rows: 24,
  cols: 80,
})
await request('terminal.attach', { terminalId: 'a', consumerId: 'spike' })
await request('terminal.spawn', {
  terminalId: 'b',
  cwd: tmpdir(),
  rows: 24,
  cols: 80,
})
await request('terminal.attach', { terminalId: 'b', consumerId: 'spike' })
await delay(300)
await request('terminal.write', {
  terminalId: 'a',
  data: Buffer.from('echo AAAA\r').toString('base64'),
})
await request('terminal.write', {
  terminalId: 'b',
  data: Buffer.from('echo BBBB\r').toString('base64'),
})
await delay(600)
check(
  '双终端输出按 terminalId 隔离',
  decode('a').includes('AAAA') &&
    !decode('a').includes('BBBB') &&
    decode('b').includes('BBBB'),
)

// 8. exited 严格后于尾部帧写出（I-1 回归钉）：shell 内先打印尾部标记再
// exit——exited 不得抢在携带 TAILMARKER 的 output 帧之前进入协议流，
// 且标记帧 base64 解码完整。
await request('terminal.spawn', {
  terminalId: 'ord',
  cwd: tmpdir(),
  rows: 24,
  cols: 80,
})
await request('terminal.attach', { terminalId: 'ord', consumerId: 'spike' })
await delay(300) // 等 shell 就绪，避免输入被启动噪声吞掉
await request('terminal.write', {
  terminalId: 'ord',
  data: Buffer.from('echo TAILMARKER-ORD-7c1a; exit\r', 'utf8').toString(
    'base64',
  ),
})
// 有界轮询：等 ord 的 exited 出现（超时 = 交付链断裂，同样必须失败）。
const orderDeadline = Date.now() + 5000
while (
  Date.now() < orderDeadline &&
  !notifications.some(
    (n) =>
      n.method === 'terminal.state' &&
      n.params.terminalId === 'ord' &&
      n.params.status === 'exited',
  )
) {
  await delay(50)
}
const markerFrameIdx = notifications.reduce(
  (last, n, index) =>
    n.method === 'terminal.output' &&
    n.params.terminalId === 'ord' &&
    Buffer.from(n.params.data, 'base64')
      .toString('utf8')
      .includes('TAILMARKER-ORD-7c1a')
      ? index
      : last,
  -1,
)
const exitedIdx = notifications.findIndex(
  (n) =>
    n.method === 'terminal.state' &&
    n.params.terminalId === 'ord' &&
    n.params.status === 'exited',
)
check(
  'exited 严格后于 TAILMARKER 尾部帧（I-1 顺序钉）',
  markerFrameIdx >= 0 &&
    exitedIdx >= 0 &&
    markerFrameIdx < exitedIdx &&
    Buffer.from(notifications[markerFrameIdx].params.data, 'base64')
      .toString('utf8')
      .includes('TAILMARKER-ORD-7c1a'),
  `marker@${markerFrameIdx} exited@${exitedIdx}`,
)
lastSeq.delete('ord')

// 9. busy-shell 输入快速失败不冻主循环（W4-2b）：前台 yes 洪泛时猛灌
// 40×8 KiB 短行输入（macOS cooked canq 只在**完整短行**积压 ~1 KiB 后阻塞
// master write，无换行碎输入被静默丢弃、测不到该路径——见 §9.1 注 2）。
// 硬断言 = 每个请求都有响应且 <2 s（旧实现：同步 write_all 冻结 dispatch
// 主循环，全部超时）；溢出策略二选一都合法：确定性 input_backpressure
// 拒绝，或突发全被有界队列吸收（跨机时序不可承诺必然溢出）。
function timedRequest(method, params, budgetMs = 2000) {
  const started = Date.now()
  let timer
  return Promise.race([
    request(method, params).then((message) => ({ message })),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve({ timeout: true }), budgetMs)
    }),
  ]).then((outcome) => {
    clearTimeout(timer)
    return { ...outcome, ms: Date.now() - started }
  })
}

await request('terminal.spawn', {
  terminalId: 'busy',
  cwd: tmpdir(),
  rows: 24,
  cols: 80,
})
await request('terminal.attach', { terminalId: 'busy', consumerId: 'spike' })
await delay(300)
await request('terminal.write', {
  terminalId: 'busy',
  data: Buffer.from('yes\r', 'utf8').toString('base64'),
})
await delay(500) // 让 yes 真跑进前台并铺满输出
const busyLine = `${'x'.repeat(250)}\r\n`.repeat(32) // ≈8 KiB 完整短行
const busyPayload = Buffer.from(busyLine, 'utf8').toString('base64')
const hammerOutcomes = []
for (let i = 0; i < 40; i++) {
  hammerOutcomes.push(
    await timedRequest('terminal.write', {
      terminalId: 'busy',
      data: busyPayload,
    }),
  )
}
const hammerTimeouts = hammerOutcomes.filter((o) => o.timeout).length
const hammerCodes = hammerOutcomes.map((o) =>
  o.timeout ? 'timeout' : (o.message.error?.data?.code ?? 'ok'),
)
const hammerSlowest = Math.max(...hammerOutcomes.map((o) => o.ms))
console.log(
  `hammer: timeouts=${hammerTimeouts}/40 slowest=${hammerSlowest}ms codes=${[...new Set(hammerCodes)].join(',')}`,
)
const controlOutcomes = []
controlOutcomes.push(
  await timedRequest('terminal.write', {
    terminalId: 'busy',
    data: Buffer.from('echo OK\r', 'utf8').toString('base64'),
  }),
)
controlOutcomes.push(
  await timedRequest('terminal.close', { terminalId: 'busy' }),
)
lastSeq.delete('busy')
controlOutcomes.push(
  await timedRequest('terminal.spawn', {
    terminalId: 'busy2',
    cwd: tmpdir(),
    rows: 24,
    cols: 80,
  }),
)
controlOutcomes.push(
  await timedRequest('terminal.attach', {
    terminalId: 'busy2',
    consumerId: 'spike',
  }),
)
controlOutcomes.push(
  await timedRequest('terminal.write', {
    terminalId: 'busy2',
    data: Buffer.from('echo BUSY2_OK\r', 'utf8').toString('base64'),
  }),
)
controlOutcomes.push(await timedRequest('system.ping', {}))
const controlTimeouts = controlOutcomes.filter((o) => o.timeout).length
const controlSlowest = Math.max(...controlOutcomes.map((o) => o.ms))
const overflowed = hammerCodes.includes('input_backpressure')
// busy2 端到端可用：洪泛压力过后，新终端的 echo 必须能走完整链路回来。
const busy2Started = Date.now()
while (
  Date.now() - busy2Started < 3000 &&
  !decode('busy2').includes('BUSY2_OK')
) {
  await delay(50)
}
const busy2Usable = decode('busy2').includes('BUSY2_OK')
check(
  'busy-shell 输入快速失败不冻主循环（W4-2b）',
  hammerTimeouts === 0 &&
    controlTimeouts === 0 &&
    (overflowed || hammerCodes.every((code) => code === 'ok')) &&
    hammerSlowest < 2000 &&
    controlSlowest < 2000 &&
    busy2Usable,
  `hammerT=${hammerTimeouts} ctrlT=${controlTimeouts} slowest=${controlSlowest}ms overflow=${overflowed} busy2=${busy2Usable}`,
)
await delay(200)

// 10. shutdown 优雅退出（含活跃终端 b 与已退出 ord 的回收）
await request('terminal.write', {
  terminalId: 'b',
  data: Buffer.from('sleep 300 &\r', 'utf8').toString('base64'),
})
await delay(300)
const shutdownStart = Date.now()
child.stdin.write(
  `${JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'system.shutdown' })}\n`,
)
await new Promise((resolve) => child.on('exit', resolve))
const shutdownMs = Date.now() - shutdownStart
check(
  'shutdown 在 2s 预算内收敛（活跃终端+后台任务）',
  shutdownMs < 2000,
  `${shutdownMs}ms`,
)
let survivors2 = ''
try {
  survivors2 = execFileSync('pgrep', ['-fl', 'sleep 300'], { encoding: 'utf8' })
} catch {
  survivors2 = ''
}
check(
  'shutdown 后无受管理 sleep 残留',
  survivors2.trim() === '',
  survivors2.trim().slice(0, 120),
)

const failed = results.filter((r) => !r.pass)
console.log(
  `\nspike summary: ${results.length - failed.length}/${results.length} passed`,
)
process.exit(failed.length === 0 ? 0 : 1)
