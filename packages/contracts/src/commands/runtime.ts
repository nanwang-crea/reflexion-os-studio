import { z } from 'zod'
import { RuntimeStatusSchema } from '../handshake.js'
import { RequestIdSchema } from './params.js'

export const runtimeCommands = {
  'runtime.get_status': {
    params: z.object({ requestId: RequestIdSchema }),
    result: RuntimeStatusSchema,
  },
}
