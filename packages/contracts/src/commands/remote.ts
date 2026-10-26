import { z } from 'zod'
import { RemoteStatusSchema, RemoteCatalogSchema } from '../remote-access.js'
import { RequestIdSchema } from './params.js'
const request = z.object({ requestId: RequestIdSchema })
export const remoteCommands = {
  'remote.catalog': { params: request, result: RemoteCatalogSchema },
  'remote.status': {
    params: request,
    result: RemoteStatusSchema,
    RemoteCatalogSchema,
  },
  'remote.start': {
    params: request.extend({
      address: z.string().min(1).max(64),
    }),
    result: RemoteStatusSchema,
  },
  'remote.invite': {
    params: request,
    result: RemoteStatusSchema,
    RemoteCatalogSchema,
  },
  'remote.stop': { params: request, result: z.object({ ok: z.boolean() }) },
  'remote.device.resolve': {
    params: request.extend({
      deviceId: z.string().min(1),
      approved: z.boolean(),
    }),
    result: z.object({ accepted: z.boolean() }),
  },
  'remote.device.revoke': {
    params: request.extend({ deviceId: z.string().min(1) }),
    result: z.object({ removed: z.boolean() }),
  },
}
