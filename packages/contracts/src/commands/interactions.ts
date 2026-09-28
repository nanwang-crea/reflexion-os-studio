import { z } from 'zod'
import {
  UserInteractionResponseSchema,
  UserInteractionSchema,
} from '../interactions.js'
import { RequestIdSchema } from './params.js'

export const interactionsCommands = {
  'interaction.respond': {
    params: UserInteractionResponseSchema.extend({
      requestId: RequestIdSchema,
    }),
    result: z.object({ accepted: z.boolean() }),
  },
  'interaction.list_pending': {
    params: z.object({ requestId: RequestIdSchema }),
    result: z.object({ interactions: z.array(UserInteractionSchema) }),
  },
  // ---------- 权限模型 V2：高级审批覆盖项与 Danger 会话租约 ----------
  // 覆盖项仅当前会话内存生效、不持久化；Runtime 是唯一真源。
}
