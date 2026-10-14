import type {
  WorkflowCommandParams,
  WorkflowCommandResult,
} from '@reflexion-os-studio/contracts'
import type { RuntimeTransport } from './transport.js'

/** Typed facade: no callers need to invent Workflow DTOs or response parsing. */
export function createWorkflowClient(transport: RuntimeTransport) {
  const request = <
    M extends import('@reflexion-os-studio/contracts').CommandName &
      `workflow.${string}`,
  >(
    method: M,
    params: WorkflowCommandParams<M>,
  ): Promise<WorkflowCommandResult<M>> =>
    transport.request(method, params as Record<string, unknown>)
  return {
    editGeneration: (
      params: WorkflowCommandParams<'workflow.edit_generation'>,
    ) => request('workflow.edit_generation', params),
    listGenerations: (
      params: WorkflowCommandParams<'workflow.generations.list'>,
    ) => request('workflow.generations.list', params),
    listDrafts: (params: WorkflowCommandParams<'workflow.draft.list'>) =>
      request('workflow.draft.list', params),
    saveDraft: (params: WorkflowCommandParams<'workflow.draft.save'>) =>
      request('workflow.draft.save', params),
    generate: (params: WorkflowCommandParams<'workflow.generate'>) =>
      request('workflow.generate', params),
    getGeneration: (params: WorkflowCommandParams<'workflow.get_generation'>) =>
      request('workflow.get_generation', params),
    cancelGeneration: (
      params: WorkflowCommandParams<'workflow.cancel_generation'>,
    ) => request('workflow.cancel_generation', params),
    applyGeneration: (
      params: WorkflowCommandParams<'workflow.apply_generation'>,
    ) => request('workflow.apply_generation', params),
    validate: (params: WorkflowCommandParams<'workflow.validate'>) =>
      request('workflow.validate', params),
    list: (params: WorkflowCommandParams<'workflow.list'>) =>
      request('workflow.list', params),
    get: (params: WorkflowCommandParams<'workflow.get'>) =>
      request('workflow.get', params),
    save: (params: WorkflowCommandParams<'workflow.save'>) =>
      request('workflow.save', params),
    archive: (params: WorkflowCommandParams<'workflow.archive'>) =>
      request('workflow.archive', params),
    start: (params: WorkflowCommandParams<'workflow.run.start'>) =>
      request('workflow.run.start', params),
    getRun: (params: WorkflowCommandParams<'workflow.run.get'>) =>
      request('workflow.run.get', params),
    listRuns: (params: WorkflowCommandParams<'workflow.run.list'>) =>
      request('workflow.run.list', params),
    cancel: (params: WorkflowCommandParams<'workflow.run.cancel'>) =>
      request('workflow.run.cancel', params),
    resume: (params: WorkflowCommandParams<'workflow.run.resume'>) =>
      request('workflow.run.resume', params),
    retryNode: (params: WorkflowCommandParams<'workflow.run.retry_node'>) =>
      request('workflow.run.retry_node', params),
    respond: (params: WorkflowCommandParams<'workflow.confirm.respond'>) =>
      request('workflow.confirm.respond', params),
  }
}
export type {
  WorkflowRunDetail,
  WorkflowDefinition,
  WorkflowVersion,
} from '@reflexion-os-studio/contracts'
