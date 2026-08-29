import { createInterface } from 'node:readline'
import {
  PROTOCOL_VERSION,
  type JsonRpcMessage,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from '@reflexion-os-studio/contracts'

const RUNTIME_VERSION = '0.1.0'
let rustAvailable = false

function write(message: JsonRpcMessage): void {
  const line = `${JSON.stringify(message)}\n`
  process.stdout.write(line)
}

function sendResponse(id: string | number, result: unknown): void {
  const message: JsonRpcResponse = {
    jsonrpc: '2.0',
    id,
    result,
  }
  write(message)
}

function sendError(
  id: string | number | null,
  code: number,
  message: string,
): void {
  write({
    jsonrpc: '2.0',
    id,
    error: { code, message },
  })
}

function getStatus(): object {
  return {
    state: 'ready',
    protocolVersion: PROTOCOL_VERSION,
    runtimeVersion: RUNTIME_VERSION,
    capabilities: ['chat'],
    chatAvailable: true,
    systemAvailable: rustAvailable,
  }
}

function handleRequest(request: JsonRpcRequest): void {
  switch (request.method) {
    case 'runtime.get_status':
      sendResponse(request.id, getStatus())
      return
    case 'system.status':
      rustAvailable = Boolean(
        (request.params as { available?: boolean } | undefined)?.available,
      )
      sendResponse(request.id, { available: rustAvailable })
      return
    case 'runtime.shutdown':
      sendResponse(request.id, { ok: true })
      process.exit(0)
    default:
      sendError(request.id, -32601, `Method not found: ${request.method}`)
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
  try {
    const message = JSON.parse(line) as JsonRpcMessage
    if ('method' in message && 'id' in message) {
      handleRequest(message as JsonRpcRequest)
    }
  } catch {
    sendError(null, -32700, 'Parse error')
  }
})
