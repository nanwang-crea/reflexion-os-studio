import { z } from 'zod'
import { MutationReceiptSchema } from '../entities.js'
import { RequestIdSchema } from './params.js'

export const mutationReceiptCommands = {
  'mutation_receipt.list': {
    params: z.object({
      requestId: RequestIdSchema,
      rootRunId: z.string().min(1),
    }),
    result: z.object({ receipts: z.array(MutationReceiptSchema) }),
  },
}
