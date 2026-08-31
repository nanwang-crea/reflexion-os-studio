// TS↔Rust 通道集成冒烟（方案 A）：验证 TS Runtime spawn/监管 Rust System Runtime。
// 覆盖：握手 → runtime.status 上报 systemAvailable → system.ping 代理 →
//       runtime.shutdown 协议关停后无孤儿 → 二进制缺失时 degraded 不阻塞 Chat。
// 用法：先 pnpm build:packages（+ cargo build），再 node scripts/smoke-system-channel.mjs
import { spawn, execSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const TS_ENTRY = join(ROOT, 'apps/runtime/dist/index.js')
const RUST_BIN = join(ROOT, 'crates/target/debug/reflexion-system-runtime')

let failures = 0
function check(name, condition, detail) {
  if (condition) {
    console.log(`PASS ${name}`)
  } else {
    failures++
    console.error(`FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

/** 统计某 TS Runtime 直属的 Rust 子进程数（状态可见性用，避免误报全局其它实例）。 */
function countChildRustProcesses(pid) {
  try {
    const output = execSync(`pgrep -P ${pid} -fl reflexion-system-runtime`, {
      encoding: 'utf8',
    })
    return output
      .split('\n')
      .filter((line) => line.includes('reflexion-system-runtime')).length
  } catch {
    return 0 // pgrep 无匹配时以非零码退出
  }
}

/** 统计已脱离宿主的 Rust 孤儿（PPID=1）：原 TS Runtime 已退出却仍有遗留进程。 */
function countOrphanRustProcesses() {
  try {
    const output = execSync('pgrep -P 1 -fl reflexion-system-runtime', {
      encoding: 'utf8',
    })
    return output
      .split('\n')
      .filter((line) => line.includes('reflexion-system-runtime')).length
  } catch {
    return 0 // pgrep 无匹配时以非零码退出
  }
}

function startRuntime(env) {
  const dataDir = mkdtempSync(join(tmpdir(), 'reflexion-system-'))
  const child = spawn(
    process.execPath,
    ['--disable-warning=ExperimentalWarning', TS_ENTRY],
    {
      // cwd 指向临时数据目录：禁用 TS 的相对路径搜索兜底，
      // 强制只按 REFLEXION_SYSTEM_RUNTIME_BIN 决定是否可用。
      cwd: dataDir,
      env: { ...process.env, REFLEXION_DATA_DIR: dataDir, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  )
  const events = []
  const pending = new Map()
  let buffer = ''
  let exitPromise = new Promise((resolve) => child.on('exit', resolve))
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    buffer += chunk
    for (;;) {
      const newline = buffer.indexOf('\n')
      if (newline === -1) break
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      if (!line.trim()) continue
      let message
      try {
        message = JSON.parse(line)
      } catch {
        continue
      }
      if (message.id === undefined && message.method !== undefined) {
        events.push(message)
      } else if (typeof message.id === 'number') {
        const entry = pending.get(message.id)
        if (entry) {
          pending.delete(message.id)
          entry(message)
        }
      }
    }
  })
  child.stderr.on('data', (chunk) => process.stderr.write(`[runtime] ${chunk}`))
  const request = (id, method, params = {}, timeoutMs = 10_000) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`timeout: ${method}`)),
        timeoutMs,
      )
      pending.set(id, (message) => {
        clearTimeout(timer)
        if (message.error) reject(new Error(JSON.stringify(message.error)))
        else resolve(message.result)
      })
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`,
      )
    })
  const waitForEvent = (predicate, timeoutMs = 15_000, description = 'event') =>
    new Promise((resolve, reject) => {
      const found = events.find(predicate)
      if (found) {
        resolve(found)
        return
      }
      const timer = setInterval(() => {
        const hit = events.find(predicate)
        if (hit) {
          clearInterval(timer)
          clearTimeout(failTimer)
          resolve(hit)
        }
      }, 25)
      const failTimer = setTimeout(() => {
        clearInterval(timer)
        reject(
          new Error(
            `event timeout: ${description}; got ${events.map((event) => event.method ?? event.type).join(',')}`,
          ),
        )
      }, timeoutMs)
    })
  return {
    child,
    events,
    request,
    waitForEvent,
    waitExit: () => exitPromise,
    cleanup: () => rmSync(dataDir, { recursive: true, force: true }),
  }
}

if (!existsSync(TS_ENTRY)) {
  console.error(
    'smoke-system-channel: TS entry missing, run pnpm build:packages',
  )
  process.exit(1)
}
if (!existsSync(RUST_BIN)) {
  console.error(
    'smoke-system-channel: Rust binary missing, run cargo build --manifest-path crates/Cargo.toml',
  )
  process.exit(1)
}

console.log('smoke-system-channel: starting')

// ---------- 场景一：正常通道 ----------
{
  const runtime = startRuntime({ REFLEXION_SYSTEM_RUNTIME_BIN: RUST_BIN })
  try {
    await runtime.waitForEvent(
      (event) => event.method === 'runtime.ready',
      15_000,
      'runtime.ready',
    )
    check('runtime.ready emitted', true)

    const statusEvent = await runtime.waitForEvent(
      (event) =>
        event.method === 'runtime.status' &&
        event.params?.status?.systemAvailable === true,
      15_000,
      'runtime.status(systemAvailable=true)',
    )
    check('runtime.status reports systemAvailable=true', statusEvent !== null)

    const ping = await runtime.request(1, 'system.ping')
    check('system.ping proxied to Rust', ping?.ok === true)

    const status = await runtime.request(2, 'runtime.get_status', {
      requestId: randomUUID(),
    })
    check(
      'runtime.get_status exposes systemAvailable',
      status?.systemAvailable === true,
    )

    check(
      'rust child process visible',
      countChildRustProcesses(runtime.child.pid) >= 1,
    )

    const shutdownStart = Date.now()
    await runtime.request(3, 'runtime.shutdown')
    const exitCode = await Promise.race([
      runtime.waitExit(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('runtime exit timeout')), 8000),
      ),
    ])
    check(
      'runtime exits on shutdown',
      exitCode === 0,
      `code=${String(exitCode)}`,
    )
    check(
      'graceful shutdown completes promptly',
      Date.now() - shutdownStart < 7000,
    )
    await new Promise((resolve) => setTimeout(resolve, 500))
    check(
      'no orphan rust process after shutdown',
      countOrphanRustProcesses() === 0,
    )
  } catch (error) {
    failures++
    console.error(`FAIL unexpected — ${error.message}`)
    runtime.child.kill('SIGKILL')
  } finally {
    runtime.cleanup()
  }
}

// ---------- 场景二：二进制缺失 → degraded，Chat 不受影响 ----------
{
  const runtime = startRuntime({
    REFLEXION_SYSTEM_RUNTIME_BIN: '/nonexistent/reflexion-system-runtime',
  })
  try {
    await runtime.waitForEvent(
      (event) => event.method === 'runtime.ready',
      15_000,
      'runtime.ready',
    )
    check('degraded: runtime.ready still emitted', true)

    await runtime.waitForEvent(
      (event) =>
        event.method === 'runtime.status' &&
        event.params?.status?.systemAvailable === false,
      15_000,
      'runtime.status(systemAvailable=false)',
    )
    check('degraded: runtime.status reports systemAvailable=false', true)

    const ping = await runtime.request(1, 'system.ping')
    check(
      'degraded: system.ping returns ok=false without crashing',
      ping?.ok === false && typeof ping?.detail === 'string',
      JSON.stringify(ping),
    )

    const sessions = await runtime.request(2, 'session.list', {
      requestId: randomUUID(),
    })
    check(
      'degraded: chat commands still work',
      Array.isArray(sessions?.sessions),
    )

    await runtime.request(3, 'runtime.shutdown')
    await Promise.race([
      runtime.waitExit(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('runtime exit timeout')), 8000),
      ),
    ])
    check('degraded: runtime exits on shutdown', true)
  } catch (error) {
    failures++
    console.error(`FAIL unexpected — ${error.message}`)
    runtime.child.kill('SIGKILL')
  } finally {
    runtime.cleanup()
  }
}

if (failures > 0) {
  console.error(`smoke-system-channel: ${failures} failure(s)`)
  process.exit(1)
}
console.log('smoke-system-channel: all checks passed')
