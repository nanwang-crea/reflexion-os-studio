import { z } from 'zod'
import { RequestIdSchema } from './params.js'

export const instructionsCommands = {
  'instructions.get': {
    // 指令页读取单个文件；path 为 null 表示当前条件下没有该文件位置。
    params: z.object({
      requestId: RequestIdSchema,
      scope: z.enum(['global', 'project']),
      projectId: z.string().min(1).optional(),
      kind: z.enum(['agents', 'memory']),
    }),
    result: z.object({
      path: z.string().nullable(),
      content: z.string(),
    }),
  },
  'instructions.save': {
    // 指令页保存（原子替换）；项目级 AGENTS.md 会写入用户仓库根。
    params: z.object({
      requestId: RequestIdSchema,
      scope: z.enum(['global', 'project']),
      projectId: z.string().min(1).optional(),
      kind: z.enum(['agents', 'memory']),
      content: z.string(),
    }),
    result: z.object({ ok: z.boolean(), message: z.string() }),
  },
}
