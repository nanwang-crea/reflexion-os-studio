import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { PassThrough } from 'node:stream'
import { setTimeout } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { createHostConnection } from '../../dist/lifecycle/host-connection.js'
import { createRuntimeShutdown } from '../../dist/lifecycle/shutdown.js'
import { acquireDataDirectoryLock } from '../../dist/lifecycle/data-directory-lock.js'

test('shutdown is ordered, idempotent and continues after a cleanup failure', async () => {
  const calls = []
  const failure = new Error('cleanup failed')
  const shutdown = createRuntimeShutdown(
    {
      terminal: async () => {
        calls.push('terminal')
        void shutdown.run()
        throw failure
      },
      system: () => calls.push('system'),
    },
    (name, error) => calls.push([name, error]),
    () => calls.push('exit'),
  )
  assert.equal(shutdown.started, false)
  const pending = shutdown.run()
  assert.equal(shutdown.started, true)
  assert.equal(shutdown.run(), pending)
  await pending
  await shutdown.run()
  assert.deepEqual(calls, ['terminal', ['terminal', failure], 'system', 'exit'])
})

test('host pipe errors disconnect once and late responses still finish', () => {
  const streams = {
    input: new PassThrough(),
    output: new PassThrough(),
    diagnostics: new PassThrough(),
  }
  let disconnected = 0
  const write = createHostConnection(streams, () => disconnected++)
  const message = { jsonrpc: '2.0', id: 1, result: { ok: true } }
  write(message)
  assert.equal(streams.output.read().toString(), `${JSON.stringify(message)}\n`)
  streams.output.emit('error', new Error('EPIPE'))
  streams.input.emit('close')
  streams.diagnostics.emit('error', new Error('EPIPE'))
  let flushed = false
  write(message, () => (flushed = true))
  assert.equal(flushed, true)
  assert.equal(streams.output.read(), null)
  assert.equal(disconnected, 1)
})

function startRuntime(t) {
  const dir = mkdtempSync(join(tmpdir(), 'reflexion-shutdown-'))
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL('../../dist/index.js', import.meta.url))],
    {
      env: {
        ...process.env,
        REFLEXION_DATA_DIR: dir,
        REFLEXION_SYSTEM_RUNTIME_BIN: '',
        // Avoid executing the developer's shell startup files in this fixture.
        SHELL: process.execPath,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  )
  child.stdin.on('error', () => {})
  let stderr = ''
  child.stderr.on('data', (chunk) => (stderr += chunk))
  const messages = []
  let buffer = ''
  child.stdout.on('data', (chunk) => {
    buffer += chunk
    let newline
    while ((newline = buffer.indexOf('\n')) >= 0) {
      messages.push(JSON.parse(buffer.slice(0, newline)))
      buffer = buffer.slice(newline + 1)
    }
  })
  const exited = once(child, 'exit', { signal: AbortSignal.timeout(10000) })
  // Register a handler immediately, including while a readiness wait is pending.
  void exited.catch(() => {})
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL')
      await once(child, 'exit')
    }
    rmSync(dir, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    })
  })
  const waitFor = async (predicate) => {
    for (;;) {
      if (messages.some(predicate)) return
      assert.equal(child.exitCode, null, stderr)
      await once(child.stdout, 'data', { signal: AbortSignal.timeout(10000) })
    }
  }
  const assertCleanExit = async () => {
    assert.deepEqual(await exited, [0, null], stderr)
    // The actual OS lock must be available, not just an absent lock file.
    acquireDataDirectoryLock(dir)()
  }
  return { child, messages, waitFor, assertCleanExit }
}

test('stdin EOF after readiness exits and releases the data directory lock', async (t) => {
  const runtime = startRuntime(t)
  await runtime.waitFor((message) => message.method === 'runtime.ready')
  runtime.child.stdin.end()
  await runtime.assertCleanExit()
})

test('stdin EOF immediately after spawn still exits cleanly', async (t) => {
  const runtime = startRuntime(t)
  runtime.child.stdin.end()
  await runtime.assertCleanExit()
})

test('protocol shutdown flushes its response before exiting', async (t) => {
  const runtime = startRuntime(t)
  await runtime.waitFor((message) => message.method === 'runtime.ready')
  runtime.child.stdin.write(
    `${JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'runtime.shutdown' })}\n`,
  )
  await runtime.assertCleanExit()
  assert.deepEqual(
    runtime.messages.find((message) => message.id === 7),
    {
      jsonrpc: '2.0',
      id: 7,
      result: { ok: true },
    },
  )
})

test('broken stdout triggers cleanup even while stdin is still open', async (t) => {
  const runtime = startRuntime(t)
  await runtime.waitFor((message) => message.method === 'runtime.ready')
  runtime.child.stdout.destroy()
  runtime.child.stdin.write(
    `${JSON.stringify({ jsonrpc: '2.0', id: 8, method: 'runtime.get_status', params: { requestId: 'status' } })}\n`,
  )
  await runtime.assertCleanExit()
})

test(
  'SIGTERM uses the same cleanup path',
  { skip: process.platform === 'win32' },
  async (t) => {
    const runtime = startRuntime(t)
    await runtime.waitFor((message) => message.method === 'runtime.ready')
    runtime.child.kill('SIGTERM')
    await runtime.assertCleanExit()
  },
)

test('abrupt host death leaves no Runtime holding the data directory', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'reflexion-host-death-'))
  const runtimePath = fileURLToPath(
    new URL('../../dist/index.js', import.meta.url),
  )
  const code = `
    const { spawn } = await import('node:child_process');
    const runtime = spawn(process.execPath, [process.argv[1]], {
      env: process.env, stdio: ['pipe', 'pipe', 'pipe']
    });
    process.stdout.write(JSON.stringify({ pid: runtime.pid }) + '\\n');
    runtime.stdout.pipe(process.stdout);
    runtime.stderr.pipe(process.stderr);
  `
  const host = spawn(
    process.execPath,
    ['--input-type=module', '-e', code, runtimePath],
    {
      env: {
        ...process.env,
        REFLEXION_DATA_DIR: dir,
        REFLEXION_SYSTEM_RUNTIME_BIN: '',
        SHELL: process.execPath,
      },
    },
  )
  host.stderr.resume()
  const hostExited = once(host, 'exit')
  let runtimePid
  t.after(async () => {
    if (host.exitCode === null && host.signalCode === null) {
      host.kill('SIGKILL')
      await hostExited
    }
    if (runtimePid) {
      try {
        process.kill(runtimePid, 'SIGKILL')
      } catch {
        /* Already exited. */
      }
    }
    rmSync(dir, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    })
  })
  const lines = createInterface({
    input: host.stdout,
    signal: AbortSignal.timeout(10000),
  })
  let ready = false
  for await (const line of lines) {
    const message = JSON.parse(line)
    if (message.pid) runtimePid = message.pid
    if (message.method === 'runtime.ready') {
      ready = true
      break
    }
  }
  assert.equal(ready, true)
  assert.throws(() => acquireDataDirectoryLock(dir), /already in use/)
  host.kill('SIGKILL')
  assert.deepEqual(await hostExited, [null, 'SIGKILL'])
  const deadline = Date.now() + 8000
  while (Date.now() < deadline) {
    try {
      process.kill(runtimePid, 0)
    } catch (error) {
      if (error.code !== 'ESRCH') throw error
      acquireDataDirectoryLock(dir)()
      runtimePid = undefined
      return
    }
    await setTimeout(25)
  }
  assert.fail('orphan Runtime survived its host')
})
