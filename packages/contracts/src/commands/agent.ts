import { z } from 'zod'
import { AgentDefinitionSchema } from '../entities.js'
import { RequestIdSchema } from './params.js'

export const agentCommands = {
  'agent.list': {
    params: z.object({ requestId: RequestIdSchema }),
    result: z.object({ agents: z.array(AgentDefinitionSchema) }),
  },
  'agent.set_enabled': {
    params: z.object({
      requestId: RequestIdSchema,
      agentId: z.string().min(1),
      enabled: z.boolean(),
    }),
    result: z.object({ agent: AgentDefinitionSchema }),
  },
}
