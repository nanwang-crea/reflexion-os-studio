import { z } from 'zod'

export const IsoDateTimeSchema = z.iso.datetime()
export type IsoDateTime = z.infer<typeof IsoDateTimeSchema>
