import type { McpServer, McpTool } from '@reflexion-os-studio/runtime-client'
import { request, requestList } from './client'

export function listMcp(): Promise<{
  servers: McpServer[]
  tools: McpTool[]
}> {
  return requestList<{ servers: McpServer[]; tools: McpTool[] }>('mcp.list')
}

// 与 contracts 的 mcp.add 契约一致：环境变量只接受 secret（一次明文）或既有
// secretRef 之一，不声明 value 明文；UI 当前固定传空数组。
export function addMcp(input: {
  name: string
  command: string
  args: string[]
  env: { key: string; secret?: string; secretRef?: string }[]
}): Promise<{ server: McpServer }> {
  return request<{ server: McpServer }>('mcp.add', input)
}

export function removeMcp(serverId: string): Promise<{ removed: boolean }> {
  return request<{ removed: boolean }>('mcp.remove', { serverId })
}

export function toggleMcp(serverId: string): Promise<{ server: McpServer }> {
  return request<{ server: McpServer }>('mcp.toggle', { serverId })
}

export function reloadMcp(): Promise<{ servers: McpServer[] }> {
  return request<{ servers: McpServer[] }>('mcp.reload', {})
}
