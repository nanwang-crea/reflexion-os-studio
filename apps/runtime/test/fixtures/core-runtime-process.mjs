import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import {
  lookupCommandSchema,
  RuntimeEventSchema,
} from '@reflexion-os-studio/contracts'

export async function startRuntime(dataDir, binary) {
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL('../../dist/index.js', import.meta.url))],
    {
      env: {
        ...process.env,
        REFLEXION_DATA_DIR: dataDir,
        REFLEXION_SYSTEM_RUNTIME_BIN: binary,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  )
  const pending = new Map()
  const events = []
  const waiters = new Set()
  let seq = 0
  let stderr = ''
  child.stderr.on('data', (chunk) => {
    stderr = (stderr + chunk.toString()).slice(-10000)
  })
  const exited = new Promise((resolve) => child.once('exit', resolve))
  const failAll = () => {
    for (const item of pending.values()) {
      clearTimeout(item.timer)
      item.reject(new Error('runtime exited before reply'))
    }
    pending.clear()
  }
  child.once('exit', failAll)
  const lines = createInterface({ input: child.stdout })
  lines.on('line', (line) => {
    const message = JSON.parse(line)
    if (message.id !== undefined) {
      const entry = pending.get(message.id)
      if (!entry) return
      pending.delete(message.id)
      clearTimeout(entry.timer)
      if (message.error) entry.reject(new Error(message.error.message))
      else entry.resolve(message.result)
    } else if (message.method) {
      if (message.method !== 'runtime.ready')
        RuntimeEventSchema.parse(message.params)
      events.push(message)
      for (const waiter of waiters) waiter()
    }
  })
  const call = async (method, params = {}, requestId = randomUUID()) => {
    const schema = lookupCommandSchema(method)
    const payload = { ...params, requestId }
    if (schema) schema.params.parse(payload)
    const id = ++seq
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`acceptance request timeout: ${method}; ${stderr}`))
      }, 20000)
      pending.set(id, { resolve, reject, timer })
      child.stdin.write(
        JSON.stringify({ jsonrpc: '2.0', id, method, params: payload }) + '\n',
      )
    })
    return schema ? schema.result.parse(result) : result
  }
  const waitFor = (predicate) =>
    new Promise((resolve, reject) => {
      const check = () => {
        const event = events.find(predicate)
        if (event) {
          clearTimeout(timer)
          waiters.delete(check)
          resolve(event)
        }
      }
      const timer = setTimeout(() => {
        waiters.delete(check)
        reject(new Error(`acceptance event timeout; ${stderr}`))
      }, 20000)
      waiters.add(check)
      check()
    })
  try {
    await waitFor(
      (message) =>
        message.method === 'runtime.status' &&
        message.params.status.systemAvailable === true,
    )
  } catch (error) {
    child.kill()
    await exited
    lines.close()
    throw error
  }
  return {
    call,
    waitFor,
    events,
    async stop() {
      await call('runtime.shutdown')
      await exited
      lines.close()
    },
  }
}
