// M2 端到端冒烟：内嵌 mock OpenAI-compatible SSE Provider，
// 驱动 runtime 走 configure → project → session → message.send → delta → completed 全链路。
// 用法：先 pnpm build:packages，再 node scripts/smoke-chat.mjs
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:http'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const REPLY = '你好，这里是 mock 回复。'

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
      const parsed = JSON.parse(body)
      if (parsed.model !== 'mock-model') {
        response.writeHead(404)
        response.end('unknown model')
        return
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      const chunks = ['你好', '，这里是 ', 'mock 回复。']
      let index = 0
      const timer = setInterval(() => {
        if (index < chunks.length) {
          response.write(
            `data: ${JSON.stringify({ choices: [{ delta: { content: chunks[index] } }] })}\n\n`,
          )
          index++
          return
        }
        clearInterval(timer)
        response.write(
          `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 7 } })}\n\n`,
        )
        response.write('data: [DONE]\n\n')
        response.end()
      }, 50)
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server))
  })
}

const mockServer = await startMockProvider()

const address = mockServer.address()
const baseUrl = `http://127.0.0.1:${address.port}/v1`

const dataDir = mkdtempSync(join(tmpdir(), 'reflexion-smoke-'))
const runtime = spawn(
  process.execPath,
  [join(ROOT, 'apps/runtime/dist/index.js')],
  {
    env: { ...process.env, REFLEXION_DATA_DIR: dataDir },
    stdio: ['pipe', 'pipe', 'pipe'],
  },
)

const pending = new Map()
const events = []
let readySignal

const readyPromise = new Promise((resolve, reject) => {
  readySignal = { resolve, reject }
  setTimeout(() => reject(new Error('runtime.ready timeout (10s)')), 10_000)
})

runtime.on('error', (error) =>
  readySignal.reject(new Error(`spawn failed: ${error.message}`)),
)
runtime.on('exit', (code) => {
  if (!runtimeExited) {
    readySignal.reject(new Error(`runtime exited before ready (code=${code})`))
  }
})
let runtimeExited = false
runtime.on('exit', () => {
  runtimeExited = true
})

const stdout = runtime.stdout.setEncoding('utf8')
let buffer = ''
stdout.on('data', (chunk) => {
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
    if (message.method === 'runtime.ready' && message.id === undefined) {
      readySignal.resolve()
      continue
    }
    if (message.method !== undefined && message.id === undefined) {
      events.push(message.params ?? message)
      continue
    }
    if (typeof message.id === 'number') {
      const pendingEntry = pending.get(message.id)
      if (pendingEntry) {
        pending.delete(message.id)
        pendingEntry(message)
      }
    }
  }
})
runtime.stderr.on('data', (chunk) => process.stderr.write(`[runtime] ${chunk}`))

function request(id, method, params) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`timeout: ${method}`)),
      15_000,
    )
    pending.set(id, (message) => {
      clearTimeout(timer)
      if (message.error) {
        reject(new Error(`${method}: ${JSON.stringify(message.error)}`))
      } else {
        resolve(message.result)
      }
    })
    runtime.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`,
    )
  })
}

function waitForEvent(type, timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    const existing = events.find((event) => event.type === type)
    if (existing) {
      resolve(existing)
      return
    }
    const timer = setInterval(() => {
      const found = events.find((event) => event.type === type)
      if (found) {
        clearInterval(timer)
        clearTimeout(failTimer)
        resolve(found)
      }
    }, 50)
    const failTimer = setTimeout(() => {
      clearInterval(timer)
      reject(
        new Error(
          `event timeout: ${type}; got ${events.map((event) => event.type).join(',')}`,
        ),
      )
    }, timeoutMs)
  })
}

let failures = 0
function check(name, condition, detail) {
  if (condition) {
    console.log(`PASS ${name}`)
  } else {
    failures++
    console.error(`FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

try {
  console.log('smoke-chat: starting')
  await readyPromise
  console.log('PASS runtime.ready')

  await request(1, 'provider.configure', {
    requestId: randomUUID(),
    name: 'mock',
    baseUrl,
    models: ['mock-model'],
    secret: 'sk-mock',
    enabled: true,
  })
  console.log('PASS provider.configure')

  const second = await request(12, 'provider.configure', {
    requestId: randomUUID(),
    name: 'mock-two',
    baseUrl,
    models: ['mock-model', 'spare-model'],
    secret: 'sk-mock-2',
    enabled: false,
  })
  check(
    'provider saves multiple models',
    second.profile.models.join(',') === 'mock-model,spare-model',
  )
  const renamed = await request(13, 'provider.configure', {
    requestId: randomUUID(),
    id: second.profile.id,
    name: 'mock-two-renamed',
    baseUrl,
    models: ['mock-model'],
    secretRef: second.profile.secretRef,
    enabled: false,
  })
  check(
    'provider editable without re-entering secret',
    renamed.profile.name === 'mock-two-renamed' &&
      renamed.profile.secretRef === second.profile.secretRef,
  )
  const removed = await request(14, 'provider.delete', {
    requestId: randomUUID(),
    id: second.profile.id,
  })
  check('provider.delete removes profile', removed.removed === true)
  const afterDelete = await request(15, 'provider.list', {
    requestId: randomUUID(),
  })
  check(
    'deleted provider gone from list',
    !afterDelete.profiles.some((profile) => profile.id === second.profile.id),
  )
  const testOk = await request(16, 'provider.test', {
    requestId: randomUUID(),
    baseUrl,
    model: 'mock-model',
    secret: 'sk-mock',
  })
  check(
    'provider.test succeeds against mock provider',
    testOk.ok === true && testOk.error === null && testOk.latencyMs >= 0,
  )
  const testBad = await request(17, 'provider.test', {
    requestId: randomUUID(),
    baseUrl,
    model: 'unknown-model',
    secret: 'sk-mock',
  })
  check(
    'provider.test surfaces provider error verbatim',
    testBad.ok === false && (testBad.error ?? '').includes('404'),
    `error=${JSON.stringify(testBad.error)}`,
  )

  const projectDir = join(dataDir, 'smoke-project')
  const { project } = await request(2, 'project.create', {
    requestId: randomUUID(),
    folderPath: projectDir,
  })
  check(
    'project name defaults to folder basename',
    project.name === 'smoke-project' && project.folderPath === projectDir,
  )
  const { session } = await request(3, 'session.create', {
    requestId: randomUUID(),
    projectId: project.id,
  })
  const { session: standalone } = await request(8, 'session.create', {
    requestId: randomUUID(),
    projectId: null,
  })
  check('standalone session has null projectId', standalone.projectId === null)
  const [projectSessionList, standaloneSessionList] = await Promise.all([
    request(9, 'session.list', {
      requestId: randomUUID(),
      projectId: project.id,
    }),
    request(10, 'session.list', {
      requestId: randomUUID(),
      projectId: null,
    }),
  ])
  check(
    'session.list splits project vs standalone',
    projectSessionList.sessions.some((item) => item.id === session.id) &&
      standaloneSessionList.sessions.some(
        (item) => item.id === standalone.id,
      ) &&
      !standaloneSessionList.sessions.some((item) => item.id === session.id),
  )
  const duplicateProject = await request(11, 'project.create', {
    requestId: randomUUID(),
    folderPath: `${projectDir}/`,
  }).catch(() => null)
  check('duplicate project folder rejected', duplicateProject === null)
  console.log('PASS project/session created')

  const send = await request(4, 'message.send', {
    requestId: randomUUID(),
    sessionId: session.id,
    content: '打个招呼',
  })
  check('message.send returns ids', Boolean(send.messageId && send.runId))

  const delta = await waitForEvent('message.delta')
  check('message.delta carries chunkSeq', delta.chunkSeq === 0)

  await waitForEvent('run.completed')
  console.log('PASS run.completed')

  const detail = await request(5, 'session.get', {
    requestId: randomUUID(),
    sessionId: session.id,
  })
  const assistant = detail.messages.find(
    (message) => message.id === send.messageId,
  )
  check(
    'assistant message persisted with full content',
    assistant?.status === 'completed' && assistant.content === REPLY,
    `status=${assistant?.status} content=${JSON.stringify(assistant?.content)}`,
  )
  const userMessage = detail.messages.find((message) => message.role === 'user')
  check(
    'user message persisted',
    userMessage?.content === '打个招呼' && userMessage.status === 'completed',
  )
  const run = detail.runs.find((item) => item.id === send.runId)
  check('run terminal state completed', run?.status === 'completed')
  check(
    'session title derived from first message',
    detail.session?.title === '打个招呼',
    `title=${JSON.stringify(detail.session?.title)}`,
  )
  check(
    'usage captured in message.completed',
    events.some(
      (event) =>
        event.type === 'message.completed' &&
        event.usage?.promptTokens === 5 &&
        event.usage?.completionTokens === 7,
    ),
  )

  const cancelled = await request(6, 'run.cancel', {
    requestId: randomUUID(),
    runId: 'nonexistent-run',
  })
  check('run.cancel idempotent for unknown run', cancelled.accepted === false)

  const renamedSession = await request(18, 'session.rename', {
    requestId: randomUUID(),
    sessionId: session.id,
    title: '自定义标题',
  })
  check(
    'session.rename updates title',
    renamedSession.session.title === '自定义标题',
  )

  const removedSession = await request(19, 'session.delete', {
    requestId: randomUUID(),
    sessionId: standalone.id,
  })
  check(
    'session.delete removes standalone session',
    removedSession.removed === true,
  )
  const afterSessionDelete = await request(20, 'session.list', {
    requestId: randomUUID(),
    projectId: null,
  })
  check(
    'deleted standalone session gone from list',
    !afterSessionDelete.sessions.some((item) => item.id === standalone.id),
  )

  const removedProject = await request(21, 'project.delete', {
    requestId: randomUUID(),
    projectId: project.id,
  })
  check('project.delete removes project', removedProject.removed === true)
  const afterProjectDelete = await request(22, 'session.list', {
    requestId: randomUUID(),
    projectId: project.id,
  })
  check(
    'project sessions cascade-deleted',
    afterProjectDelete.sessions.length === 0,
  )

  await request(7, 'runtime.shutdown', {})
  await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('runtime did not exit')),
      5_000,
    )
    runtime.on('exit', () => {
      clearTimeout(timer)
      resolve()
    })
  })
  console.log('PASS runtime.shutdown exits cleanly')
} catch (error) {
  failures++
  console.error(`FAIL unexpected — ${error.message}`)
} finally {
  runtime.kill('SIGKILL')
  mockServer.close()
  rmSync(dataDir, { recursive: true, force: true })
}

if (failures > 0) {
  console.error(`smoke-chat: ${failures} failure(s)`)
  process.exit(1)
}
console.log('smoke-chat: all checks passed')
