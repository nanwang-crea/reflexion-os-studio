import { assertWorkflowDefinitionSafe } from '../security/content.js'
import {
  WorkflowDefinitionSchema,
  type WorkflowDefinition,
  type WorkflowVersion,
} from '@reflexion-os-studio/contracts'
import type { Store } from '../../store/index.js'
import { workflowHash } from '../execution/resources.js'
import { freezeWorkflowRoles } from './roles.js'
import { validateWorkflow } from '../graph/validate.js'

/** Domain validation before the Store's atomic, revision-checked write. */
export function saveWorkflowDefinition(
  store: Store,
  input: {
    id?: string
    projectId: string
    requestId?: string
    baseRevision: number
    definition: WorkflowDefinition
    origin: WorkflowVersion['origin']
    draftId?: string
  },
): WorkflowVersion {
  if (!store.projects.get(input.projectId))
    throw new Error('Project does not exist')
  const parsed = WorkflowDefinitionSchema.parse(input.definition)
  const previous = input.id
    ? store.workflows.get(input.projectId, input.id, input.baseRevision)
    : null
  const definition = freezeWorkflowRoles(store, parsed, previous)
  assertWorkflowDefinitionSafe(definition)
  const validation = validateWorkflow(definition)
  if (!validation.valid)
    throw new Error(
      `Invalid workflow: ${validation.issues.map((issue) => issue.code).join(', ')}`,
    )
  const draft = input.draftId
    ? store.workflowDrafts.get(input.projectId, input.draftId)
    : null
  return store.workflows.save({
    ...input,
    definition,
    requestHash: workflowHash(input),
    onSaved: draft
      ? (version) => {
          const updated = {
            ...draft,
            revision: draft.revision + 1,
            definition: version.definition,
            definitionId: version.definitionId,
            baseVersion: version.revision,
            updatedAt: version.createdAt,
          }
          store.workflowDrafts.write(updated, draft.revision)
          return updated
        }
      : undefined,
  })
}
