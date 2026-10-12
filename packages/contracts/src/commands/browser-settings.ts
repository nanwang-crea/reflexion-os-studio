import { BrowserSettingsSchema } from '../browser-settings.js'
import { RequestIdSchema } from './params.js'
import { z } from 'zod'
import {
  BrowserContactSchema,
  BrowserVisitSchema,
  BrowserOriginSchema,
} from '../browser/data.js'

export const browserSettingsCommands = {
  'browser_history.list': {
    params: z.object({
      requestId: RequestIdSchema,
      query: z.string().max(500).default(''),
      limit: z.number().int().min(1).max(200).default(100),
      before: z.number().int().nonnegative().optional(),
    }),
    result: z.object({ visits: z.array(BrowserVisitSchema) }),
  },
  'browser_history.record': {
    params: z.object({
      requestId: RequestIdSchema,
      url: BrowserVisitSchema.shape.url,
      title: z.string().max(500),
    }),
    result: z.object({ recorded: z.boolean() }),
  },
  'browser_history.clear': {
    params: z.object({
      requestId: RequestIdSchema,
      origin: BrowserOriginSchema.optional(),
    }),
    result: z.object({ removed: z.number().int().nonnegative() }),
  },
  'browser_contacts.list': {
    params: z.object({ requestId: RequestIdSchema }),
    result: z.object({ contacts: z.array(BrowserContactSchema) }),
  },
  'browser_contacts.save': {
    params: z.object({
      requestId: RequestIdSchema,
      contact: BrowserContactSchema,
    }),
    result: z.object({ contact: BrowserContactSchema }),
  },
  'browser_contacts.delete': {
    params: z.object({ requestId: RequestIdSchema, id: z.string().min(1) }),
    result: z.object({ removed: z.boolean() }),
  },
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
