import {
  WorkflowDefinitionSchema,
  type WorkflowCommandParams,
} from '@reflexion-os-studio/contracts'
import type { WorkflowGenerationService } from './service.js'
import { workflowHash } from '../execution/resources.js'
import { freezeWorkflowRoles } from '../definitions/roles.js'
import { assertWorkflowDefinitionSafe } from '../security/content.js'
import { validateWorkflow } from '../graph/validate.js'
import { preflightWorkflow } from '../execution/preflight.js'

export function editGeneration(
  service: WorkflowGenerationService,
  input: WorkflowCommandParams<'workflow.edit_generation'>,
) {
  return service.store.transaction(() => {
    const hash = workflowHash(input)
    const replay = service.store.workflowRuns.requestResult(
      input.requestId,
      'workflow.edit_generation',
      hash,
    )
    if (replay)
      return (
        replay as { generation: ReturnType<WorkflowGenerationService['get']> }
      ).generation
    const value = service.get(input.projectId, input.generationId)
    if (
      !['ready', 'invalid'].includes(value.status) ||
      value.stateVersion !== input.stateVersion
    )
      throw new Error('workflow_generation_state_conflict')
    const definition = freezeWorkflowRoles(
      service.store,
      WorkflowDefinitionSchema.parse(input.definition),
      null,
    )
    assertWorkflowDefinitionSafe(definition)
    const graph = validateWorkflow(definition)
    const { issues } = preflightWorkflow(definition, {
      defaultModel: { providerId: value.providerId, model: value.model },
      providers: service.store.providers.list(),
      availableTools: service.tools(input.projectId),
    })
    const validation = {
      ...graph,
      valid: graph.valid && !issues.length,
      issues: [...graph.issues, ...issues],
    }
    service.store.workflowGenerations.update({
      ...value,
      candidate: definition,
      validation,
      status: validation.valid ? 'ready' : 'invalid',
      errorCode: validation.valid ? null : 'generation_validation_failed',
      updatedAt: new Date().toISOString(),
    })
    const generation = service.get(input.projectId, input.generationId)
    service.store.workflowRuns.recordRequest(
      input.projectId,
      input.requestId,
      'workflow.edit_generation',
      hash,
      { generation },
    )
    return generation
  })
}
