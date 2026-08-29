import { createInterface } from 'node:readline'
import {
  JsonRpcMessageSchema,
  PROTOCOL_VERSION,
  lookupCommandSchema,
  type JsonRpcMessage,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type RuntimeEvent,
  type RuntimeStatus,
} from '@reflexion-os-studio/contracts'
import { ChatAgent, CommandError } from './agent.js'
import { dispatchCommand } from './handlers.js'
import { resolveDataDir, Store } from './store.js'

const RUNTIME_VERSION = '0.1.0'
let rustAvailable = false

function write(message: JsonRpcMessage, onFlush?: () => void): void {
  process.stdout.write(`${JSON.stringify(message)}\n`, onFlush)
}

function sendResponse(
  id: string | number,
  result: unknown,
  onFlush?: () => void,
): void {
  const message: JsonRpcResponse = {
    jsonrpc: '2.0',
    id,
    result,
  }
  write(message, onFlush)
}

function sendError(
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown,
): void {
  write({
    jsonrpc: '2.0',
    id,
    error: { code, message, data },
  })
}

function notify(event: RuntimeEvent): void {
  write({ jsonrpc: '2.0', method: event.type, params: event })
}

function getStatus(): RuntimeStatus {
  return {
    state: 'ready',
    protocolVersion: PROTOCOL_VERSION,
    runtimeVersion: RUNTIME_VERSION,
    capabilities: ['chat'],
    chatAvailable: true,
    systemAvailable: rustAvailable,
  }
}

function summarizeZodIssues(error: {
  issues: { path: PropertyKey[]; message: string }[]
}): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.map(String).join('.') || '(root)'
    return `${path}: ${issue.message}`
  })
}

const store = new Store(resolveDataDir())
const agent = new ChatAgent(store, notify)
const commandContext = { store, agent }

function handleSystemStatus(request: JsonRpcRequest): void {
  const params = request.params as { available?: boolean } | undefined
  rustAvailable = Boolean(params?.available)
  sendResponse(request.id, { available: rustAvailable })
}

function handleRequest(request: JsonRpcRequest): void {
  if (request.method === 'system.status') {
    handleSystemStatus(request)
    return
  }

  if (request.method === 'runtime.shutdown') {
    sendResponse(request.id, { ok: true }, () => process.exit(0))
    return
  }

  const entry = lookupCommandSchema(request.method)
  if (!entry) {
    sendError(request.id, -32601, `Method not found: ${request.method}`)
    return
  }

  const params = entry.params.safeParse(request.params ?? {})
  if (!params.success) {
    sendError(
      request.id,
      -32602,
      'Invalid params',
      summarizeZodIssues(params.error),
    )
    return
  }

  if (request.method === 'runtime.get_status') {
    sendResponse(request.id, getStatus())
    return
  }

  try {
    const result = dispatchCommand(
      request.method,
      params.data as Record<string, unknown>,
      commandContext,
    )
    sendResponse(request.id, result)
  } catch (error) {
    if (error instanceof CommandError) {
      sendError(request.id, -32000, error.message, {
        code: error.code,
        message: error.message,
      })
      return
    }
    sendError(request.id, -32000, 'internal error', {
      code: 'internal',
      message: error instanceof Error ? error.message : String(error),
    })
  }
}

write({
  jsonrpc: '2.0',
  method: 'runtime.ready',
  params: {
    protocolVersion: PROTOCOL_VERSION,
    runtimeVersion: RUNTIME_VERSION,
    capabilities: ['chat'],
  },
})

const input = createInterface({ input: process.stdin })
input.on('line', (line) => {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    sendError(null, -32700, 'Parse error')
    return
  }

  const parsed = JsonRpcMessageSchema.safeParse(value)
  if (!parsed.success) {
    sendError(null, -32600, 'Invalid Request')
    return
  }

  const message = parsed.data
  if ('method' in message && 'id' in message) {
    handleRequest(message)
    return
  }

  process.stderr.write(
    `[runtime] ignored ${'method' in message ? 'notification' : 'response'}\n`,
  )
})
