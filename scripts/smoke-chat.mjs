// M2 端到端冒烟：内嵌 mock OpenAI-compatible SSE Provider，
// 驱动 runtime 走 configure → project → session → message.send → delta → completed 全链路。
// 用法：先 pnpm build:packages，再 node scripts/smoke-chat.mjs
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  mkdtempSync,
  rmSync,
  existsSync,
  writeFileSync,
  readFileSync,
  mkdirSync,
} from 'node:fs'
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
      if (
        parsed.model === 'file-agent-model' ||
        parsed.model === 'write-agent-model'
      ) {
        // 真实 Rust 工具场景：最后一条是 tool 结果 → 给最终答复；否则请求文件工具。
        const last = parsed.messages[parsed.messages.length - 1]
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        if (last.role === 'tool') {
          let payload = ''
          try {
            payload = JSON.parse(last.content).content ?? ''
          } catch {
            payload = ''
          }
          const reply =
            parsed.model === 'file-agent-model'
              ? `读取完成：${payload}`
              : '写入完成。'
          response.write(
            `data: ${JSON.stringify({ choices: [{ delta: { content: reply } }] })}\n\n`,
          )
          response.write(
            `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`,
          )
        } else if (parsed.model === 'file-agent-model') {
          response.write(
            `data: ${JSON.stringify({
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: 'call-file-1',
                        function: {
                          name: 'file.read',
                          arguments: '{"path":"note.txt"}',
                        },
                      },
                    ],
                  },
                },
              ],
            })}\n\n`,
          )
          response.write(
            `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })}\n\n`,
          )
        } else {
          response.write(
            `data: ${JSON.stringify({
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: 'call-write-1',
                        function: {
                          name: 'file.write',
                          arguments:
                            '{"path":"output.txt","content":"审批写入的内容"}',
                        },
                      },
                    ],
                  },
                },
              ],
            })}\n\n`,
          )
          response.write(
            `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })}\n\n`,
          )
        }
        response.write('data: [DONE]\n\n')
        response.end()
        return
      }
      if (parsed.model === 'tool-loop-model') {
        // Agent 任务循环场景：最后一条消息是 tool 结果 → 给最终答复；
        // 否则返回一次工具调用（get_current_time），驱动 runtime 完成两轮循环。
        const last = parsed.messages[parsed.messages.length - 1]
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        if (last.role === 'tool') {
          response.write(
            `data: ${JSON.stringify({ choices: [{ delta: { content: '任务完成：' } }] })}\n\n`,
          )
          response.write(
            `data: ${JSON.stringify({ choices: [{ delta: { content: '时间已获取。' } }] })}\n\n`,
          )
          response.write(
            `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 9, completion_tokens: 4 } })}\n\n`,
          )
        } else {
          response.write(
            `data: ${JSON.stringify({
              choices: [
                {
                  delta: {
                    content: '我先查一下时间',
                    tool_calls: [
                      {
                        index: 0,
                        id: 'call-smoke-1',
                        function: { name: 'get_current_time', arguments: '{}' },
                      },
                    ],
                  },
                },
              ],
            })}\n\n`,
          )
          response.write(
            `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })}\n\n`,
          )
        }
        response.write('data: [DONE]\n\n')
        response.end()
        return
      }
      if (parsed.model !== 'mock-model') {
        response.writeHead(404)
        response.end('unknown model')
        return
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      // 先流式吐 reasoning_content（推理模型思考），再吐正文，与真实
      // DeepSeek/Qwen 等兼容端点行为一致。
      const reasoningChunks = ['让我', '想想', '……']
      const chunks = ['你好', '，这里是 ', 'mock 回复。']
      let reasoningIndex = 0
      let index = 0
      const timer = setInterval(() => {
        if (reasoningIndex < reasoningChunks.length) {
          response.write(
            `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: reasoningChunks[reasoningIndex] } }] })}\n\n`,
          )
          reasoningIndex++
          return
        }
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
const systemBin = join(ROOT, 'crates/target/debug/reflexion-system-runtime')
if (!existsSync(systemBin)) {
  console.error(
    'smoke-chat: Rust binary missing, run cargo build --manifest-path crates/Cargo.toml',
  )
  process.exit(1)
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
      REFLEXION_SYSTEM_RUNTIME_BIN: systemBin,
    },
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

function waitForQueueSettled(sessionId, expectedCount, timeoutMs = 20_000) {
  return new Promise((resolve) => {
    const started = Date.now()
    const timer = setInterval(async () => {
      try {
        const detail = await request(-1, 'session.get', {
          requestId: randomUUID(),
          sessionId,
        })
        const runs = detail?.runs ?? []
        const settled =
          runs.length >= expectedCount &&
          runs.every(
            (run) =>
              !['created', 'running', 'awaiting_approval'].includes(run.status),
          )
        if (settled) {
          clearInterval(timer)
          resolve(detail)
          return
        }
      } catch {
        // 重试
      }
      if (Date.now() - started > timeoutMs) {
        clearInterval(timer)
        resolve(null)
      }
    }, 100)
  })
}

function waitForEvent(match, timeoutMs = 15_000, fromIndex = 0, description) {
  const predicate =
    typeof match === 'string' ? (event) => event.type === match : match
  const label = description ?? (typeof match === 'string' ? match : 'event')
  return new Promise((resolve, reject) => {
    const existing = events.slice(fromIndex).find(predicate)
    if (existing) {
      resolve(existing)
      return
    }
    const timer = setInterval(() => {
      const found = events.slice(fromIndex).find(predicate)
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
          `event timeout: ${label}; got ${events
            .slice(fromIndex)
            .map((event) => event.type)
            .join(',')}`,
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
  // 真实工作区：预置一个文件供 file.read 场景读取。
  mkdirSync(projectDir, { recursive: true })
  writeFileSync(join(projectDir, 'note.txt'), 'Rust 读到了我', 'utf8')
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

  const reasoningDelta = await waitForEvent('message.reasoning_delta')
  check(
    'message.reasoning_delta streams before content',
    reasoningDelta.chunkSeq === 0 && reasoningDelta.delta === '让我',
    `delta=${JSON.stringify(reasoningDelta.delta)}`,
  )

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
  check(
    'assistant reasoning persisted',
    assistant?.reasoning === '让我想想……',
    `reasoning=${JSON.stringify(assistant?.reasoning)}`,
  )
  check(
    'messages ordered user before assistant',
    detail.messages[0]?.role === 'user' &&
      detail.messages[detail.messages.length - 1]?.role === 'assistant',
    `roles=${detail.messages.map((message) => message.role).join(',')}`,
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

  // ---------- Agent 任务循环：工具调用 → 结果回填 → 最终答复 ----------
  const agentSession = await request(30, 'session.create', {
    requestId: randomUUID(),
    projectId: project.id,
  })
  const agentEventBase = events.length
  const agentSend = await request(31, 'message.send', {
    requestId: randomUUID(),
    sessionId: agentSession.session.id,
    model: 'tool-loop-model',
    content: '现在几点？',
  })
  check(
    'agent message.send returns ids',
    Boolean(agentSend.messageId && agentSend.runId),
  )
  const toolRequested = await waitForEvent(
    'tool.requested',
    15_000,
    agentEventBase,
  )
  check(
    'tool.requested names get_current_time',
    toolRequested.toolName === 'get_current_time' &&
      toolRequested.toolCallId !== '',
    `event=${JSON.stringify(toolRequested)}`,
  )
  const toolCompleted = await waitForEvent(
    'tool.completed',
    15_000,
    agentEventBase,
  )
  check('tool.completed succeeded', toolCompleted.status === 'completed')
  await waitForEvent('run.completed', 15_000, agentEventBase)

  const agentDetail = await request(32, 'session.get', {
    requestId: randomUUID(),
    sessionId: agentSession.session.id,
  })
  const agentMessages = agentDetail.messages
  check(
    'agent run persisted two assistant turns',
    agentMessages.filter((message) => message.role === 'assistant').length ===
      2,
    `roles=${agentMessages.map((message) => message.role).join(',')}`,
  )
  const finalAgentMessage = agentMessages[agentMessages.length - 1]
  check(
    'final answer after tool loop',
    finalAgentMessage.status === 'completed' &&
      finalAgentMessage.content === '任务完成：时间已获取。',
    `content=${JSON.stringify(finalAgentMessage?.content)}`,
  )
  const firstAgentAssistant = agentMessages.find(
    (message) => message.role === 'assistant',
  )
  check(
    'tool call persisted and linked to its assistant turn',
    agentDetail.toolCalls.length === 1 &&
      agentDetail.toolCalls[0].toolName === 'get_current_time' &&
      agentDetail.toolCalls[0].status === 'completed' &&
      agentDetail.toolCalls[0].messageId === firstAgentAssistant?.id,
    `toolCalls=${JSON.stringify(agentDetail.toolCalls)}`,
  )
  const agentRun = agentDetail.runs.find((item) => item.id === agentSend.runId)
  check('agent run completed', agentRun?.status === 'completed')

  // ---------- 真实 Rust 工具：file.read（automatic，直接执行） ----------
  const readSession = await request(40, 'session.create', {
    requestId: randomUUID(),
    projectId: project.id,
  })
  const readFileBase = events.length
  await request(41, 'message.send', {
    requestId: randomUUID(),
    sessionId: readSession.session.id,
    model: 'file-agent-model',
    content: '读一下 note.txt',
  })
  const readFileCall = await waitForEvent(
    (event) =>
      event.type === 'tool.requested' && event.toolName === 'file.read',
    15_000,
    readFileBase,
    'file.read requested',
  )
  check(
    'file.read requested with relative path',
    readFileCall.args?.path === 'note.txt',
    JSON.stringify(readFileCall),
  )
  await waitForEvent(
    (event) =>
      event.type === 'tool.completed' &&
      event.toolCallId === readFileCall.toolCallId &&
      event.status === 'completed',
    15_000,
    readFileBase,
    'file.read completed',
  )
  await waitForEvent('run.completed', 15_000, readFileBase)
  const readDetail = await request(42, 'session.get', {
    requestId: randomUUID(),
    sessionId: readSession.session.id,
  })
  const readFinal = readDetail.messages[readDetail.messages.length - 1]
  check(
    'file.read result flows back into final answer',
    readFinal?.content === '读取完成：Rust 读到了我',
    `content=${JSON.stringify(readFinal?.content)}`,
  )

  // ---------- 真实 Rust 工具 + 审批：file.write（ask，等待用户决策） ----------
  const writeSession = await request(43, 'session.create', {
    requestId: randomUUID(),
    projectId: project.id,
  })
  const writeFileBase = events.length
  await request(44, 'message.send', {
    requestId: randomUUID(),
    sessionId: writeSession.session.id,
    model: 'write-agent-model',
    content: '写一个 output.txt',
  })
  const approvalRequired = await waitForEvent(
    (event) => event.type === 'approval.required',
    15_000,
    writeFileBase,
    'approval.required',
  )
  check(
    'approval.required carries summary',
    approvalRequired.operation === 'file.write' &&
      typeof approvalRequired.summary === 'string' &&
      approvalRequired.summary.includes('output.txt'),
    JSON.stringify(approvalRequired),
  )
  // 审批等待期间 Run 应为 awaiting_approval（会话忙碌）。
  const awaitingDetail = await request(45, 'session.get', {
    requestId: randomUUID(),
    sessionId: writeSession.session.id,
  })
  check(
    'run enters awaiting_approval while waiting',
    awaitingDetail.runs[awaitingDetail.runs.length - 1]?.status ===
      'awaiting_approval',
    JSON.stringify(awaitingDetail.runs.map((run) => run.status)),
  )
  const resolved = await request(46, 'approval.resolve', {
    requestId: randomUUID(),
    toolCallId: approvalRequired.toolCallId,
    decision: 'approved',
    scope: 'once',
  })
  check('approval.resolve accepted', resolved?.accepted === true)
  await waitForEvent(
    (event) =>
      event.type === 'approval.resolved' &&
      event.toolCallId === approvalRequired.toolCallId &&
      event.decision === 'approved',
    15_000,
    writeFileBase,
    'approval.resolved',
  )
  await waitForEvent(
    (event) =>
      event.type === 'tool.completed' &&
      event.toolCallId === approvalRequired.toolCallId &&
      event.status === 'completed',
    15_000,
    writeFileBase,
    'file.write completed',
  )
  await waitForEvent('run.completed', 15_000, writeFileBase)
  check(
    'approved write landed in workspace',
    existsSync(join(projectDir, 'output.txt')) &&
      readFileSync(join(projectDir, 'output.txt'), 'utf8') === '审批写入的内容',
  )
  const duplicateResolve = await request(47, 'approval.resolve', {
    requestId: randomUUID(),
    toolCallId: approvalRequired.toolCallId,
    decision: 'denied',
    scope: 'once',
  })
  check(
    'duplicate approval.resolve is a no-op',
    duplicateResolve?.accepted === false,
  )

  // ---------- 发送队列:忙时排队,上一条结束自动发送;可修改/删除/立即发送 ----------
  const queueSession = await request(48, 'session.create', {
    requestId: randomUUID(),
    projectId: project.id,
  })
  const firstSend = await request(49, 'message.send', {
    requestId: randomUUID(),
    sessionId: queueSession.session.id,
    content: '第一条',
  })
  check(
    'first message starts immediately (not queued)',
    firstSend?.queued === false && typeof firstSend?.runId === 'string',
    JSON.stringify(firstSend),
  )
  const secondSend = await request(50, 'message.send', {
    requestId: randomUUID(),
    sessionId: queueSession.session.id,
    content: '第二条',
  })
  check(
    'second message queues while first running',
    secondSend?.queued === true && typeof secondSend?.queueId === 'string',
    JSON.stringify(secondSend),
  )
  const thirdSend = await request(51, 'message.send', {
    requestId: randomUUID(),
    sessionId: queueSession.session.id,
    content: '第三条',
  })
  check('third message also queues', thirdSend?.queued === true)

  const queueList = await request(52, 'queue.list', {
    requestId: randomUUID(),
    sessionId: queueSession.session.id,
  })
  check(
    'queue lists pending messages in FIFO order',
    queueList?.items?.length === 2 &&
      queueList.items[0].content === '第二条' &&
      queueList.items[1].content === '第三条',
    JSON.stringify(queueList),
  )
  const edited = await request(53, 'queue.update', {
    requestId: randomUUID(),
    sessionId: queueSession.session.id,
    queueId: secondSend.queueId,
    content: '第二条-已修改',
  })
  check(
    'queued message editable',
    edited?.item?.content === '第二条-已修改',
    JSON.stringify(edited),
  )
  const sentNow = await request(54, 'queue.send_now', {
    requestId: randomUUID(),
    sessionId: queueSession.session.id,
    queueId: thirdSend.queueId,
  })
  check('send_now accepted', sentNow?.accepted === true)

  // 第一条回复结束 → 队首("第三条")自动发出,依次泵出修改后的"第二条";
  // 等到全部 Run 终态再断言(事件消费不可靠,直接轮询 DB 状态)。
  const finalDetail = await waitForQueueSettled(queueSession.session.id, 3)
  const finalUsers = (finalDetail?.messages ?? [])
    .filter((message) => message.role === 'user')
    .map((message) => message.content)
  check(
    'queued messages all auto-sent with edited content',
    finalUsers.includes('第一条') &&
      finalUsers.includes('第三条') &&
      finalUsers.includes('第二条-已修改'),
    finalDetail === null
      ? 'settled=null'
      : `users=${JSON.stringify(finalUsers)} runs=${finalDetail.runs.length} statuses=${finalDetail.runs.map((r) => r.status).join(',')}`,
  )
  const drained = await request(55, 'queue.list', {
    requestId: randomUUID(),
    sessionId: queueSession.session.id,
  })
  check('queue drained after all sent', drained?.items?.length === 0)

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
