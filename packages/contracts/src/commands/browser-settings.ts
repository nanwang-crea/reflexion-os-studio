import { BrowserSettingsSchema } from '../browser-settings.js'
import { RequestIdSchema } from './params.js'
import { z } from 'zod'

export const browserSettingsCommands = {
  'browser_settings.get': {
    params: z.object({ requestId: RequestIdSchema }),
    result: z.object({ settings: BrowserSettingsSchema }),
  },
  'browser_settings.update': {
    params: z.object({
      requestId: RequestIdSchema,
      settings: BrowserSettingsSchema,
    }),
    result: z.object({ settings: BrowserSettingsSchema }),
  },
}
