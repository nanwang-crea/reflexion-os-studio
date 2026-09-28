import { z } from 'zod'
import { PluginRecordSchema } from '../entities.js'
import { PluginTaskSchema } from '../plugins.js'
import { RequestIdSchema, PluginInstallParamsSchema } from './params.js'

export const pluginCommands = {
  'plugin.list': {
    params: z.object({ requestId: RequestIdSchema }),
    result: z.object({ plugins: z.array(PluginRecordSchema) }),
  },
  'plugin.install': {
    params: PluginInstallParamsSchema,
    result: z.object({ task: PluginTaskSchema }),
  },
  'plugin.preview': {
    params: PluginInstallParamsSchema,
    result: z.object({ task: PluginTaskSchema }),
  },
  'plugin.update': {
    params: z.object({ requestId: RequestIdSchema, id: z.string().min(1) }),
    result: z.object({ task: PluginTaskSchema }),
  },
  'plugin.task.list': {
    params: z.object({ requestId: RequestIdSchema }),
    result: z.object({ tasks: z.array(PluginTaskSchema) }),
  },
  'plugin.task.cancel': {
    params: z.object({ requestId: RequestIdSchema, taskId: z.uuid() }),
    result: z.object({ task: PluginTaskSchema }),
  },
  'plugin.toggle': {
    params: z.object({
      requestId: RequestIdSchema,
      id: z.string().min(1),
      enabled: z.boolean(),
    }),
    result: z.object({ plugin: PluginRecordSchema }),
  },
  'plugin.uninstall': {
    params: z.object({ requestId: RequestIdSchema, id: z.string().min(1) }),
    result: z.object({ removed: z.boolean() }),
  },
  'plugin.rescan': {
    params: z.object({ requestId: RequestIdSchema }),
    result: z.object({ plugins: z.array(PluginRecordSchema) }),
  },
  // ---------- Phase 1B：Workspace Surface ----------
}
