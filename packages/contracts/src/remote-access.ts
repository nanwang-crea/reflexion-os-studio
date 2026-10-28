import { z } from 'zod'
import { RuntimeEventSchema } from './events.js'
import { DangerAccessLeaseSchema } from './permissions.js'
import { SessionHistorySchema } from './session-history.js'

export const RemoteDeviceSchema = z.object({
  id: z.string(),
  name: z.string(),
  verificationCode: z.string(),
  approved: z.boolean(),
  expiresAt: z.iso.datetime(),
})
export const RemoteStatusSchema = z.object({
  running: z.boolean(),
  accessScope: z.literal('all_sessions'),
  origin: z.string().nullable(),
  addresses: z.array(z.string()),
  fingerprint: z.string().nullable(),
  invitationUrl: z.string().nullable(),
  invitationExpiresAt: z.iso.datetime().nullable(),
  devices: z.array(RemoteDeviceSchema),
})
export const RemotePairRequestSchema = z
  .object({
    invitation: z.string().min(32).max(128),
    name: z.string().trim().min(1).max(80),
  })
  .strict()
export const RemotePairStateSchema = z.object({
  device: RemoteDeviceSchema,
  accessScope: z.literal('all_sessions'),
})
export const RemoteStreamPacketSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('snapshot'),
    history: SessionHistorySchema,
    dangerLease: DangerAccessLeaseSchema.nullable(),
    events: z.array(RuntimeEventSchema),
    incomplete: z.boolean(),
  }),
  z.object({ type: z.literal('event'), event: RuntimeEventSchema }),
])
export type RemoteStatus = z.infer<typeof RemoteStatusSchema>
export type RemoteDevice = z.infer<typeof RemoteDeviceSchema>
export type RemoteStreamPacket = z.infer<typeof RemoteStreamPacketSchema>

export const RemoteCatalogSchema = z.object({
  projects: z.array(
    z.object({
      id: z.string().min(1),
      name: z.string().min(1),
    }),
  ),
  models: z.array(
    z.object({
      providerId: z.string(),
      providerName: z.string(),
      model: z.string(),
    }),
  ),
})

export type RemoteCatalog = z.infer<typeof RemoteCatalogSchema>
