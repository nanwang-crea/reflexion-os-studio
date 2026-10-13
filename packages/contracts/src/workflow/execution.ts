import { ChangedFileSchema } from '../tool-output.js'
import { ProviderProfileSchema } from '../entities/integrations/providers.js'
import { z } from 'zod'
import {
  ApprovalOverrideSchema,
  PermissionPresetSchema,
} from '../entities/tools/permissions.js'
import { WorkflowDefinitionSchema } from './definition.js'
import { WorkflowDefinitionInputSchema, WorkflowValueSchema } from './values.js'

export const WorkflowRunStatusSchema = z.enum([
  'pending',
  'running',
  'waiting_user',
  'cancelling',
  'succeeded',
  'failed',
  'cancelled',
  'interrupted',
])
export type WorkflowRunStatus = z.infer<typeof WorkflowRunStatusSchema>
export const WorkflowAttemptStatusSchema = z.enum([
  'pending',
  'running',
  'waiting_user',
  'succeeded',
  'failed',
  'rejected',
  'cancelled',
  'interrupted',
])
export type WorkflowAttemptStatus = z.infer<typeof WorkflowAttemptStatusSchema>
export const WorkflowValuesSchema = WorkflowDefinitionInputSchema.pipe(
  z.record(
    z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/),
    WorkflowValueSchema,
  ),
)
export type WorkflowValues = z.infer<typeof WorkflowValuesSchema>

/** Execution snapshot contains references only; secrets resolve at execution time. */
export const WorkflowExecutionSnapshotSchema = z.strictObject({
  version: z.literal(1),
  definitionId: z.string().min(1),
  revision: z.number().int().positive(),
  projectId: z.string().min(1),
  definition: WorkflowDefinitionSchema,
  inputs: WorkflowValuesSchema,
  models: z
    .array(
      z.strictObject({
        nodeId: z.string().min(1),
        providerId: z.string().min(1),
        model: z.string().min(1),
        profile: ProviderProfileSchema,
      }),
    )
    .max(64),
  permissionPreset: PermissionPresetSchema,
  approvalOverride: ApprovalOverrideSchema,
})
export type WorkflowExecutionSnapshot = z.infer<
  typeof WorkflowExecutionSnapshotSchema
>
export const WorkflowAttemptSchema = z.strictObject({
  id: z.string().min(1),
  workflowRunId: z.string().min(1),
  nodeId: z.string().min(1),
  attemptNo: z.number().int().positive(),
  status: WorkflowAttemptStatusSchema,
  agentRunId: z.string().min(1).nullable(),
  sessionId: z.string().min(1).nullable(),
  inputHash: z.string().regex(/^[a-f0-9]{64}$/),
  tokenBudget: z.number().int().nonnegative().default(0),
  modelPending: z.boolean().default(false),
  effectStatus: z.enum(['none', 'possible', 'recorded']),
  errorCode: z.string().nullable(),
  createdAt: z.iso.datetime(),
  completedAt: z.iso.datetime().nullable(),
})
export type WorkflowAttempt = z.infer<typeof WorkflowAttemptSchema>
export const WorkflowValidationIssueSchema = z.strictObject({
  code: z.string().min(1),
  path: z.string(),
  message: z.string(),
})
export type WorkflowValidationIssue = z.infer<
  typeof WorkflowValidationIssueSchema
>
export const WorkflowValidationResultSchema = z.strictObject({
  valid: z.boolean(),
  issues: z.array(WorkflowValidationIssueSchema),
  order: z.array(z.string()),
})
export type WorkflowValidationResult = z.infer<
  typeof WorkflowValidationResultSchema
>

export const WorkflowRunSchema = z.strictObject({
  id: z.string().min(1),
  projectId: z.string().min(1),
  requestId: z.string().min(1),
  requestHash: z.string().regex(/^[a-f0-9]{64}$/),
  stateVersion: z.number().int().nonnegative(),
  status: WorkflowRunStatusSchema,
  snapshot: WorkflowExecutionSnapshotSchema,
  attemptsUsed: z.number().int().nonnegative(),
  tokensEstimated: z.boolean(),
  tokensUsed: z.number().int().nonnegative(),
  toolsUsed: z.number().int().nonnegative(),
  activeSince: z.iso.datetime().nullable(),
  executionMs: z.number().int().nonnegative(),
  errorCode: z.string().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
})
export type WorkflowRun = z.infer<typeof WorkflowRunSchema>
export const WorkflowPublishedOutputSchema = z.strictObject({
  attemptId: z.string().min(1),
  workflowRunId: z.string().min(1),
  nodeId: z.string().min(1),
  values: WorkflowValuesSchema,
  hash: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: z.iso.datetime(),
})
export type WorkflowPublishedOutput = z.infer<
  typeof WorkflowPublishedOutputSchema
>
export const WorkflowConfirmationSchema = z.strictObject({
  id: z.string().min(1),
  workflowRunId: z.string().min(1),
  attemptId: z.string().min(1),
  nodeId: z.string().min(1),
  token: z.string().min(32),
  inputHash: z.string().regex(/^[a-f0-9]{64}$/),
  inputs: WorkflowValuesSchema,
  status: z.enum(['pending', 'approved', 'rejected', 'cancelled', 'expired']),
  expiresAt: z.iso.datetime(),
  createdAt: z.iso.datetime(),
})
export type WorkflowConfirmation = z.infer<typeof WorkflowConfirmationSchema>
export const WorkflowRunDetailSchema = z.strictObject({
  run: WorkflowRunSchema,
  attempts: z.array(WorkflowAttemptSchema).max(128),
  outputs: z.array(WorkflowPublishedOutputSchema).max(64),
  confirmations: z.array(WorkflowConfirmationSchema).max(128),
  result: WorkflowValuesSchema.nullable(),
  changedFiles: z
    .array(
      z.strictObject({
        nodeId: z.string().min(1),
        attemptId: z.string().min(1),
        runId: z.string().min(1),
        files: z.array(ChangedFileSchema),
      }),
    )
    .max(128),
})
export type WorkflowRunDetail = z.infer<typeof WorkflowRunDetailSchema>

export const WorkflowAttemptResultSchema = z.strictObject({
  attemptId: z.string().min(1),
  values: WorkflowValuesSchema.nullable(),
  errorCode: z.string().nullable(),
})
export type WorkflowAttemptResult = z.infer<typeof WorkflowAttemptResultSchema>

export const WorkflowRunSummarySchema = WorkflowRunSchema.pick({
  id: true,
  projectId: true,
  stateVersion: true,
  status: true,
  attemptsUsed: true,
  tokensUsed: true,
  tokensEstimated: true,
  toolsUsed: true,
  executionMs: true,
  errorCode: true,
  createdAt: true,
  updatedAt: true,
}).extend({
  definitionId: z.string().min(1),
  revision: z.number().int().positive(),
  name: z.string().min(1),
})
export type WorkflowRunSummary = z.infer<typeof WorkflowRunSummarySchema>
