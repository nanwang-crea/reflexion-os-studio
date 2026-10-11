import { z } from 'zod'

export const ReasoningEffortSchema = z.enum(['low', 'medium', 'high'])
export type ReasoningEffort = z.infer<typeof ReasoningEffortSchema>
