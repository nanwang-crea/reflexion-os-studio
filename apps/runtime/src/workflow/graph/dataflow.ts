import {
  WorkflowValuesSchema,
  type WorkflowRunDetail,
  type WorkflowNode,
  type WorkflowValues,
} from '@reflexion-os-studio/contracts'
import { validatePortValues } from './ports.js'

export function nodeInputs(
  detail: WorkflowRunDetail,
  node: WorkflowNode,
): WorkflowValues {
  const values: WorkflowValues = Object.create(null)
  const definition = detail.run.snapshot.definition
  for (const binding of definition.bindings.filter(
    (binding) => binding.to.nodeId === node.id,
  )) {
    const value =
      binding.source === 'constant'
        ? binding.value
        : Object.hasOwn(detail.run.snapshot.inputs, binding.inputKey)
          ? detail.run.snapshot.inputs[binding.inputKey]
          : undefined
    if (value !== undefined) values[binding.to.portKey] = value
  }
  for (const edge of definition.edges.filter(
    (edge) => edge.to.nodeId === node.id,
  )) {
    const output = detail.outputs.find(
      (output) => output.nodeId === edge.from.nodeId,
    )
    if (!output) throw new Error('workflow_dependency_missing')
    const value = Object.hasOwn(output.values, edge.from.portKey)
      ? output.values[edge.from.portKey]
      : undefined
    if (value !== undefined) values[edge.to.portKey] = value
  }
  const parsed = WorkflowValuesSchema.parse(values)
  if (validatePortValues(node.inputs, parsed).length)
    throw new Error('workflow_input_invalid')
  return parsed
}
export function readyNodes(detail: WorkflowRunDetail): WorkflowNode[] {
  const completed = new Set(detail.outputs.map((output) => output.nodeId))
  const active = new Set(
    detail.attempts
      .filter((attempt) =>
        ['pending', 'running', 'waiting_user'].includes(attempt.status),
      )
      .map((attempt) => attempt.nodeId),
  )
  return detail.run.snapshot.definition.nodes.filter(
    (node) =>
      !completed.has(node.id) &&
      !active.has(node.id) &&
      detail.run.snapshot.definition.edges
        .filter((edge) => edge.to.nodeId === node.id)
        .every((edge) => completed.has(edge.from.nodeId)),
  )
}
