import { createWorkflowClient } from '@reflexion-os-studio/runtime-client'
import type { WorkflowCommandParams } from '@reflexion-os-studio/contracts'
import { newRequestId, transport } from '../lib/transport'

const client = createWorkflowClient(transport)
type Mutation<
  M extends import('@reflexion-os-studio/contracts').CommandName &
    `workflow.${string}`,
> = Omit<WorkflowCommandParams<M>, 'requestId'>
export const listWorkflows = client.list
export const getWorkflow = client.get
export const validateWorkflow = client.validate
export const listWorkflowDrafts = client.listDrafts
export const getWorkflowRun = client.getRun
export const listWorkflowRuns = client.listRuns
export const getWorkflowGeneration = client.getGeneration
export const listWorkflowGenerations = client.listGenerations
export const editWorkflowGeneration = (
  input: Mutation<'workflow.edit_generation'>,
) => client.editGeneration({ ...input, requestId: newRequestId() })
export const saveWorkflow = (input: Mutation<'workflow.save'>) =>
  client.save({ ...input, requestId: newRequestId() })
export const saveWorkflowDraft = (input: Mutation<'workflow.draft.save'>) =>
  client.saveDraft({ ...input, requestId: newRequestId() })
export const archiveWorkflow = (input: Mutation<'workflow.archive'>) =>
  client.archive({ ...input, requestId: newRequestId() })
export const startWorkflow = (input: Mutation<'workflow.run.start'>) =>
  client.start({ ...input, requestId: newRequestId() })
export const cancelWorkflow = (input: Mutation<'workflow.run.cancel'>) =>
  client.cancel({ ...input, requestId: newRequestId() })
export const resumeWorkflow = (input: Mutation<'workflow.run.resume'>) =>
  client.resume({ ...input, requestId: newRequestId() })
export const retryWorkflowNode = (input: Mutation<'workflow.run.retry_node'>) =>
  client.retryNode({ ...input, requestId: newRequestId() })
export const respondWorkflow = (input: Mutation<'workflow.confirm.respond'>) =>
  client.respond({ ...input, requestId: newRequestId() })
export const generateWorkflow = (input: Mutation<'workflow.generate'>) =>
  client.generate({ ...input, requestId: newRequestId() })
export const cancelWorkflowGeneration = (
  input: Mutation<'workflow.cancel_generation'>,
) => client.cancelGeneration({ ...input, requestId: newRequestId() })
export const applyWorkflowGeneration = (
  input: Mutation<'workflow.apply_generation'>,
) => client.applyGeneration({ ...input, requestId: newRequestId() })
