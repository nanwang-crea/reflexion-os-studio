#!/usr/bin/env node
// W4-2a 终端性能 harness（AGENTS §11 性能纪律 + spec §10 三门槛实测）：
// 驱动真实链路（node apps/runtime/dist/index.js + debug reflexion-system-runtime，
// 独立数据目录，只用前端协议命令），测三个相位：
//   P0 空闲基线（10s）：runtime/sidecar CPU+RSS 采样 + 3×400-delta 流式聊天 p95_base；
//   P1 洪泛（120s，--quick 60s）：两项目 8+8 终端（15×yes 洪泛 + #1 控制终端）、
//     100ms ack 循环、每 5s 聊天、每 2s PING RTT/丢失、每 10s 存活+吞吐、RSS 斜率；
//   P2 长稳（600s，--p2-only）：8 终端（7×yes + #1 交互）、10s PING、30s 聊天、
//     末段 RSS 斜率、有界队列/无卡死。
// 用法：pnpm build:packages && cargo build --manifest-path crates/Cargo.toml
//   node scripts/terminal-perf.mjs --quick      # P0 + 60s P1
//   node scripts/terminal-perf.mjs --p1         # P0 + 120s P1（完整）
//   node scripts/terminal-perf.mjs --p2-only    # 仅 P2（600s）
//   --duration-override <秒>  覆盖 P1 洪泛 / P2 长稳窗口（方法学冒烟用）
// 方法学边界：测到的是 runtime→stdout 跳（含 TS 侧全链 + Rust sidecar），
//   不含 Tauri supervisor→WebView 跳；PING 终端不跑 yes（macOS cooked-mode 下
//   忙碌前台 shell 不回显也不排队执行输入，见报告 §9 方法注记）。
// 清理只杀本脚本跟踪的子进程 pid，绝不宽泛 pkill。
import { spawn, execFileSync } from 'node:child_process'
import { createInterface } from 'node:readline'
import { setTimeout as delay } from 'node:timers/promises'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SYSTEM_BIN = join(ROOT, 'crates/target/debug/reflexion-system-runtime')

// ---------------- CLI ----------------
const argv = process.argv.slice(2)
const has = (flag) => argv.includes(flag)
const MODE = has('--quick')
  ? 'quick'
  : has('--p1')
    ? 'p1'
    : has('--p2-only')
      ? 'p2'
      : null
const overrideIdx = argv.indexOf('--duration-override')
const OVERRIDE_SEC = overrideIdx >= 0 ? Number(argv[overrideIdx + 1]) : null
const badOverride =
  overrideIdx >= 0 && !(Number.isFinite(OVERRIDE_SEC) && OVERRIDE_SEC > 0)
if (!MODE || badOverride) {
  console.error(
    'usage: terminal-perf.mjs --quick | --p1 | --p2-only [--duration-override <sec>]',
  )
  process.exit(2)
}

// ---------------- 阈值与常量（spec §10 门槛，禁止放宽） ----------------
const P0_IDLE_MS = 10_000
const PS_SAMPLES = 4
const PS_SAMPLE_INTERVAL_MS = 2_500
const DELTAS_PER_MSG = 400
const MOCK_DELTA_INTERVAL_MS = 3
const LAT_P95_LIMIT_MS = 100
const LAT_INCR_LIMIT_MS = 50
const RTT_P95_LIMIT_MS = 300
const THROUGHPUT_LIMIT_BPS = 1.1 * 1024 * 1024
const RSS_SLOPE_LIMIT_MIB_PER_MIN = 1
const IDLE_CPU_LIMIT_PCT = 5
const ACK_INTERVAL_MS = 100
const CHAT_INTERVAL_MS = 5_000
const PING_INTERVAL_MS = 2_000
const LIVE_INTERVAL_MS = 10_000
const RSS_INTERVAL_MS = 5_000
const RSS_FIT_WINDOW_MS = 45_000
const P2_CHAT_INTERVAL_MS = 30_000
const P2_PING_INTERVAL_MS = 10_000
const P2_LIVE_INTERVAL_MS = 30_000
const P2_RSS_INTERVAL_MS = 10_000
const P2_RSS_FIT_WINDOW_MS = 120_000
const METRICS_QUEUED_LIMIT_BYTES = 300 * 1024 // 256KiB 窗口 + 16KiB 帧 + 余量
const FLOOD_MS = { quick: 60_000, p1: 120_000 }
const P2_MS_DEFAULT = 600_000

if (!existsSync(SYSTEM_BIN)) {
  console.error(
    'terminal-perf: Rust binary missing, run cargo build --manifest-path crates/Cargo.toml',
  )
  process.exit(1)
}

// ---------------- mock provider（~400 deltas/回复，无节流洪泛） ----------------
function startMockProvider() {
  const server = createServer((request, response) => {
    if (
      request.method !== 'POST' ||
      !request.url.endsWith('/chat/completions')
    ) {
      response.writeHead(404)
      response.end()
      return
    }
    let body = ''
    request.on('data', (chunk) => {
      body += chunk
    })
    request.on('end', () => {
      let parsed
      try {
        parsed = JSON.parse(body)
      } catch {
        response.writeHead(400)
        response.end()
        return
      }
      if (parsed.model !== 'perf-model') {
        response.writeHead(404)
        response.end('unknown model')
        return
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      let i = 0
      const tick = () => {
        if (i < DELTAS_PER_MSG) {
          response.write(
            `data: ${JSON.stringify({ choices: [{ delta: { content: 'x' } }] })}\n\n`,
          )
          i += 1
          setTimeout(tick, MOCK_DELTA_INTERVAL_MS).unref()
          return
        }
        response.write(
          `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`,
        )
        response.write('data: [DONE]\n\n')
        response.end()
      }
      tick()
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server))
  })
}

// ---------------- 工具 ----------------
const percentile = (values, q) => {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * q) - 1),
  )
  return sorted[idx]
}
const round1 = (n) => (n === null ? null : Math.round(n * 10) / 10)
const round3 = (n) => (n === null ? null : Math.round(n * 1000) / 1000)
/** {n,min,p50,p95,max}（毫秒，一位小数）。 */
function stats(values) {
  if (values.length === 0) return null
  return {
    n: values.length,
    min: round1(Math.min(...values)),
    p50: round1(percentile(values, 0.5)),
    p95: round1(percentile(values, 0.95)),
    max: round1(Math.max(...values)),
  }
}

/** ps 采样（macOS/Linux 同格式）；进程消失返回 null。time 为累计 CPU 秒。 */
function psSample(pid) {
  try {
    const out = execFileSync(
      'ps',
      ['-o', '%cpu=,rss=,time=', '-p', String(pid)],
      {
        encoding: 'utf8',
      },
    )
    const m = /\s*([\d.]+)\s+(\d+)\s+([\d:.-]+)\s*/.exec(out)
    if (!m) return null
    return {
      cpuPct: Number(m[1]),
      rssKib: Number(m[2]),
      cpuSec: parseCpuTime(m[3]),
    }
  } catch {
    return null
  }
}

/** `ps time=` 格式 [dd-][hh:]mm:ss(.cc) → 秒。 */
function parseCpuTime(text) {
  let rest = text
  let days = 0
  if (rest.includes('-')) {
    const [d, r] = rest.split('-')
    days = Number(d)
    rest = r
  }
  const parts = rest.split(':').map(Number)
  if (parts.length === 3)
    return days * 86400 + parts[0] * 3600 + parts[1] * 60 + parts[2]
  if (parts.length === 2) return days * 86400 + parts[0] * 60 + parts[1]
  return days * 86400 + parts[0]
}

/** 末段线性拟合斜率（MiB/min）；样本不足时退回全窗口。 */
function rssSlopeMiBPerMin(samples, windowMs) {
  if (samples.length < 2) return null
  const end = samples[samples.length - 1].t
  let window = samples.filter((s) => s.t >= end - windowMs)
  if (window.length < 3) window = samples
  const t0 = window[0].t
  const n = window.length
  let sx = 0
  let sy = 0
  let sxy = 0
  let sxx = 0
  for (const s of window) {
    const x = (s.t - t0) / 1000
    const y = s.rssKib / 1024
    sx += x
    sy += y
    sxy += x * y
    sxx += x * x
  }
  const denom = n * sxx - sx * sx
  if (denom === 0) return 0
  return ((n * sxy - sx * sy) / denom) * 60
}

// ---------------- runtime 栈（P0/P1 共享，P2 复用 bootStack） ----------------
class Stack {
  constructor(label) {
    this.label = label
    this.idSeq = 0
    this.pending = new Map()
    this.eventListeners = new Set()
    this.outputJsonBytes = 0
    this.metricsLines = 0
    this.metricsMaxQueued = 0
    this.metricsMaxPeak = 0
    this.metricsPerTerminal = new Map()
    this.knownSidecars = new Set()
    this.trackedYes = new Set()
    this.dataDir = mkdtempSync(join(tmpdir(), `reflexion-perf-${label}-`))
    this.exited = false
    this.exitPromise = null
  }

  async boot() {
    this.runtime = spawn(
      process.execPath,
      [
        '--disable-warning=ExperimentalWarning',
        join(ROOT, 'apps/runtime/dist/index.js'),
      ],
      {
        env: {
          ...process.env,
          REFLEXION_DATA_DIR: this.dataDir,
          REFLEXION_SYSTEM_RUNTIME_BIN: SYSTEM_BIN,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    )
    this.exitPromise = new Promise((resolve) =>
      this.runtime.once('exit', (code) => {
        this.exited = true
        resolve(code)
      }),
    )
    const rl = createInterface({ input: this.runtime.stdout })
    rl.on('line', (line) => this.onLine(line))
    let stderrCarry = ''
    this.runtime.stderr.on('data', (chunk) => {
      const text = stderrCarry + chunk.toString('utf8')
      const lines = text.split('\n')
      stderrCarry = lines.pop() ?? ''
      for (const line of lines) this.onStderrLine(line)
    })
    await this.readyPromise
  }

  onLine(line) {
    let message
    try {
      message = JSON.parse(line)
    } catch {
      return
    }
    const receivedAt = Date.now()
    if (message.method === 'runtime.ready') {
      this.readyResolve?.()
      return
    }
    if (message.method !== undefined && message.id === undefined) {
      if (message.method === 'terminal.output') {
        this.outputJsonBytes += line.length + 1
      }
      for (const listener of this.eventListeners) {
        try {
          listener(message.params ?? {}, receivedAt)
        } catch {
          // 监听器异常不得打死协议读取。
        }
      }
      return
    }
    if (message.id !== undefined && this.pending.has(message.id)) {
      this.pending.get(message.id)(message)
      this.pending.delete(message.id)
    }
  }

  onStderrLine(line) {
    // egress 指标行由 TS 回传泵写 runtime stderr（非 sidecar 自身）。
    const m =
      /\[terminal-metrics\] (\S+) queued=(\d+) peak=(\d+) emitted=(\d+)/.exec(
        line,
      )
    if (!m) return
    this.metricsLines += 1
    const queued = Number(m[2])
    const peak = Number(m[3])
    this.metricsMaxQueued = Math.max(this.metricsMaxQueued, queued)
    this.metricsMaxPeak = Math.max(this.metricsMaxPeak, peak)
    const seen = this.metricsPerTerminal.get(m[1]) ?? 0
    this.metricsPerTerminal.set(m[1], Math.max(seen, peak))
  }

  rpc(method, params, timeoutMs = 20_000) {
    const id = ++this.idSeq
    this.runtime.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`,
    )
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        resolve({ error: { message: `timeout: ${method}` } })
      }, timeoutMs)
      this.pending.set(id, (message) => {
        clearTimeout(timer)
        resolve(message)
      })
    })
  }

  async call(method, params, timeoutMs = 20_000) {
    const message = await this.rpc(method, params, timeoutMs)
    if (message.error) {
      throw new Error(
        `${method}: ${message.error.message} ${JSON.stringify(message.error.data ?? '')}`,
      )
    }
    return message.result
  }

  async waitSystemReady(timeoutMs = 25_000) {
    const end = Date.now() + timeoutMs
    for (;;) {
      const status = await this.rpc('runtime.get_status', this.req())
      if (status.result?.systemAvailable === true) return true
      if (Date.now() > end) return false
      await delay(150)
    }
  }

  req(params = {}) {
    return { requestId: randomUUID(), ...params }
  }

  // ---- sidecar 子进程发现（模式同 terminal-faults） ----
  findSidecarPids() {
    if (!this.runtime?.pid) return []
    const out = execFileSync('ps', ['-axo', 'pid=,ppid=,comm='], {
      encoding: 'utf8',
    })
    const lines = out.split('\n')
    const pids = []
    for (const line of lines) {
      const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s*$/.exec(line)
      if (
        m &&
        Number(m[2]) === this.runtime.pid &&
        /reflexion-system-runtime(\.exe)?$/.test(m[3])
      ) {
        pids.push(Number(m[1]))
      }
    }
    return pids
  }

  /** 记录我们拉起的 yes（sidecar→zsh→yes 两级子进程），清理时精确核验。 */
  trackGrandchildren() {
    const out = execFileSync('ps', ['-axo', 'pid=,ppid=,comm='], {
      encoding: 'utf8',
    })
    const lines = out.split('\n')
    const parsed = []
    for (const line of lines) {
      const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s*$/.exec(line)
      if (m) parsed.push([Number(m[1]), Number(m[2]), m[3]])
    }
    const shells = new Set(
      parsed
        .filter(([, ppid]) => this.knownSidecars.has(ppid))
        .map(([pid]) => pid),
    )
    for (const [pid, ppid, comm] of parsed) {
      if (shells.has(ppid) && /(^|\/)yes(\.exe)?$/.test(comm)) {
        this.trackedYes.add(pid)
      }
    }
  }

  refreshSidecarPids() {
    for (const pid of this.findSidecarPids()) this.knownSidecars.add(pid)
  }

  /** 只杀跟踪过的 pid：TERM → 等待 → SIGKILL；绝不按名字宽泛匹配。 */
  async shutdown() {
    const notes = []
    if (!this.exited) {
      const shutdownCall = this.rpc('runtime.shutdown', this.req(), 15_000)
      await shutdownCall
      const exited = await Promise.race([
        this.exitPromise.then(() => true),
        delay(8_000).then(() => false),
      ])
      if (!exited) {
        notes.push('runtime 未在 8s 内退出，SIGKILL')
        this.killPid(this.runtime.pid)
      }
    }
    for (const pid of this.knownSidecars) {
      if (this.pidAlive(pid)) {
        notes.push(`sidecar ${pid} 未随 runtime 退出，TERM`)
        this.killPid(pid)
      }
    }
    await delay(500)
    for (const pid of this.knownSidecars) {
      if (this.pidAlive(pid)) this.killPid(pid, 'SIGKILL')
    }
    for (const pid of this.trackedYes) {
      if (this.pidAlive(pid)) {
        notes.push(`yes ${pid} 残留，TERM`)
        this.killPid(pid)
      }
    }
    await delay(500)
    for (const pid of this.trackedYes) {
      if (this.pidAlive(pid)) this.killPid(pid, 'SIGKILL')
    }
    const orphans = [...this.knownSidecars, ...this.trackedYes].filter((pid) =>
      this.pidAlive(pid),
    )
    if (orphans.length > 0) notes.push(`无法收割: ${orphans.join(',')}`)
    rmSync(this.dataDir, { recursive: true, force: true })
    return { clean: orphans.length === 0, notes }
  }

  pidAlive(pid) {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }

  killPid(pid, signal = 'SIGTERM') {
    try {
      process.kill(pid, signal)
    } catch {
      // 已消失。
    }
  }
}

// ready 握手要在 boot 前挂上
function attachReady(stack) {
  stack.readyPromise = new Promise((resolve) => {
    stack.readyResolve = resolve
  })
}

async function bootStack(label, mockBaseUrl) {
  const stack = new Stack(label)
  attachReady(stack)
  await stack.boot()
  await Promise.race([
    stack.readyPromise,
    delay(20_000).then(() => {
      throw new Error(`[${label}] runtime.ready timeout (20s)`)
    }),
  ])
  console.log(`[${label}] runtime.ready`)
  if (!(await stack.waitSystemReady())) {
    throw new Error(`[${label}] sidecar 未进入 ready（systemAvailable!=true）`)
  }
  stack.refreshSidecarPids()
  console.log(`[${label}] sidecar ready (pids=${[...stack.knownSidecars]})`)
  await stack.call(
    'provider.configure',
    stack.req({
      name: 'perf-mock',
      baseUrl: mockBaseUrl,
      models: ['perf-model'],
      secret: 'sk-perf',
      enabled: true,
    }),
  )
  return stack
}

// ---------------- 聊天测量 ----------------
async function chatMessage(stack, sessionId, timeoutMs = 30_000) {
  const send = await stack.call(
    'message.send',
    stack.req({ sessionId, content: 'perf-probe' }),
  )
  const { runId } = send
  const latencies = []
  let done = null
  const listener = (event, receivedAt) => {
    if (event.runId !== runId) return
    if (event.type === 'message.delta') {
      const occurredAt = Date.parse(event.occurredAt)
      latencies.push(receivedAt - occurredAt)
    } else if (event.type === 'run.completed') {
      done = 'completed'
    } else if (event.type === 'run.failed' || event.type === 'run.cancelled') {
      done = event.type
    }
  }
  stack.eventListeners.add(listener)
  try {
    const end = Date.now() + timeoutMs
    while (done === null && Date.now() < end) await delay(30)
  } finally {
    stack.eventListeners.delete(listener)
  }
  return { done, latencies }
}

// ---------------- 终端控制 ----------------
async function makeTerminal(stack, projectId, consumerId) {
  const { terminal } = await stack.call(
    'terminal.create',
    stack.req({ projectId, rows: 24, cols: 80 }),
  )
  await stack.call(
    'terminal.attach',
    stack.req({ projectId, terminalId: terminal.terminalId, consumerId }),
  )
  return {
    label: consumerId,
    terminalId: terminal.terminalId,
    projectId,
    maxSeq: -1,
    ackedThrough: -1,
    rawBytes: 0,
    events: 0,
    nextInputSeq: 1,
  }
}

function startOutputCollector(stack, terms) {
  const byId = new Map(terms.map((term) => [term.terminalId, term]))
  const listener = (event) => {
    if (event.type !== 'terminal.output') return
    const term = byId.get(event.terminalId)
    if (!term) return
    term.maxSeq = Math.max(term.maxSeq, event.outputSeq)
    const bytes = Buffer.from(event.data, 'base64')
    term.rawBytes += bytes.length
    term.events += 1
    const sink = term.outputSink
    if (sink) sink(bytes.toString('latin1'))
  }
  stack.eventListeners.add(listener)
  return () => stack.eventListeners.delete(listener)
}

function startAckLoop(stack, terms, stopFlag) {
  const loop = async () => {
    while (!stopFlag.stop) {
      for (const term of terms) {
        if (term.maxSeq > term.ackedThrough) {
          term.ackedThrough = term.maxSeq
          void stack.rpc(
            'terminal.ack',
            stack.req({
              projectId: term.projectId,
              terminalId: term.terminalId,
              throughOutputSeq: term.ackedThrough,
            }),
            8_000,
          )
        }
      }
      await delay(ACK_INTERVAL_MS)
    }
  }
  void loop()
}

async function writeLine(stack, term, text) {
  return stack.call(
    'terminal.write',
    stack.req({
      projectId: term.projectId,
      terminalId: term.terminalId,
      inputSeq: term.nextInputSeq++,
      data: Buffer.from(text, 'utf8').toString('base64'),
    }),
  )
}

// ---------------- PING 监视（token=PING_n_X：输出行含、提交回显行不含） ----------
function makePingWatcher(stack, term) {
  const outstanding = new Map()
  const rtts = []
  const rttLog = []
  const writeRpcMs = []
  let tail = ''
  let issued = 0
  const send = async () => {
    issued += 1
    const n = issued
    const t0 = Date.now()
    outstanding.set(n, { t0, token: `PING_${n}_X` })
    // $((n)) 使提交行回显不含字面 token，只有执行输出行才命中。
    await writeLine(stack, term, `echo PING_$(( ${n} ))_X\r`)
    writeRpcMs.push(Date.now() - t0)
  }
  term.outputSink = (chunk) => {
    if (outstanding.size === 0) return
    const combined = tail + chunk
    for (const [n, entry] of [...outstanding]) {
      if (combined.includes(entry.token)) {
        const rtt = Date.now() - entry.t0
        rtts.push(rtt)
        rttLog.push({ n, t0: entry.t0, rtt })
        outstanding.delete(n)
      }
    }
    tail = combined.slice(-64)
  }
  const drain = async (timeoutMs) => {
    const end = Date.now() + timeoutMs
    while (outstanding.size > 0 && Date.now() < end) await delay(100)
  }
  return {
    send,
    drain,
    rtts,
    rttLog,
    writeRpcMs,
    outstanding,
    get issued() {
      return issued
    },
  }
}

// ---------------- P0 空闲基线 ----------------
async function phaseP0(stack, ctx) {
  const t0 = Date.now()
  console.log(`[P0] 空闲采样 ${P0_IDLE_MS / 1000}s（ack 循环运行，其余空闲）`)
  const stopFlag = { stop: false }
  startAckLoop(stack, [ctx.p0term], stopFlag)
  const cpuMax = { runtime: 0, sidecar: 0 }
  const psCpuLifetime = { runtime: 0, sidecar: 0 }
  const rssMax = { runtime: 0, sidecar: 0 }
  const sidecarPid = [...stack.knownSidecars][0]
  let prev = { runtime: null, sidecar: null }
  for (let i = 0; i < PS_SAMPLES; i += 1) {
    await delay(i === 0 ? 0 : PS_SAMPLE_INTERVAL_MS)
    const a = psSample(stack.runtime.pid)
    const b = sidecarPid ? psSample(sidecarPid) : null
    if (a) {
      psCpuLifetime.runtime = Math.max(psCpuLifetime.runtime, a.cpuPct)
      rssMax.runtime = Math.max(rssMax.runtime, a.rssKib)
      if (prev.runtime) {
        const windowSec = (Date.now() - prev.runtime.t) / 1000
        cpuMax.runtime = Math.max(
          cpuMax.runtime,
          ((a.cpuSec - prev.runtime.cpuSec) / windowSec) * 100,
        )
      }
      prev.runtime = { cpuSec: a.cpuSec, t: Date.now() }
    }
    if (b) {
      psCpuLifetime.sidecar = Math.max(psCpuLifetime.sidecar, b.cpuPct)
      rssMax.sidecar = Math.max(rssMax.sidecar, b.rssKib)
      if (prev.sidecar) {
        const windowSec = (Date.now() - prev.sidecar.t) / 1000
        cpuMax.sidecar = Math.max(
          cpuMax.sidecar,
          ((b.cpuSec - prev.sidecar.cpuSec) / windowSec) * 100,
        )
      }
      prev.sidecar = { cpuSec: b.cpuSec, t: Date.now() }
    }
  }
  stopFlag.stop = true
  console.log(`[P0] 聊天基线：3 条 ${DELTAS_PER_MSG}-delta 流式消息`)
  const latencies = []
  const failures = []
  for (let i = 0; i < 3; i += 1) {
    const { done, latencies: msgLat } = await chatMessage(stack, ctx.sessionId)
    if (done !== 'completed') failures.push(`msg${i + 1}:${done}`)
    latencies.push(...msgLat)
  }
  const p95Base = percentile(latencies, 0.95)
  const pass =
    failures.length === 0 &&
    latencies.length >= 3 * (DELTAS_PER_MSG - 50) &&
    p95Base !== null &&
    p95Base <= LAT_P95_LIMIT_MS &&
    cpuMax.runtime < IDLE_CPU_LIMIT_PCT &&
    cpuMax.sidecar < IDLE_CPU_LIMIT_PCT
  const summary = {
    phase: 'P0',
    pass,
    seconds: round1((Date.now() - t0) / 1000),
    idleCpuWindowMaxPct: {
      runtime: round1(cpuMax.runtime),
      sidecar: round1(cpuMax.sidecar),
    },
    idleCpuLifetimePsPct: {
      runtime: round1(psCpuLifetime.runtime),
      sidecar: round1(psCpuLifetime.sidecar),
    },
    idleRssMaxMiB: {
      runtime: round1(rssMax.runtime / 1024),
      sidecar: round1(rssMax.sidecar / 1024),
    },
    chatDeltaSamples: latencies.length,
    p95BaseMs: round1(p95Base),
    chatFailures: failures,
  }
  console.log(
    `[P0] idle window cpu max runtime=${summary.idleCpuWindowMaxPct.runtime}% sidecar=${summary.idleCpuWindowMaxPct.sidecar}% (ps 寿命均值 ${summary.idleCpuLifetimePsPct.runtime}/${summary.idleCpuLifetimePsPct.sidecar}%) | rss max runtime=${summary.idleRssMaxMiB.runtime}MiB sidecar=${summary.idleRssMaxMiB.sidecar}MiB | p95_base=${summary.p95BaseMs}ms (n=${latencies.length})`,
  )
  return { pass, summary, latencies }
}

// ---------------- P1 洪泛 ----------------
async function phaseP1(stack, ctx, floodMs) {
  const t0 = Date.now()
  const bytesBase = stack.outputJsonBytes
  // P0 终端关闭，腾出 16 活动额度给 8+8。
  await stack.call(
    'terminal.close',
    stack.req({ projectId: ctx.projectId, terminalId: ctx.p0term.terminalId }),
  )
  const projectA = (
    await stack.call('project.create', stack.req({ folderPath: ctx.wsA }))
  ).project
  const projectB = (
    await stack.call('project.create', stack.req({ folderPath: ctx.wsB }))
  ).project
  const terms = []
  for (const [label, projectId] of [
    ['A', projectA.id],
    ['B', projectB.id],
  ]) {
    for (let i = 0; i < 8; i += 1) {
      terms.push(await makeTerminal(stack, projectId, `p1-${label}${i}`))
    }
  }
  const control = terms[0] // A1：控制终端（保持提示符，跑 PING）
  const flooded = terms.slice(1) // 15×yes：洪泛源（macOS 忙 shell 不吃输入，见方法注记）
  const stopFlag = { stop: false }
  const stopOutput = startOutputCollector(stack, terms)
  startAckLoop(stack, terms, stopFlag)
  for (const term of flooded) await writeLine(stack, term, 'yes\r')
  stack.trackGrandchildren()
  const ping = makePingWatcher(stack, control)

  const chatLatencies = []
  const chatRuns = { completed: 0, failed: 0 }
  const liveFailures = []
  const throughputWindows = []
  const rssSamples = []
  let lastOutputBytes = stack.outputJsonBytes
  let snapshot = new Map(terms.map((term) => [term.terminalId, term.rawBytes]))
  const floodEnd = Date.now() + floodMs

  const endAt = () => Math.min(floodEnd, Date.now())
  const chatLoop = (async () => {
    while (!stopFlag.stop && Date.now() < floodEnd) {
      const started = Date.now()
      const { done, latencies } = await chatMessage(stack, ctx.sessionId)
      if (done === 'completed') chatRuns.completed += 1
      else chatRuns.failed += 1
      chatLatencies.push(...latencies)
      const wait = CHAT_INTERVAL_MS - (Date.now() - started)
      if (wait > 0)
        await delay(Math.min(wait, Math.max(0, floodEnd - Date.now())))
    }
  })()
  const pingLoop = (async () => {
    while (!stopFlag.stop && Date.now() < floodEnd - PING_INTERVAL_MS) {
      const started = Date.now()
      try {
        await ping.send()
      } catch (error) {
        liveFailures.push(`ping-write: ${error.message}`)
      }
      const wait = PING_INTERVAL_MS - (Date.now() - started)
      if (wait > 0) await delay(wait)
    }
  })()
  let pingDbgIdx = 0
  const pingDebug = setInterval(() => {
    for (; pingDbgIdx < ping.rttLog.length; pingDbgIdx += 1) {
      const entry = ping.rttLog[pingDbgIdx]
      if (entry.rtt > RTT_P95_LIMIT_MS) {
        console.log(
          `[P1] ping#${entry.n} rtt=${entry.rtt}ms（发出于 +${((entry.t0 - t0) / 1000).toFixed(1)}s）`,
        )
      }
    }
  }, 1_000)
  const liveLoop = (async () => {
    while (!stopFlag.stop && Date.now() < floodEnd) {
      await delay(LIVE_INTERVAL_MS)
      if (stopFlag.stop) break
      const now = endAt()
      const bytes = stack.outputJsonBytes
      const windowMs = Math.max(1, now - (throughputWindows.at(-1)?.t ?? t0))
      throughputWindows.push({
        t: now,
        bps: ((bytes - lastOutputBytes) / windowMs) * 1000,
      })
      lastOutputBytes = bytes
      for (const term of flooded) {
        const prev = snapshot.get(term.terminalId)
        if (term.rawBytes <= prev) {
          liveFailures.push(`starved ${term.label} (+${term.rawBytes - prev}B)`)
        }
      }
      snapshot = new Map(terms.map((term) => [term.terminalId, term.rawBytes]))
    }
  })()
  const rssLoop = (async () => {
    const sidecarPid = [...stack.knownSidecars][0]
    while (!stopFlag.stop && Date.now() < floodEnd) {
      const sample = psSample(stack.runtime.pid)
      const sampleSidecar = sidecarPid ? psSample(sidecarPid) : null
      if (sample && sampleSidecar) {
        rssSamples.push({
          t: Date.now(),
          runtimeKib: sample.rssKib,
          sidecarKib: sampleSidecar.rssKib,
        })
      }
      await delay(RSS_INTERVAL_MS)
    }
  })()

  console.log(
    `[P1] 洪泛 ${floodMs / 1000}s：16 终端（15×yes + 控制终端）、5s 聊天、2s PING、10s 存活/吞吐、5s RSS`,
  )
  while (Date.now() < floodEnd && !stopFlag.stop) await delay(500)
  stopFlag.stop = true
  await Promise.all([chatLoop, pingLoop, liveLoop, rssLoop])
  clearInterval(pingDebug)
  await ping.drain(10_000)
  const losses = [...ping.outstanding.keys()]
  stopOutput()

  const elapsed = Date.now() - t0
  console.log(
    `[P1] rss series (MiB): ${rssSamples
      .map(
        (s) =>
          `${((s.t - t0) / 1000).toFixed(0)}s:${(s.runtimeKib / 1024).toFixed(1)}/${(s.sidecarKib / 1024).toFixed(1)}`,
      )
      .join(' ')}`,
  )
  const totalBps = ((stack.outputJsonBytes - bytesBase) / elapsed) * 1000
  const p95Flood = percentile(chatLatencies, 0.95)
  const p95Rtt = percentile(ping.rtts, 0.95)
  const rttStats = stats(ping.rtts)
  const rpcStats = stats(ping.writeRpcMs)
  const chatStats = stats(chatLatencies)
  const slopeRuntime = rssSlopeMiBPerMin(
    rssSamples.map((s) => ({ t: s.t, rssKib: s.runtimeKib })),
    RSS_FIT_WINDOW_MS,
  )
  const slopeSidecar = rssSlopeMiBPerMin(
    rssSamples.map((s) => ({ t: s.t, rssKib: s.sidecarKib })),
    RSS_FIT_WINDOW_MS,
  )
  const incr =
    p95Flood !== null && ctx.p95Base !== null ? p95Flood - ctx.p95Base : null
  const expectedPings = Math.max(
    1,
    Math.floor((floodMs - PING_INTERVAL_MS) / PING_INTERVAL_MS),
  )
  const minChat = Math.max(1, Math.floor(floodMs / 10_000))
  const pass =
    p95Flood !== null &&
    p95Flood <= LAT_P95_LIMIT_MS &&
    incr !== null &&
    incr <= LAT_INCR_LIMIT_MS &&
    chatLatencies.length >= minChat * 300 &&
    chatRuns.failed === 0 &&
    p95Rtt !== null &&
    p95Rtt <= RTT_P95_LIMIT_MS &&
    losses.length === 0 &&
    ping.issued >= expectedPings * 0.8 &&
    liveFailures.length === 0 &&
    totalBps <= THROUGHPUT_LIMIT_BPS &&
    slopeRuntime !== null &&
    slopeRuntime < RSS_SLOPE_LIMIT_MIB_PER_MIN &&
    slopeSidecar !== null &&
    slopeSidecar < RSS_SLOPE_LIMIT_MIB_PER_MIN
  const metricsGap = stack.metricsLines === 0
  const summary = {
    phase: 'P1',
    pass,
    seconds: round1(elapsed / 1000),
    p95FloodMs: round1(p95Flood),
    p95BaseMs: round1(ctx.p95Base),
    incrMs: round1(incr),
    chatDeltaSamples: chatLatencies.length,
    chatDeltaStatsMs: chatStats,
    rssStartMiB: round1((rssSamples[0]?.runtimeKib ?? 0) / 1024),
    rssEndMiB: round1((rssSamples.at(-1)?.runtimeKib ?? 0) / 1024),
    chatRuns,
    controlPingIssued: ping.issued,
    controlPingRttP95Ms: round1(p95Rtt),
    controlPingRttStatsMs: rttStats,
    controlWriteRpcStatsMs: rpcStats,
    controlPingLosses: losses,
    starveFailures: liveFailures.slice(0, 8),
    throughputMiBps: round3(totalBps / (1024 * 1024)),
    throughputMaxWindowMiBps: round3(
      Math.max(0, ...throughputWindows.map((w) => w.bps)) / (1024 * 1024),
    ),
    rssSlopeMiBPerMin: {
      runtime: round3(slopeRuntime),
      sidecar: round3(slopeSidecar),
    },
    egressMetrics: metricsGap
      ? 'ABSENT（方法学缺口：未观测到 [terminal-metrics] 行）'
      : {
          lines: stack.metricsLines,
          maxQueuedKib: round1(stack.metricsMaxQueued / 1024),
          maxPeakKib: round1(stack.metricsMaxPeak / 1024),
        },
  }
  console.log(
    `[P1] p95_flood=${summary.p95FloodMs}ms (base ${summary.p95BaseMs}, +${summary.incrMs}) | ping p95=${summary.controlPingRttP95Ms}ms loss=${losses.length} | 吞吐=${summary.throughputMiBps}MiB/s max10s=${summary.throughputMaxWindowMiBps}MiB/s | RSS slope rt=${summary.rssSlopeMiBPerMin.runtime} sc=${summary.rssSlopeMiBPerMin.sidecar} MiB/min | starve=${liveFailures.length}`,
  )
  return { pass, summary }
}

// ---------------- P2 长稳 ----------------
async function phaseP2(mockBaseUrl, durationMs) {
  const t0 = Date.now()
  let stack = null
  try {
    stack = await bootStack('p2', mockBaseUrl)
    const ws = mkdtempSync(join(stack.dataDir, 'ws-'))
    const { project } = await stack.call(
      'project.create',
      stack.req({ folderPath: ws }),
    )
    const { session } = await stack.call(
      'session.create',
      stack.req({ projectId: project.id }),
    )
    const terms = []
    for (let i = 0; i < 8; i += 1) {
      terms.push(await makeTerminal(stack, project.id, `p2-${i}`))
    }
    const control = terms[0]
    const flooded = terms.slice(1)
    const stopFlag = { stop: false }
    const stopOutput = startOutputCollector(stack, terms)
    startAckLoop(stack, terms, stopFlag)
    for (const term of flooded) await writeLine(stack, term, 'yes\r')
    stack.trackGrandchildren()
    const ping = makePingWatcher(stack, control)
    const chatLatencies = []
    const chatRuns = { completed: 0, failed: 0 }
    const wedges = []
    const rssSamples = []
    let snapshot = new Map(
      terms.map((term) => [term.terminalId, term.rawBytes]),
    )
    const end = Date.now() + durationMs

    const chatLoop = (async () => {
      while (!stopFlag.stop && Date.now() < end) {
        const started = Date.now()
        const { done, latencies } = await chatMessage(stack, session.id, 60_000)
        if (done === 'completed') chatRuns.completed += 1
        else {
          chatRuns.failed += 1
          wedges.push(`chat ${done ?? 'timeout'}`)
        }
        chatLatencies.push(...latencies)
        const wait = P2_CHAT_INTERVAL_MS - (Date.now() - started)
        if (wait > 0) await delay(Math.min(wait, Math.max(0, end - Date.now())))
      }
    })()
    const pingLoop = (async () => {
      while (!stopFlag.stop && Date.now() < end - P2_PING_INTERVAL_MS) {
        const started = Date.now()
        await ping.send()
        await ping.drain(5_000)
        if (ping.outstanding.size > 0) {
          wedges.push(`ping ${[...ping.outstanding.keys()]} 未在 5s 内应答`)
        }
        const wait = P2_PING_INTERVAL_MS - (Date.now() - started)
        if (wait > 0) await delay(wait)
      }
    })()
    const liveLoop = (async () => {
      while (!stopFlag.stop && Date.now() < end) {
        await delay(P2_LIVE_INTERVAL_MS)
        if (stopFlag.stop) break
        for (const term of flooded) {
          if (term.rawBytes <= snapshot.get(term.terminalId)) {
            wedges.push(`starved ${term.label}`)
          }
        }
        snapshot = new Map(
          terms.map((term) => [term.terminalId, term.rawBytes]),
        )
      }
    })()
    const rssLoop = (async () => {
      const sidecarPid = [...stack.knownSidecars][0]
      while (!stopFlag.stop && Date.now() < end) {
        const a = psSample(stack.runtime.pid)
        const b = sidecarPid ? psSample(sidecarPid) : null
        if (a && b) {
          rssSamples.push({
            t: Date.now(),
            runtimeKib: a.rssKib,
            sidecarKib: b.rssKib,
          })
        }
        await delay(P2_RSS_INTERVAL_MS)
      }
    })()

    console.log(
      `[P2] 长稳 ${durationMs / 1000}s：8 终端（7×yes + 控制）、10s PING、30s 聊天`,
    )
    while (Date.now() < end && !stopFlag.stop) await delay(1000)
    stopFlag.stop = true
    await Promise.all([chatLoop, pingLoop, liveLoop, rssLoop])
    await ping.drain(10_000)
    stopOutput()

    const slopeRuntime = rssSlopeMiBPerMin(
      rssSamples.map((s) => ({ t: s.t, rssKib: s.runtimeKib })),
      P2_RSS_FIT_WINDOW_MS,
    )
    const slopeSidecar = rssSlopeMiBPerMin(
      rssSamples.map((s) => ({ t: s.t, rssKib: s.sidecarKib })),
      P2_RSS_FIT_WINDOW_MS,
    )
    const queueBounded =
      stack.metricsLines === 0 ||
      stack.metricsMaxQueued <= METRICS_QUEUED_LIMIT_BYTES
    const lossPing = [...ping.outstanding.keys()]
    const pass =
      lossPing.length === 0 &&
      wedges.length === 0 &&
      queueBounded &&
      slopeRuntime !== null &&
      slopeRuntime < RSS_SLOPE_LIMIT_MIB_PER_MIN &&
      slopeSidecar !== null &&
      slopeSidecar < RSS_SLOPE_LIMIT_MIB_PER_MIN &&
      chatRuns.failed === 0
    const summary = {
      phase: 'P2',
      pass,
      seconds: round1((Date.now() - t0) / 1000),
      pingIssued: ping.issued,
      pingRttStatsMs: stats(ping.rtts),
      pingWriteRpcStatsMs: stats(ping.writeRpcMs),
      pingLosses: lossPing,
      chatRuns,
      p95ChatMs: round1(percentile(chatLatencies, 0.95)),
      rssSlopeMiBPerMin: {
        runtime: round3(slopeRuntime),
        sidecar: round3(slopeSidecar),
      },
      egressMaxQueuedKib: round1(stack.metricsMaxQueued / 1024),
      egressMetricsGap: stack.metricsLines === 0,
      wedges: wedges.slice(0, 8),
    }
    console.log(`[P2] ${JSON.stringify(summary)}`)
    return { pass, summary }
  } catch (error) {
    console.error(`[P2] 异常: ${error?.message ?? error}`)
    return {
      pass: false,
      summary: {
        phase: 'P2',
        pass: false,
        error: String(error?.message ?? error),
      },
    }
  } finally {
    if (stack) {
      const cleanup = await stack.shutdown()
      console.log(`[P2 cleanup] ${JSON.stringify(cleanup)}`)
      if (!cleanup.clean) {
        console.log(
          `PERF-SUMMARY ${JSON.stringify({ phase: 'P2-CLEANUP', pass: false, cleanup })}`,
        )
      }
    }
  }
}

// ---------------- main ----------------
const mockServer = await startMockProvider()
const mockBaseUrl = `http://127.0.0.1:${mockServer.address().port}/v1`
const results = []

if (MODE === 'p2') {
  const durationMs = OVERRIDE_SEC !== null ? OVERRIDE_SEC * 1000 : P2_MS_DEFAULT
  const p2 = await phaseP2(mockBaseUrl, durationMs)
  results.push(p2)
} else {
  const stack = await bootStack('p0p1', mockBaseUrl)
  try {
    const wsDir = mkdtempSync(join(stack.dataDir, 'ws-'))
    const wsA = mkdtempSync(join(stack.dataDir, 'wsA-'))
    const wsB = mkdtempSync(join(stack.dataDir, 'wsB-'))
    const { project } = await stack.call(
      'project.create',
      stack.req({ folderPath: wsDir }),
    )
    const { session } = await stack.call(
      'session.create',
      stack.req({ projectId: project.id }),
    )
    const p0term = await makeTerminal(stack, project.id, 'p0')
    const ctx = {
      sessionId: session.id,
      projectId: project.id,
      p0term,
      wsA,
      wsB,
      p95Base: null,
    }
    const p0 = await phaseP0(stack, ctx)
    ctx.p95Base = p0.summary.p95BaseMs
    const floodMs = OVERRIDE_SEC !== null ? OVERRIDE_SEC * 1000 : FLOOD_MS[MODE]
    const p1 = await phaseP1(stack, ctx, floodMs)
    results.push(p0, p1)
  } finally {
    const cleanup = await stack.shutdown()
    console.log(`[cleanup] ${JSON.stringify(cleanup)}`)
    if (!cleanup.clean) {
      results.push({ pass: false, summary: { phase: 'CLEANUP', cleanup } })
    }
  }
}

mockServer.close()
for (const result of results) {
  console.log(`PERF-SUMMARY ${JSON.stringify(result.summary)}`)
}
const failed = results.filter((r) => !r.pass)
console.log(
  `terminal-perf: ${results.length - failed.length}/${results.length} phases passed (${MODE})`,
)
process.exit(failed.length === 0 && results.length > 0 ? 0 : 1)
