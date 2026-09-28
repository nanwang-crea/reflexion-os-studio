import { z } from 'zod'
import { ApprovalOverrideSchema } from '../entities.js'
import { RequestIdSchema } from './params.js'

export const permissionCommands = {
  'permission.approval_override.set': {
    params: z.object({
      requestId: RequestIdSchema,
      sessionId: z.string().min(1),
      override: ApprovalOverrideSchema,
    }),
    result: z.object({ override: ApprovalOverrideSchema }),
  },
  'permission.approval_override.get': {
    params: z.object({
      requestId: RequestIdSchema,
      sessionId: z.string().min(1),
    }),
    result: z.object({ override: ApprovalOverrideSchema }),
  },
  // 两段式确认：prepare 签发单次消费的 challenge（≤60s、绑定 sessionId），
  // enable 必须携带 acceptedRisk=true 且通过平台 capability 校验。
}
