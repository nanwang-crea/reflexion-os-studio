#!/usr/bin/env node
// W4-1 终端故障矩阵端到端（AGENTS §7 冒烟模式的延伸）：
// 驱动真实链路 node apps/runtime/dist/index.js + debug sidecar，只用前端协议命令
// （terminal.create/attach/write/resize/ack/close/list + project.*）验证故障路径：
// attach 超时僵尸、退出/关闭竞态、并发重复 close、输入去重与乱序自愈、
// sidecar 崩溃代际、exited 额度回收、project.delete 回收、进程清理。
// 用法：pnpm build:packages && cargo build --manifest-path crates/Cargo.toml
//       node scripts/terminal-faults.mjs
import { spawn, execFileSync } from 'node:child_process'
import { createInterface } from 'node:readline'
import { setTimeout as delay } from 'node:timers/promises'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SYSTEM_BIN = join(ROOT, 'crates/target/debug/reflexion-system-runtime')
if (!existsSync(SYSTEM_BIN)) {
  console.error(
    'terminal-faults: Rust binary missing, run cargo build --manifest-path crates/Cargo.toml',
  )
  process.exit(1)
}

// 真实默认值从构建产物读取（与 src/terminal/records.ts DEFAULTS 同源），失败退回字面量。
let ATTACH_TIMEOUT_MS = 10_000
try {
  const records = await import(
    pathToFileURL(join(ROOT, 'apps/runtime/dist/terminal/records.js')).href
  )
  if (typeof records.DEFAULTS?.attachTimeoutMs === 'number') {
    ATTACH_TIMEOUT_MS = records.DEFAULTS.attachTimeoutMs
  }
} catch {
  // dist 不可读时保留默认（仅影响等待窗口，不放松断言）。
}

const startedAt = Date.now()
const dataDir = mkdtempSync(join(tmpdir(), 'reflexion-faults-'))
const wsDir = mkdtempSync(join(dataDir, 'ws-'))
const ws2Dir = mkdtempSync(join(dataDir, 'ws2-'))
const ws3Dir = mkdtempSync(join(dataDir, 'ws3-'))
const markerFile = join(dataDir, 'faults-marker')
const readMarker = () => {
  try {
    return readFileSync(markerFile, 'utf8') === 'X'
  } catch {
    return false
  }
}

const runtime = spawn(
  process.execPath,
  [
    '--disable-warning=ExperimentalWarning',
    join(ROOT, 'apps/runtime/dist/index.js'),
  ],
  {
    env: {
      ...process.env,
      REFLEXION_DATA_DIR: dataDir,
      REFLEXION_SYSTEM_RUNTIME_BIN: SYSTEM_BIN,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  },
)

let idSeq = 0
const pending = new Map()
const events = []
let readyResolve
const readyPromise = new Promise((resolve) => {
  readyResolve = resolve
})
const rl = createInterface({ input: runtime.stdout })
rl.on('line', (line) => {
  let message
  try {
    message = JSON.parse(line)
  } catch {
    return
  }
  if (message.method === 'runtime.ready') {
    readyResolve()
    return
  }
  if (message.method !== undefined && message.id === undefined) {
    events.push(message.params ?? {})
    return
  }
  if (message.id !== undefined && pending.has(message.id)) {
    pending.get(message.id)(message)
    pending.delete(message.id)
  }
})
runtime.stderr.on('data', (chunk) => process.stderr.write(`[runtime] ${chunk}`))

function rpc(method, params) {
  const id = ++idSeq
  runtime.stdin.write(
    `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`,
  )
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      resolve({ error: { message: `timeout: ${method}` } })
    }, 20_000)
    pending.set(id, (message) => {
      clearTimeout(timer)
      resolve(message)
    })
  })
}

async function call(method, params) {
  const message = await rpc(method, params)
  if (message.error) {
    throw new Error(
      `${method}: ${message.error.message} ${JSON.stringify(message.error.data ?? '')}`,
    )
  }
  return message.result
}

const req = (params = {}) => ({ requestId: randomUUID(), ...params })
const b64 = (text) => Buffer.from(text, 'utf8').toString('base64')
const errorCode = (message) => message.error?.data?.code

const writeLine = (projectId, terminalId, inputSeq, text) =>
  call(
    'terminal.write',
    req({ projectId, terminalId, inputSeq, data: b64(text) }),
  )

const stateEventsOf = (terminalId) =>
  events.filter(
    (e) => e.type === 'terminal.state' && e.terminalId === terminalId,
  )
const decodeOutput = (terminalId) =>
  Buffer.concat(
    events
      .filter(
        (e) => e.type === 'terminal.output' && e.terminalId === terminalId,
      )
      .map((e) => Buffer.from(e.data, 'base64')),
  ).toString('utf8')
const outputSeen = (terminalId, needle) =>
  decodeOutput(terminalId).includes(needle)

async function waitForEvent(predicate, timeoutMs) {
  const end = Date.now() + Math.max(0, timeoutMs)
  for (;;) {
    const found = events.find(predicate)
    if (found) return found
    if (Date.now() > end) return null
    await delay(30)
  }
}

async function waitUntil(fn, timeoutMs) {
  const end = Date.now() + Math.max(0, timeoutMs)
  for (;;) {
    if (fn()) return true
    if (Date.now() > end) return false
    await delay(50)
  }
}

async function waitSystemReady(timeoutMs) {
  const end = Date.now() + timeoutMs
  for (;;) {
    const status = await rpc('runtime.get_status', req())
    if (status.result?.systemAvailable === true) return true
    if (Date.now() > end) return false
    await delay(150)
  }
}

// ---- sidecar 子进程发现与硬杀（POSIX 主路径；Windows 分支无验收环境，与 spike 工具链同状态） ----
function findSidecarPids() {
  if (process.platform === 'win32') {
    try {
      const out = execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-Command',
          `Get-CimInstance Win32_Process -Filter "ParentProcessId=${runtime.pid}" | Select-Object -Expand ProcessId`,
        ],
        { encoding: 'utf8' },
      )
      return out
        .split(/\r?\n/)
        .map((line) => Number(line.trim()))
        .filter((n) => Number.isFinite(n) && n > 0)
    } catch {
      return []
    }
  }
  const out = execFileSync('ps', ['-axo', 'pid=,ppid=,comm='], {
    encoding: 'utf8',
  })
  const pids = []
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s*$/.exec(line)
    if (
      m &&
      Number(m[2]) === runtime.pid &&
      /reflexion-system-runtime(\.exe)?$/.test(m[3])
    ) {
      pids.push(Number(m[1]))
    }
  }
  return pids
}

function hardKill(pid) {
  if (process.platform === 'win32') {
    execFileSync('taskkill', ['/PID', String(pid), '/F'])
    return
  }
  process.kill(pid, 'SIGKILL')
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const knownSidecars = new Set()
function refreshSidecarPids() {
  for (const pid of findSidecarPids()) knownSidecars.add(pid)
}

async function newTerminal(projectId) {
  const { terminal } = await call(
    'terminal.create',
    req({ projectId, rows: 24, cols: 80 }),
  )
  return terminal
}

function attach(projectId, terminalId, consumerId) {
  return call('terminal.attach', req({ projectId, terminalId, consumerId }))
}

function closeTerminal(projectId, terminalId) {
  return call('terminal.close', req({ projectId, terminalId }))
}

const results = []
function check(name, pass, detail = '') {
  results.push({ name, pass })
  console.log(
    `${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`,
  )
}

async function step(name, fn) {
  try {
    await fn()
  } catch (error) {
    check(`${name}（未捕获异常）`, false, String(error?.message ?? error))
  }
}

let project2
let project3
const zombie = { terminalId: null, createdAt: 0 }

try {
  await readyPromise
  check('runtime.ready', true)
  check(
    'sidecar 进入 ready（systemAvailable=true）',
    await waitSystemReady(25_000),
  )
  refreshSidecarPids()

  const project = (await call('project.create', req({ folderPath: wsDir })))
    .project
  const P = project.id

  // ---------------- 1. create→attach→echo→ack 闭环 ----------------
  await step('检查1', async () => {
    const t = await newTerminal(P)
    const attached = await attach(P, t.terminalId, 'c1')
    check(
      'create→attach 返回 running + replayedBytes',
      attached.terminal.status === 'running' &&
        typeof attached.replayedBytes === 'number',
      `status=${attached.terminal.status}`,
    )
    const written = await writeLine(P, t.terminalId, 1, 'echo FAULT_OK\r')
    const echoSeen = await waitForEvent(
      (e) =>
        e.type === 'terminal.output' &&
        e.terminalId === t.terminalId &&
        outputSeen(t.terminalId, 'FAULT_OK'),
      5_000,
    )
    const lastSeq = Math.max(
      0,
      ...events
        .filter(
          (e) => e.type === 'terminal.output' && e.terminalId === t.terminalId,
        )
        .map((e) => e.outputSeq),
    )
    const acked = await call(
      'terminal.ack',
      req({
        projectId: P,
        terminalId: t.terminalId,
        throughOutputSeq: lastSeq,
      }),
    )
    check(
      'echo 内容进入解码流且 ack 确认成功（闭环）',
      Boolean(echoSeen) && written.accepted === true && acked.ok === true,
      `lastSeq=${lastSeq}`,
    )
    await closeTerminal(P, t.terminalId)
  })

  // ---------------- 2. attach 超时僵尸保护：早开局（10s 计时与后续检查重叠），检查 7 后断言 ----------------
  await step('检查2-开局', async () => {
    const t = await newTerminal(P)
    zombie.terminalId = t.terminalId
    zombie.createdAt = Date.now()
    check('僵尸终端已创建（不 attach）', t.status === 'running')
  })

  // ---------------- 3. close vs exited 竞态（367c094 回收语义） ----------------
  await step('检查3', async () => {
    const t = await newTerminal(P)
    await attach(P, t.terminalId, 'c3')
    await writeLine(P, t.terminalId, 1, 'exit\r')
    const exited = await waitForEvent(
      (e) =>
        e.type === 'terminal.state' &&
        e.terminalId === t.terminalId &&
        e.status === 'exited',
      5_000,
    )
    check(
      'shell 自然退出 → exited 事件',
      Boolean(exited),
      `exitCode=${exited?.exitCode}`,
    )
    const countAtExit = stateEventsOf(t.terminalId).length
    // exited 后 TS 已自发 Rust close 回收（对用户不可见）；其 closed 回执必须被吞。
    await delay(600)
    check(
      '回收的 Rust closed 回执被吞：exited 后无降级事件',
      stateEventsOf(t.terminalId).length === countAtExit &&
        stateEventsOf(t.terminalId).at(-1)?.status === 'exited',
    )
    const closed = await closeTerminal(P, t.terminalId)
    await delay(400)
    const list = await call('terminal.list', req({ projectId: P }))
    check(
      '用户 close 已回收记录：响应 closed:true、无新 terminal.state 事件、meta 收敛 closed',
      closed.closed === true &&
        stateEventsOf(t.terminalId).length === countAtExit &&
        list.terminals.find((x) => x.terminalId === t.terminalId)?.status ===
          'closed',
    )
  })

  // ---------------- 4. 并发重复 close ----------------
  await step('检查4', async () => {
    const t = await newTerminal(P)
    await attach(P, t.terminalId, 'c4')
    const [a, b] = await Promise.all([
      rpc('terminal.close', req({ projectId: P, terminalId: t.terminalId })),
      rpc('terminal.close', req({ projectId: P, terminalId: t.terminalId })),
    ])
    const closedEvents = stateEventsOf(t.terminalId).filter(
      (e) => e.status === 'closed',
    )
    check(
      '双 close 并发：均返回 closed:true 且仅一条 closed 事件',
      a.result?.closed === true &&
        b.result?.closed === true &&
        closedEvents.length === 1,
      `closedEvents=${closedEvents.length}`,
    )
  })

  // ---------------- 5. 输入去重 + 乱序自愈 ----------------
  await step('检查5', async () => {
    const t = await newTerminal(P)
    await attach(P, t.terminalId, 'c5')
    const markerCmd = `printf %s X >> ${markerFile}\r`
    await writeLine(P, t.terminalId, 1, markerCmd)
    const markerOnce = await waitUntil(readMarker, 3_000)
    check('seq1 到达 shell（marker 恰好 1 字节）', markerOnce)
    const dup = await writeLine(P, t.terminalId, 1, markerCmd)
    await delay(400)
    check(
      '重复 seq1：确认但不重发（marker 仍 1 字节）',
      dup.accepted === true && readMarker(),
    )
    const outOfOrder = await rpc(
      'terminal.write',
      req({
        projectId: P,
        terminalId: t.terminalId,
        inputSeq: 3,
        data: b64('echo SEQ3_LOST\r'),
      }),
    )
    check(
      'seq3 先于 seq2：间隙过期后以稳定码 terminal_input_out_of_order 拒绝',
      errorCode(outOfOrder) === 'terminal_input_out_of_order',
      `error=${JSON.stringify(outOfOrder.error?.data ?? outOfOrder.error?.message)}`,
    )
    const recover = await writeLine(P, t.terminalId, 2, 'echo RECOVERED\r')
    const seen = await waitForEvent(
      (e) =>
        e.type === 'terminal.output' &&
        e.terminalId === t.terminalId &&
        outputSeen(t.terminalId, 'RECOVERED'),
      5_000,
    )
    check(
      'seq2 落地即自愈：RECOVERED 可见且被丢弃的 seq3 从未进入 shell',
      recover.accepted === true &&
        Boolean(seen) &&
        !outputSeen(t.terminalId, 'SEQ3_LOST'),
    )
    await closeTerminal(P, t.terminalId)
  })

  // ---------------- 7. 额度回收：16 个 exited（Rust 表上限）不饿死第 17 个；与僵尸计时窗口重叠 ----------------
  await step('检查7', async () => {
    const loopStart = Date.now()
    let maxExitLatencyMs = 0
    let allExited = true
    for (let i = 1; i <= 16; i += 1) {
      const t = await newTerminal(P)
      await attach(P, t.terminalId, `quota-${i}`)
      const writeAt = Date.now()
      await writeLine(P, t.terminalId, 1, 'exit\r')
      const exited = await waitForEvent(
        (e) =>
          e.type === 'terminal.state' &&
          e.terminalId === t.terminalId &&
          e.status === 'exited',
        2_500,
      )
      if (!exited) allExited = false
      else maxExitLatencyMs = Math.max(maxExitLatencyMs, Date.now() - writeAt)
    }
    check(
      '16 个终端 create+attach+exit 全部自然 exited',
      allExited,
      `maxExit=${maxExitLatencyMs}ms`,
    )
    const probe = await newTerminal(P)
    await attach(P, probe.terminalId, 'probe17')
    const resized = await rpc(
      'terminal.resize',
      req({ projectId: P, terminalId: probe.terminalId, rows: 30, cols: 100 }),
    )
    await writeLine(P, probe.terminalId, 1, 'echo ECHO17\r')
    const echo17 = await waitForEvent(
      (e) =>
        e.type === 'terminal.output' &&
        e.terminalId === probe.terminalId &&
        outputSeen(probe.terminalId, 'ECHO17'),
      8_000,
    )
    check(
      '16 个 exited 后第 17 个 create+attach+echo 仍成功（too_many_terminals 回归钉）',
      Boolean(echo17) && resized.result?.ok === true,
      `elapsed=${Date.now() - loopStart}ms`,
    )
    await closeTerminal(P, probe.terminalId)
  })

  // ---------------- 2b. attach 超时断言（必须在任何 sidecar 硬杀之前） ----------------
  await step('检查2-断言', async () => {
    const failed = await waitForEvent(
      (e) =>
        e.type === 'terminal.state' &&
        e.terminalId === zombie.terminalId &&
        e.status === 'failed',
      zombie.createdAt + ATTACH_TIMEOUT_MS + 5_000 - Date.now(),
    )
    const list = await call('terminal.list', req({ projectId: P }))
    const record = list.terminals.find(
      (x) => x.terminalId === zombie.terminalId,
    )
    check(
      `attach 超时（${ATTACH_TIMEOUT_MS}ms）→ failed 事件 + list=failed`,
      Boolean(failed) &&
        record?.status === 'failed' &&
        String(failed?.errorMessage ?? '').includes('attach timeout'),
      `status=${record?.status} errorMessage=${failed?.errorMessage}`,
    )
    const probe = await newTerminal(P)
    check('僵尸超时后额度已释放：新 create 成功', probe.status === 'running')
    await closeTerminal(P, probe.terminalId)
  })

  // ---------------- 6. sidecar 崩溃 → disconnected + 自动重启 + 新代际可用 ----------------
  await step('检查6', async () => {
    const t = await newTerminal(P)
    await attach(P, t.terminalId, 'c6')
    refreshSidecarPids()
    const victims = findSidecarPids()
    check('找到唯一 sidecar 子进程', victims.length === 1, `pids=${victims}`)
    hardKill(victims[0])
    const disconnected = await waitForEvent(
      (e) =>
        e.type === 'terminal.state' &&
        e.terminalId === t.terminalId &&
        e.status === 'disconnected',
      5_000,
    )
    check(
      '崩溃 → 活动终端收到 disconnected',
      Boolean(disconnected),
      `msg=${disconnected?.errorMessage}`,
    )
    check(
      'SystemRuntimeClient 自动重启回到 ready',
      await waitSystemReady(20_000),
    )
    const fresh = await newTerminal(P)
    await attach(P, fresh.terminalId, 'c6-new')
    await writeLine(P, fresh.terminalId, 1, 'echo NEWGEN_OK\r')
    const newGen = await waitForEvent(
      (e) =>
        e.type === 'terminal.output' &&
        e.terminalId === fresh.terminalId &&
        outputSeen(fresh.terminalId, 'NEWGEN_OK'),
      8_000,
    )
    check(
      '新代际 create+echo 成功',
      Boolean(newGen),
      `generation=${fresh.generation}`,
    )
    const staleWrite = await rpc(
      'terminal.write',
      req({
        projectId: P,
        terminalId: t.terminalId,
        inputSeq: 2,
        data: b64('echo STALE\r'),
      }),
    )
    check(
      '旧终端 write 以 terminal_not_running 拒绝',
      errorCode(staleWrite) === 'terminal_not_running',
      `error=${JSON.stringify(staleWrite.error?.data ?? staleWrite.error?.message)}`,
    )
    check('被杀 sidecar 进程已消失', !pidAlive(victims[0]))
    await closeTerminal(P, fresh.terminalId)
  })

  // ---------------- 8A. project.delete 带活动终端 ----------------
  await step('检查8A', async () => {
    project2 = (await call('project.create', req({ folderPath: ws2Dir })))
      .project
    const t = await newTerminal(project2.id)
    await attach(project2.id, t.terminalId, 'c8')
    const removed = await call(
      'project.delete',
      req({ projectId: project2.id }),
    )
    const list = await call('terminal.list', req({ projectId: project2.id }))
    const recreate = await rpc(
      'terminal.create',
      req({ projectId: project2.id, rows: 24, cols: 80 }),
    )
    check(
      'project.delete 回收活动终端并删除项目；后续 create 报 project_not_found',
      removed.removed === true &&
        list.terminals.length === 0 &&
        errorCode(recreate) === 'project_not_found',
    )
  })

  // ---------------- 8B. sidecar 崩溃后删除含 disconnected 终端的项目（close 跳过 Rust） ----------------
  await step('检查8B', async () => {
    project3 = (await call('project.create', req({ folderPath: ws3Dir })))
      .project
    const t = await newTerminal(project3.id)
    await attach(project3.id, t.terminalId, 'c9')
    refreshSidecarPids()
    const victims = findSidecarPids()
    hardKill(victims[0])
    await waitForEvent(
      (e) =>
        e.type === 'terminal.state' &&
        e.terminalId === t.terminalId &&
        e.status === 'disconnected',
      5_000,
    )
    await waitSystemReady(20_000)
    const removed = await call(
      'project.delete',
      req({ projectId: project3.id }),
    )
    const list = await call('terminal.list', req({ projectId: project3.id }))
    const lastState = stateEventsOf(t.terminalId).at(-1)
    check(
      'disconnected 终端的项目删除成功且状态收敛 closed（本地收敛不触 Rust close）',
      removed.removed === true &&
        list.terminals.length === 0 &&
        lastState?.status === 'closed',
      `lastState=${lastState?.status}`,
    )
  })

  // ---------------- 9. 清理 ----------------
  await step('检查9', async () => {
    await call('runtime.shutdown', req())
    const exited = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), 8_000)
      runtime.once('exit', () => {
        clearTimeout(timer)
        resolve(true)
      })
    })
    refreshSidecarPids()
    check(
      'runtime.shutdown 干净退出且无孤儿 sidecar 进程',
      exited && [...knownSidecars].every((pid) => !pidAlive(pid)),
      `pids=${[...knownSidecars].join(',')}`,
    )
  })
} catch (error) {
  check('矩阵整体（未捕获异常）', false, String(error?.message ?? error))
} finally {
  runtime.kill('SIGKILL')
  for (const pid of knownSidecars) {
    if (pidAlive(pid)) {
      try {
        hardKill(pid)
      } catch {
        // 已消失。
      }
    }
  }
  rmSync(dataDir, { recursive: true, force: true })
}

const failed = results.filter((r) => !r.pass)
console.log(
  `\nterminal-faults summary: ${results.length - failed.length}/${results.length} passed in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`,
)
process.exit(failed.length === 0 ? 0 : 1)
