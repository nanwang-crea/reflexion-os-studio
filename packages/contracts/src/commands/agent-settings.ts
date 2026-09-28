import { z } from 'zod'
import { AgentSettingsSchema } from '../entities.js'
import { RequestIdSchema } from './params.js'

export const agentSettingsCommands = {
  'agent_settings.get': {
    params: z.object({ requestId: RequestIdSchema }),
    result: z.object({ settings: AgentSettingsSchema }),
  },
  'agent_settings.update': {
    // 全量覆盖:未提供的字段置 null(回默认),前端草稿整体提交。
    params: z.object({
      requestId: RequestIdSchema,
      settings: AgentSettingsSchema,
    }),
    result: z.object({ settings: AgentSettingsSchema }),
  },
}
