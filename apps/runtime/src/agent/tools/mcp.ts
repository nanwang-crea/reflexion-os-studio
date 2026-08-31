import type { ToolDefinition } from '@reflexion-os-studio/agent-core'
import type { McpManager } from '../../mcp/manager.js'
import { argsRecord } from './shared.js'

/**
 * MCP 工具桥:协议层的工具名带 serverId 前缀(serverId/toolName),
 * 执行时拆回两段转交 McpManager;失败折叠为错误结果回传模型。
 * 权限:非内置操作,PermissionGate 对未知工具走 ask(默认审批)。
 */
export function createMcpTool(
  manager: McpManager,
  serverId: string,
  spec: { name: string; description: string; parameters: unknown },
): ToolDefinition {
  const providerName = spec.name
  return {
    name: `${serverId}/${providerName}`,
    description: spec.description,
    parameters: spec.parameters as ToolDefinition['parameters'],
    execute: async ({ args, signal }) => {
      try {
        const result = await manager.callTool(
          serverId,
          providerName,
          argsRecord(args),
        )
        if (signal.aborted) {
          throw new DOMException('The operation was aborted.', 'AbortError')
        }
        return { content: result.content, isError: result.isError }
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') throw error
        return {
          content: `MCP 工具调用失败: ${error instanceof Error ? error.message : String(error)}`,
          isError: true,
          code: 'tool_error',
        }
      }
    },
  }
}
