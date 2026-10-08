import { z } from 'zod'

/** Core UI mutations whose acceptance/result must never be blindly replayed. */
export const CoreMutationMethodSchema = z.enum([
  'project.create',
  'session.create',
  'provider.configure',
  'message.send',
  'message.edit_resend',
  'run.retry',
  'workspace.write_file',
  'workspace.git_stage',
  'workspace.git_unstage',
  'workspace.git_commit',
  'workspace.git_fetch',
  'workspace.git_push',
  'workspace.git_pull',
  'workspace.git_branch_create',
  'workspace.git_branch_switch',
  'workspace.git_remote_add',
  'workspace.git_remote_remove',
])
export type CoreMutationMethod = z.infer<typeof CoreMutationMethodSchema>
export const OperationPhaseSchema = z.enum([
  'queued',
  'running',
  'succeeded',
  'failed',
  'uncertain',
])
export const OperationSnapshotSchema = z.object({
  requestId: z.string().min(1),
  method: CoreMutationMethodSchema,
  phase: OperationPhaseSchema,
  error: z.string().nullable(),
})
export type OperationSnapshot = z.infer<typeof OperationSnapshotSchema>
export const operationCommands = {
  'operation.get': {
    params: z.object({
      requestId: z.string().min(1),
      targetRequestId: z.string().min(1),
      method: CoreMutationMethodSchema,
    }),
    result: z.object({ operation: OperationSnapshotSchema.nullable() }),
  },
}
