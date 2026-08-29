export const PROTOCOL_VERSION = '1.0'

export type Capability = 'chat' | 'system.bootstrap'

export type SidecarState =
  'starting' | 'ready' | 'unavailable' | 'stopped' | 'error'

export interface ReadyParams {
  protocolVersion: string
  runtimeVersion: string
  capabilities: Capability[]
}

export interface RuntimeStatus {
  state: SidecarState
  protocolVersion: string
  runtimeVersion: string
  capabilities: Capability[]
  chatAvailable: boolean
  systemAvailable: boolean
  error?: {
    code: string
    message: string
  }
}

export interface JsonRpcRequest {
  jsonrpc: '2.0'
  id: string | number
  method: string
  params?: unknown
}

export interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: string | number | null
  result?: unknown
  error?: {
    code: number
    message: string
    data?: unknown
  }
}

export interface JsonRpcNotification {
  jsonrpc: '2.0'
  method: string
  params?: unknown
}

export type JsonRpcMessage =
  JsonRpcRequest | JsonRpcResponse | JsonRpcNotification
