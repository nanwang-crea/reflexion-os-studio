import { z } from 'zod'

/** On-demand access to persisted delegation traces, never arbitrary sessions. */
export const TaskInspectInputSchema = z.strictObject({
  delegationId: z
    .string()
    .min(1)
    .optional()
    .describe('省略时列出可见委派；指定时读取该委派轨迹'),
  offset: z
    .number()
    .int()
    .nonnegative()
    .default(0)
    .describe('列表或轨迹的起始条目偏移'),
  limit: z.number().int().min(1).max(5).default(5),
  textOffset: z
    .number()
    .int()
    .nonnegative()
    .default(0)
    .describe('每条记录正文的字符偏移；配合 limit=1 读取长记录'),
  textLength: z.number().int().min(1).max(2000).default(1000),
})
export const taskInspectParameters = z.toJSONSchema(TaskInspectInputSchema, {
  io: 'input',
})
export type TaskInspectInput = z.infer<typeof TaskInspectInputSchema>
