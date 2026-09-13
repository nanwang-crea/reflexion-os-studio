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
  if (message.method) notifications.push(message)
})

function request(method, params) {
  const requestId = ++id
  child.stdin.write(
    `${JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params })}\n`,
  )
  return new Promise((resolve) => pending.set(requestId, resolve))
}

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
await request('terminal.spawn', {
  terminalId: 'b',
  cwd: tmpdir(),
  rows: 24,
  cols: 80,
})
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

// 8. shutdown 优雅退出（含活跃终端 s2 的回收）
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
