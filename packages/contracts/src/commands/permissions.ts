import { z } from 'zod'
import {
  DangerAccessLeaseSchema,
  DangerCapabilitySchema,
} from '../permissions.js'
import { RequestIdSchema, ApprovalResolveParamsSchema } from './params.js'

export const permissionsCommands = {
  'approval.resolve': {
    params: ApprovalResolveParamsSchema,
    // accepted=false 表示该调用不在等待审批（已解决/已取消）。
    result: z.object({ accepted: z.boolean() }),
  },
  'danger.prepare': {
    params: z.object({
      requestId: RequestIdSchema,
      sessionId: z.string().min(1),
    }),
    result: z.object({
      challengeId: z.string().min(1),
      expiresAt: z.number().int().nonnegative(),
      warning: z.string(),
      capability: DangerCapabilitySchema,
    }),
  },
  'danger.enable': {
    params: z.object({
      requestId: RequestIdSchema,
      challengeId: z.string().min(1),
      acceptedRisk: z.literal(true),
    }),
    result: z.object({ lease: DangerAccessLeaseSchema }),
  },
  'danger.disable': {
    params: z.object({
      requestId: RequestIdSchema,
      sessionId: z.string().min(1),
    }),
    result: z.object({ disabled: z.boolean() }),
  },
  // 前端重挂/重载后与 Runtime 对齐 lease 状态（Runtime 是唯一真源）。
  'danger.status': {
    params: z.object({
      requestId: RequestIdSchema,
      sessionId: z.string().min(1),
    }),
    result: z.object({ lease: DangerAccessLeaseSchema.nullable() }),
  },
}
