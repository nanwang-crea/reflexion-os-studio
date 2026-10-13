import { z } from 'zod'
import { RequestIdSchema } from './params.js'
import {
  WorkflowDefinitionSchema,
  WorkflowVersionSchema,
  WorkflowRunDetailSchema,
  WorkflowRunSummarySchema,
  WorkflowValuesSchema,
  WorkflowModelBindingSchema,
  WorkflowValidationResultSchema,
} from '../workflow/index.js'
import {
  PermissionPresetSchema,
  ApprovalOverrideSchema,
} from '../entities/tools/permissions.js'

const project = { projectId: z.string().min(1) }
const request = { requestId: RequestIdSchema }
const target = { ...project, runId: z.string().min(1) }
const resume = {
  ...request,
  ...target,
  stateVersion: z.number().int().nonnegative(),
  acknowledgedAttemptIds: z.array(z.string().min(1)).max(128),
}
const detail = z.strictObject({ detail: WorkflowRunDetailSchema })
export const workflowCommands = {
  'workflow.validate': {
    params: z.strictObject({ definition: WorkflowDefinitionSchema }),
    result: WorkflowValidationResultSchema,
  },
  'workflow.list': {
    params: z.strictObject(project),
    result: z.strictObject({ versions: z.array(WorkflowVersionSchema) }),
  },
  'workflow.get': {
    params: z.strictObject({
      ...project,
      definitionId: z.string().min(1),
      revision: z.number().int().positive().optional(),
    }),
    result: z.strictObject({ version: WorkflowVersionSchema.nullable() }),
  },
  'workflow.save': {
    params: z.strictObject({
      ...project,
      ...request,
      definitionId: z.string().min(1).optional(),
      baseRevision: z.number().int().nonnegative(),
      definition: WorkflowDefinitionSchema,
    }),
    result: z.strictObject({ version: WorkflowVersionSchema }),
  },
  'workflow.archive': {
    params: z.strictObject({
      ...project,
      ...request,
      definitionId: z.string().min(1),
      baseRevision: z.number().int().positive(),
    }),
    result: z.strictObject({ archived: z.boolean() }),
  },
  'workflow.run.start': {
    params: z.strictObject({
      ...project,
      ...request,
      definitionId: z.string().min(1),
      revision: z.number().int().positive(),
      inputs: WorkflowValuesSchema,
      defaultModel: WorkflowModelBindingSchema.options[1],
      permissionPreset: PermissionPresetSchema,
      approvalOverride: ApprovalOverrideSchema,
    }),
    result: detail,
  },
  'workflow.run.get': { params: z.strictObject(target), result: detail },
  'workflow.run.list': {
    params: z.strictObject({
      ...project,
      limit: z.number().int().min(1).max(100).default(30),
      offset: z.number().int().nonnegative().default(0),
    }),
    result: z.strictObject({ runs: z.array(WorkflowRunSummarySchema) }),
  },
  'workflow.run.cancel': {
    params: z.strictObject({ ...target, ...request }),
    result: detail,
  },
  'workflow.run.resume': { params: z.strictObject(resume), result: detail },
  'workflow.run.retry_node': {
    params: z.strictObject({ ...resume, nodeId: z.string().min(1) }),
    result: detail,
  },
  'workflow.confirm.respond': {
    params: z.strictObject({
      ...target,
      ...request,
      confirmationId: z.string().min(1),
      token: z.string().min(32),
      inputHash: z.string().regex(/^[a-f0-9]{64}$/),
      approved: z.boolean(),
    }),
    result: detail,
  },
}

export type WorkflowCommandParams<M extends keyof typeof workflowCommands> =
  z.input<(typeof workflowCommands)[M]['params']>
export type WorkflowCommandResult<M extends keyof typeof workflowCommands> =
  z.output<(typeof workflowCommands)[M]['result']>
