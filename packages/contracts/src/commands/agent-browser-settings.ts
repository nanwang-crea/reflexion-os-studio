import { z } from 'zod'
import {
  AgentBrowserSettingsSchema,
  AgentBrowserRuntimeSchema,
} from '../browser/agent-settings.js'
import { RequestIdSchema } from './params.js'

export const agentBrowserSettingsCommands = {
  'agent_browser_runtime.status': {
    params: z.strictObject({ requestId: RequestIdSchema }),
    result: z.strictObject({ runtime: AgentBrowserRuntimeSchema }),
  },
  'agent_browser_runtime.install': {
    params: z.strictObject({ requestId: RequestIdSchema }),
    result: z.strictObject({ runtime: AgentBrowserRuntimeSchema }),
  },
  'agent_browser_runtime.cancel': {
    params: z.strictObject({ requestId: RequestIdSchema }),
    result: z.strictObject({ runtime: AgentBrowserRuntimeSchema }),
  },
  'agent_browser_settings.get': {
    params: z.strictObject({ requestId: RequestIdSchema }),
    result: z.strictObject({
      settings: AgentBrowserSettingsSchema,
    }),
  },
  'agent_browser_settings.update': {
    params: z.strictObject({
      requestId: RequestIdSchema,
      settings: AgentBrowserSettingsSchema,
    }),
    result: z.strictObject({
      settings: AgentBrowserSettingsSchema,
    }),
  },
}
