import { z } from 'zod'
import {
  DeveloperFilterSchema,
  DeveloperPageSchema,
  DeveloperOverviewSchema,
  DeveloperRunListParamsSchema,
  DeveloperRunPageSchema,
  DeveloperRunDetailSchema,
  DeveloperToolListParamsSchema,
  DeveloperToolPageSchema,
  DeveloperToolDetailSchema,
  DeveloperModelPageSchema,
  DeveloperAttemptPageSchema,
} from '../developer.js'
import { RequestIdSchema } from './params.js'

const request = { requestId: RequestIdSchema }
export const developerCommands = {
  'developer.overview': {
    params: DeveloperFilterSchema.extend(request),
    result: DeveloperOverviewSchema,
  },
  'developer.runs.list': {
    params: DeveloperRunListParamsSchema.extend(request),
    result: DeveloperRunPageSchema,
  },
  'developer.run.get': {
    params: z.object({ ...request, runId: z.string().min(1) }),
    result: z.object({ detail: DeveloperRunDetailSchema.nullable() }),
  },
  'developer.tools.list': {
    params: DeveloperToolListParamsSchema.extend(request),
    result: DeveloperToolPageSchema,
  },
  'developer.tool.get': {
    params: z.object({ ...request, toolCallId: z.string().min(1) }),
    result: z.object({ detail: DeveloperToolDetailSchema.nullable() }),
  },
  'developer.models.list': {
    params: DeveloperFilterSchema.extend({
      ...request,
      ...DeveloperPageSchema.shape,
      runId: z.string().optional(),
    }),
    result: DeveloperModelPageSchema,
  },
  'developer.attempts.list': {
    params: z.object({
      ...request,
      ...DeveloperPageSchema.shape,
      messageId: z.string().min(1),
    }),
    result: DeveloperAttemptPageSchema,
  },
}
