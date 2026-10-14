import { z } from 'zod'
import {
  WorkflowDefinitionSchema,
  WorkflowNodeSchema,
  WorkflowEdgeSchema,
  WorkflowBindingSchema,
} from './definition.js'
import { WorkflowValidationResultSchema } from './execution.js'
import { WorkflowDefinitionInputSchema } from './values.js'

export const WorkflowDraftSchema = z.strictObject({
  id: z.string().min(1),
  projectId: z.string().min(1),
  revision: z.number().int().positive(),
  definitionId: z.string().min(1).nullable(),
  baseVersion: z.number().int().nonnegative(),
  definition: WorkflowDefinitionSchema,
  generationId: z.string().min(1).nullable(),
  updatedAt: z.iso.datetime(),
})
export type WorkflowDraft = z.infer<typeof WorkflowDraftSchema>

export const WorkflowNodeProposalSchema = WorkflowDefinitionInputSchema.pipe(
  z.strictObject({
    node: WorkflowNodeSchema,
    edges: z.array(WorkflowEdgeSchema).max(64),
    bindings: z.array(WorkflowBindingSchema).max(32),
    outputs: z
      .array(WorkflowDefinitionSchema.out.shape.outputs.element)
      .min(1)
      .max(32),
  }),
)

export const WorkflowGenerationStatusSchema = z.enum([
  'running',
  'ready',
  'invalid',
  'cancelled',
  'interrupted',
  'failed',
  'applied',
])
export const WorkflowGenerationSchema = z.strictObject({
  id: z.string().min(1),
  stateVersion: z.number().int().nonnegative().default(0),
  projectId: z.string().min(1),
  draftId: z.string().min(1),
  baseRevision: z.number().int().positive(),
  mode: z.enum(['graph', 'node']),
  description: z.string().min(1).max(8000),
  providerId: z.string().min(1),
  model: z.string().min(1),
  status: WorkflowGenerationStatusSchema,
  runIds: z.array(z.string().min(1)).max(3),
  sessionId: z.string().min(1).nullable(),
  candidate: WorkflowDefinitionSchema.nullable(),
  validation: WorkflowValidationResultSchema.nullable(),
  tokensUsed: z.number().int().nonnegative(),
  tokensEstimated: z.boolean(),
  errorCode: z.string().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
})
export type WorkflowGeneration = z.infer<typeof WorkflowGenerationSchema>
