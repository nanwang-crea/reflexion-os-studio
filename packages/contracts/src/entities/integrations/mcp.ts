import { z } from 'zod'
import { IsoDateTimeSchema } from '../shared.js'
import { JsonValueSchema } from '../../json-value.js'

/** MCP server 配置与运行状态(enabled 开关;tools 为最新一次握手结果)。 */
export const McpServerSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  command: z.string().min(1),
  args: z.array(z.string()),
  // 环境变量只返回 secretRef，不返回明文 value。
  env: z.array(
    z.object({
      key: z.string().min(1),
      secretRef: z.string().min(1),
    }),
  ),
  enabled: z.boolean(),
  /** 当前可用工具;未就绪为 []。 */
  toolCount: z.number().int().nonnegative(),
  status: z.enum(['disabled', 'ready', 'failed']),
  lastError: z.string().nullable(),
  updatedAt: IsoDateTimeSchema,
})
export type McpServer = z.infer<typeof McpServerSchema>

/** MCP 工具在协议层的声明(含来源 server,便于 UI 呈现)。 */
export const McpToolSchema = z.object({
  serverId: z.string().min(1),
  name: z.string().min(1),
  description: z.string().default(''),
  inputSchema: JsonValueSchema,
})
export type McpTool = z.infer<typeof McpToolSchema>
