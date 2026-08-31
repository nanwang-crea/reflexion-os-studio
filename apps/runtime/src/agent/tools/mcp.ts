import type { ToolDefinition } from '@reflexion-os-studio/agent-core'
import type { McpManager } from '../../mcp/manager.js'
import { argsRecord } from './shared.js'

/**
 * MCP 工具桥:注册名与协议声明名一致(serverId/toolName,前缀只在声明处拼一次),
 * 执行时用服务器原始 toolName 转交 McpManager;失败折叠为错误结果回传模型。
 * 权限:非内置操作,PermissionGate 对未知工具走 ask(默认审批)。
 */
export function createMcpTool(
  manager: McpManager,
  serverId: string,
  toolName: string,
  spec: { description: string; parameters: unknown },
): ToolDefinition {
  return {
    name: `${serverId}/${toolName}`,
    description: spec.description,
    parameters: spec.parameters as ToolDefinition['parameters'],
    execute: async ({ args, signal }) => {
      try {
        const result = await manager.callTool(
          serverId,
          toolName,
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
