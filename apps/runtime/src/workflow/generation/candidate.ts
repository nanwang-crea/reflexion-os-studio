import { randomUUID } from 'node:crypto'
import {
  WorkflowDefinitionSchema,
  WorkflowNodeProposalSchema,
  type WorkflowDefinition,
  type WorkflowDraft,
  type WorkflowGeneration,
} from '@reflexion-os-studio/contracts'
import type { Store } from '../../store/index.js'
import { freezeWorkflowRoles } from '../definitions/roles.js'
import { assertWorkflowDefinitionSafe } from '../security/content.js'
import { validateWorkflow } from '../graph/validate.js'

/** Model IDs are local references. Canonical IDs, layout and provenance are assigned here. */
export function generationCandidate(
  store: Store,
  draft: WorkflowDraft,
  mode: WorkflowGeneration['mode'],
  content: string,
  availableTools: ReadonlySet<string>,
) {
  if (content.length > 2 * 1024 * 1024)
    throw new Error('generation_output_limit')
  const raw: unknown = JSON.parse(content)
  let definition: WorkflowDefinition
  if (mode === 'graph') {
    definition = WorkflowDefinitionSchema.parse(raw)
    const ids = new Map(definition.nodes.map((node) => [node.id, randomUUID()]))
    if (ids.size !== definition.nodes.length)
      throw new Error('generation_duplicate_ids')
    const endpoint = (value: { nodeId: string; portKey: string }) => ({
      ...value,
      nodeId: ids.get(value.nodeId) ?? value.nodeId,
    })
    definition = {
      ...definition,
      nodes: definition.nodes.map((node) => ({
        ...node,
        id: ids.get(node.id)!,
      })),
      edges: definition.edges.map((edge) => ({
        from: endpoint(edge.from),
        to: endpoint(edge.to),
      })),
      bindings: definition.bindings.map((binding) => ({
        ...binding,
        to: endpoint(binding.to),
      })),
      outputs: definition.outputs.map((output) => ({
        ...output,
        from: endpoint(output.from),
      })),
      layout: [],
    }
  } else {
    const proposal = WorkflowNodeProposalSchema.parse(raw)
    if (draft.definition.nodes.some((node) => node.id === proposal.node.id))
      throw new Error('generation_duplicate_ids')
    const id = randomUUID()
    const endpoint = (value: { nodeId: string; portKey: string }) => ({
      ...value,
      nodeId: value.nodeId === proposal.node.id ? id : value.nodeId,
    })
    if (
      proposal.edges.some(
        (edge) =>
          edge.to.nodeId !== proposal.node.id ||
          edge.from.nodeId === proposal.node.id,
      ) ||
      proposal.bindings.some(
        (binding) => binding.to.nodeId !== proposal.node.id,
      ) ||
      proposal.outputs.some((output) => output.from.nodeId !== proposal.node.id)
    )
      throw new Error('generation_node_scope')
    definition = {
      ...draft.definition,
      nodes: [...draft.definition.nodes, { ...proposal.node, id }],
      edges: [
        ...draft.definition.edges,
        ...proposal.edges.map((edge) => ({
          from: endpoint(edge.from),
          to: endpoint(edge.to),
        })),
      ],
      bindings: [
        ...draft.definition.bindings,
        ...proposal.bindings.map((binding) => ({
          ...binding,
          to: endpoint(binding.to),
        })),
      ],
      outputs: [
        ...draft.definition.outputs,
        ...proposal.outputs.map((output) => ({
          ...output,
          from: endpoint(output.from),
        })),
      ],
    }
  }
  const generatedNodes =
    mode === 'node' ? definition.nodes.slice(-1) : definition.nodes
  for (const node of generatedNodes)
    if (
      node.kind === 'agent' &&
      (node.role.templateId !== null ||
        node.model.mode !== 'default' ||
        node.role.policy.permissionCeiling !== 'workspace-read')
    )
      throw new Error('generation_configuration_scope')
  definition =
    mode === 'node'
      ? {
          ...definition,
          nodes: [
            ...draft.definition.nodes,
            ...freezeWorkflowRoles(
              store,
              { ...definition, nodes: definition.nodes.slice(-1) },
              null,
            ).nodes,
          ],
        }
      : freezeWorkflowRoles(store, definition, null)
  assertWorkflowDefinitionSafe(definition)
  for (const node of definition.nodes)
    if (
      node.kind === 'agent' &&
      node.role.policy.allowedTools.some(
        (tool) =>
          ['task', 'ask_user'].includes(tool) || !availableTools.has(tool),
      )
    )
      throw new Error('generation_tool_unavailable')
  definition.layout = definition.nodes.map((node, index) => ({
    nodeId: node.id,
    x: (index % 4) * 260,
    y: Math.floor(index / 4) * 180,
  }))
  return {
    definition: WorkflowDefinitionSchema.parse(definition),
    validation: validateWorkflow(definition),
  }
}
