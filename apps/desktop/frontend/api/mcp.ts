import type { McpServer, McpTool } from '@reflexion-os-studio/runtime-client'
import { request, requestList } from './client'

export function listMcp(): Promise<{
  servers: McpServer[]
  tools: McpTool[]
}> {
  return requestList<{ servers: McpServer[]; tools: McpTool[] }>('mcp.list')
}

export function addMcp(input: {
  name: string
  command: string
  args: string[]
  env: { key: string; value: string }[]
}): Promise<{ server: McpServer }> {
  return request<{ server: McpServer }>('mcp.add', input)
}

export function removeMcp(serverId: string): Promise<{ removed: boolean }> {
  return request<{ removed: boolean }>('mcp.remove', { serverId })
}

export function toggleMcp(
  serverId: string,
): Promise<{ server: McpServer | null }> {
  return request<{ server: McpServer | null }>('mcp.toggle', { serverId })
}

export function reloadMcp(): Promise<{ servers: McpServer[] }> {
  return request<{ servers: McpServer[] }>('mcp.reload', {})
}
