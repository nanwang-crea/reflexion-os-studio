import { z } from 'zod'
import { RequestIdSchema } from './params.js'
import { SessionSchema } from '../entities.js'
export const chatArchiveCommands = {
  'session.archive.export': {
    params: z.strictObject({
      requestId: RequestIdSchema,
      sessionId: z.string().min(1),
      directory: z.string().min(1),
    }),
    result: z.object({
      path: z.string(),
      messageCount: z.number().int().nonnegative(),
    }),
  },
  'session.archive.import': {
    params: z
      .strictObject({
        requestId: RequestIdSchema,
        path: z.string().min(1),
        projectId: z.string().min(1).nullable().optional(),
        folderPath: z.string().min(1).optional(),
      })
      .refine(
        (value) => !(value.projectId && value.folderPath),
        '请选择项目或目录，不能同时指定',
      ),
    result: z.object({
      session: SessionSchema,
      messageCount: z.number().int().nonnegative(),
    }),
  },
}

export type ChatArchiveImportParams = z.infer<
  (typeof chatArchiveCommands)['session.archive.import']['params']
>
