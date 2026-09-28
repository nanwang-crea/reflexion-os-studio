import { z } from 'zod'
import { McpServerSchema, McpToolSchema } from '../entities.js'
import { RequestIdSchema } from './params.js'

export const mcpCommands = {
  'mcp.list': {
    params: z.object({ requestId: RequestIdSchema }),
    result: z.object({
      servers: z.array(McpServerSchema),
      tools: z.array(McpToolSchema),
    }),
  },
  'mcp.add': {
    params: z.object({
      requestId: RequestIdSchema,
      name: z.string().min(1),
      command: z.string().min(1),
      args: z.array(z.string()),
      env: z.array(
        z
          .object({
            key: z.string().min(1),
            secret: z.string().optional(),
            secretRef: z.string().min(1).optional(),
          })
          .refine(
            (entry) =>
              entry.secret !== undefined || entry.secretRef !== undefined,
            {
              message: 'env entry requires secret or secretRef',
            },
          ),
      ),
    }),
    result: z.object({ server: McpServerSchema }),
  },
  'mcp.remove': {
    params: z.object({
      requestId: RequestIdSchema,
      serverId: z.string().min(1),
    }),
    result: z.object({ removed: z.boolean() }),
  },
  'mcp.toggle': {
    params: z.object({
      requestId: RequestIdSchema,
      serverId: z.string().min(1),
    }),
    result: z.object({ server: McpServerSchema }),
  },
  'mcp.reload': {
    // 重新握手全部已启用的 server(配置变更/修复失败后手动重连)。
    params: z.object({ requestId: RequestIdSchema }),
    result: z.object({ servers: z.array(McpServerSchema) }),
  },
}
