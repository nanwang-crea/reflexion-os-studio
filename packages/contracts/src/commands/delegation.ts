import { z } from 'zod'
import { DelegationSchema } from '../entities.js'
import { RequestIdSchema } from './params.js'

export const delegationCommands = {
  'delegation.list': {
    params: z.object({
      requestId: RequestIdSchema,
      sessionId: z.string().min(1),
    }),
    result: z.object({ delegations: z.array(DelegationSchema) }),
  },
  'delegation.create': {
    params: z.object({
      requestId: RequestIdSchema,
      sessionId: z.string().min(1),
      parentRunId: z.string().min(1),
      agentId: z.string().min(1),
      task: z.string().min(1),
    }),
    result: z.object({ delegation: DelegationSchema }),
  },
  'delegation.list_by_parent': {
    params: z.object({
      requestId: RequestIdSchema,
      parentRunId: z.string().min(1),
    }),
    result: z.object({ delegations: z.array(DelegationSchema) }),
  },
  'delegation.tree': {
    params: z.object({
      requestId: RequestIdSchema,
      rootRunId: z.string().min(1),
    }),
    result: z.object({ delegations: z.array(DelegationSchema) }),
  },
  'delegation.get_by_child_run': {
    params: z.object({
      requestId: RequestIdSchema,
      childRunId: z.string().min(1),
    }),
    result: z.object({ delegation: DelegationSchema.nullable() }),
  },
  'delegation.cancel': {
    params: z.object({
      requestId: RequestIdSchema,
      delegationId: z.string().min(1),
    }),
    result: z.object({ accepted: z.boolean() }),
  },
  'delegation.attach_child_run': {
    params: z.object({
      requestId: RequestIdSchema,
      delegationId: z.string().min(1),
      childRunId: z.string().min(1),
    }),
    result: z.object({ delegation: DelegationSchema }),
  },
  'delegation.update': {
    params: z.object({
      requestId: RequestIdSchema,
      delegationId: z.string().min(1),
      status: z.enum([
        'pending',
        'running',
        'completed',
        'failed',
        'cancelled',
      ]),
      result: z.string().nullable().optional(),
      error: z.string().nullable().optional(),
    }),
    result: z.object({ delegation: DelegationSchema }),
  },
}
