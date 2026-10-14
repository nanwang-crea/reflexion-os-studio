import { z } from 'zod'
import { RequestIdSchema } from './params.js'
import {
  WorkflowDefinitionSchema,
  WorkflowDraftSchema,
  WorkflowGenerationSchema,
} from '../workflow/index.js'

const project = { projectId: z.string().min(1) }
const request = { requestId: RequestIdSchema }
const generation = { ...project, generationId: z.string().min(1) }
export const workflowAuthoringCommands = {
  'workflow.draft.list': {
    params: z.strictObject(project),
    result: z.strictObject({ drafts: z.array(WorkflowDraftSchema) }),
  },
  'workflow.draft.save': {
    params: z.strictObject({
      ...project,
      ...request,
      draftId: z.string().min(1).optional(),
      baseRevision: z.number().int().nonnegative(),
      definitionId: z.string().min(1).nullable(),
      baseVersion: z.number().int().nonnegative(),
      definition: WorkflowDefinitionSchema,
    }),
    result: z.strictObject({ draft: WorkflowDraftSchema }),
  },
  'workflow.generate': {
    params: z.strictObject({
      ...project,
      ...request,
      draftId: z.string().min(1),
      baseRevision: z.number().int().positive(),
      mode: z.enum(['graph', 'node']),
      description: z.string().min(1).max(8000),
      providerId: z.string().min(1),
      model: z.string().min(1).max(200),
    }),
    result: z.strictObject({ generation: WorkflowGenerationSchema }),
  },
  'workflow.get_generation': {
    params: z.strictObject(generation),
    result: z.strictObject({ generation: WorkflowGenerationSchema }),
  },
  'workflow.generations.list': {
    params: z.strictObject({ ...project, draftId: z.string().min(1) }),
    result: z.strictObject({
      generations: z.array(WorkflowGenerationSchema).max(10),
    }),
  },
  'workflow.cancel_generation': {
    params: z.strictObject({ ...generation, ...request }),
    result: z.strictObject({ generation: WorkflowGenerationSchema }),
  },
  'workflow.apply_generation': {
    params: z.strictObject({
      ...generation,
      ...request,
      stateVersion: z.number().int().nonnegative(),
    }),
    result: z.strictObject({ draft: WorkflowDraftSchema }),
  },
  'workflow.edit_generation': {
    params: z.strictObject({
      ...generation,
      ...request,
      stateVersion: z.number().int().nonnegative(),
      definition: WorkflowDefinitionSchema,
    }),
    result: z.strictObject({ generation: WorkflowGenerationSchema }),
  },
}
