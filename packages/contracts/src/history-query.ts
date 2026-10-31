import { z } from 'zod'

export const HistoryQueryInputSchema = z.strictObject({
  sql: z
    .string()
    .trim()
    .min(1)
    .max(4000)
    .optional()
    .describe('只读 SELECT 查询；省略时返回可查询的历史表结构'),
  params: z
    .array(z.union([z.string(), z.number(), z.null()]))
    .max(50)
    .default([])
    .describe('SQL 中 ? 占位符的绑定值'),
  scope: z
    .enum(['current_session', 'project'])
    .default('current_session')
    .describe('默认当前会话；未命中后可扩大到当前项目'),
})

export const historyQueryParameters = z.toJSONSchema(HistoryQueryInputSchema, {
  io: 'input',
})
export type HistoryQueryInput = z.infer<typeof HistoryQueryInputSchema>
