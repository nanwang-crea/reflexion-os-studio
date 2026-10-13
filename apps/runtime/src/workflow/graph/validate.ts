import {
  WorkflowDefinitionSchema,
  WORKFLOW_DEFINITION_LIMITS,
  workflowValueWithinBounds,
  type WorkflowPort,
  type WorkflowValidationResult,
} from '@reflexion-os-studio/contracts'
import { compatiblePorts, matchesPort } from './ports.js'
import { jsonSchemaIssues } from './json-schema.js'

/** Pure graph validation. Provider/tool availability is a separate Runtime preflight. */
export function validateWorkflow(value: unknown): WorkflowValidationResult {
  const issues: WorkflowValidationResult['issues'] = []
  const add = (code: string, path: string, message: string): void => {
    issues.push({ code, path, message })
  }
  // Bound untrusted generated definitions before recursive zod parsing.
  if (!workflowValueWithinBounds(value, WORKFLOW_DEFINITION_LIMITS))
    return {
      valid: false,
      order: [],
      issues: [
        {
          code: 'definition_limit',
          path: '',
          message: 'Definition exceeds JSON limits',
        },
      ],
    }
  const parsed = WorkflowDefinitionSchema.safeParse(value)
  if (!parsed.success)
    return {
      valid: false,
      order: [],
      issues: parsed.error.issues.map((issue) => ({
        code: 'schema_invalid',
        path: issue.path.join('.'),
        message: issue.message,
      })),
    }
  const definition = parsed.data
  const nodes = new Map(definition.nodes.map((node) => [node.id, node]))
  if (nodes.size !== definition.nodes.length)
    add('duplicate_node', 'nodes', 'Duplicate node ID')
  const checkPorts = (ports: WorkflowPort[], path: string): void => {
    if (new Set(ports.map((port) => port.key)).size !== ports.length)
      add('duplicate_port', path, 'Duplicate port key')
    for (const port of ports)
      if (port.type === 'json')
        for (const message of jsonSchemaIssues(port.schema))
          add('invalid_json_schema', `${path}.${port.key}`, message)
  }
  checkPorts(definition.inputs, 'inputs')
  checkPorts(
    definition.outputs.map((output) => output.port),
    'outputs',
  )
  const sources = new Map<string, number>()
  const endpointKey = (nodeId: string, portKey: string): string =>
    JSON.stringify([nodeId, portKey])
  const sourceFor = (nodeId: string, portKey: string): void => {
    const key = endpointKey(nodeId, portKey)
    sources.set(key, (sources.get(key) ?? 0) + 1)
    if (sources.get(key)! > 1)
      add('multiple_sources', key, 'Input has multiple sources')
  }
  const endpoint = (
    nodeId: string,
    portKey: string,
    direction: 'inputs' | 'outputs',
  ) => {
    const node = nodes.get(nodeId)
    if (!node) {
      add('missing_node', nodeId, 'Node does not exist')
      return
    }
    const port = node[direction].find((item) => item.key === portKey)
    if (!port)
      add('missing_port', `${nodeId}.${portKey}`, 'Port does not exist')
    return port
  }
  const parents = new Map(
    definition.nodes.map((node) => [node.id, new Set<string>()]),
  )
  const children = new Map(
    definition.nodes.map((node) => [node.id, new Set<string>()]),
  )
  for (const node of definition.nodes) {
    checkPorts(node.inputs, `${node.id}.inputs`)
    checkPorts(node.outputs, `${node.id}.outputs`)
    if (node.kind === 'agent') {
      if (node.role.policy.allowedTools.includes('task'))
        add('delegation_disabled', node.id, 'Workflow nodes cannot delegate')
      if (
        node.budget.maxTokens > definition.budget.maxTokens ||
        node.budget.maxToolCalls > definition.budget.maxToolCalls ||
        node.budget.maxExecutionSec > definition.budget.maxExecutionSec
      )
        add(
          'node_budget_exceeds_flow',
          node.id,
          'Node budget exceeds flow budget',
        )
    } else {
      // Confirmation forwards same-named values; it does not transform data.
      for (const output of node.outputs) {
        const input = node.inputs.find((port) => port.key === output.key)
        if (
          !input ||
          !compatiblePorts(input, output) ||
          (output.required && !input.required)
        )
          add(
            'confirmation_mapping',
            node.id,
            'Confirmation output requires matching input',
          )
      }
    }
  }
  for (const edge of definition.edges) {
    const from = endpoint(edge.from.nodeId, edge.from.portKey, 'outputs')
    const to = endpoint(edge.to.nodeId, edge.to.portKey, 'inputs')
    sourceFor(edge.to.nodeId, edge.to.portKey)
    if (
      from &&
      to &&
      (!compatiblePorts(from, to) || (to.required && !from.required))
    )
      add(
        'port_incompatible',
        edge.to.nodeId,
        'Edge types or requiredness incompatible',
      )
    if (nodes.has(edge.from.nodeId) && nodes.has(edge.to.nodeId)) {
      parents.get(edge.to.nodeId)!.add(edge.from.nodeId)
      children.get(edge.from.nodeId)!.add(edge.to.nodeId)
    }
  }
  for (const binding of definition.bindings) {
    const to = endpoint(binding.to.nodeId, binding.to.portKey, 'inputs')
    sourceFor(binding.to.nodeId, binding.to.portKey)
    if (binding.source === 'input') {
      const from = definition.inputs.find(
        (port) => port.key === binding.inputKey,
      )
      if (!from)
        add('missing_input', binding.inputKey, 'Flow input does not exist')
      else if (
        to &&
        (!compatiblePorts(from, to) || (to.required && !from.required))
      )
        add('port_incompatible', binding.to.nodeId, 'Flow input incompatible')
    } else if (to && !matchesPort(binding.value, to))
      add('constant_incompatible', binding.to.nodeId, 'Constant incompatible')
  }
  for (const node of definition.nodes)
    for (const port of node.inputs)
      if (port.required && !sources.has(endpointKey(node.id, port.key)))
        add(
          'unbound_input',
          `${node.id}.${port.key}`,
          'Required input is unbound',
        )
  const remaining = new Map([...parents].map(([key, set]) => [key, set.size]))
  const order: string[] = []
  const ready = definition.nodes
    .filter((node) => remaining.get(node.id) === 0)
    .map((node) => node.id)
  while (ready.length) {
    const id = ready.shift()!
    order.push(id)
    for (const child of children.get(id)!) {
      remaining.set(child, remaining.get(child)! - 1)
      if (remaining.get(child) === 0) ready.push(child)
    }
  }
  if (order.length !== nodes.size)
    add('cycle', 'edges', 'Workflow must be acyclic')
  const used = new Set<string>()
  const visit = (id: string): void => {
    if (used.has(id)) return
    used.add(id)
    for (const parent of parents.get(id) ?? []) visit(parent)
  }
  for (const output of definition.outputs) {
    const from = endpoint(output.from.nodeId, output.from.portKey, 'outputs')
    if (
      from &&
      (!compatiblePorts(from, output.port) ||
        (output.port.required && !from.required))
    )
      add('port_incompatible', 'outputs', 'Flow output incompatible')
    if (nodes.has(output.from.nodeId)) visit(output.from.nodeId)
  }
  for (const node of definition.nodes)
    if (!used.has(node.id))
      add('orphan_node', node.id, 'Node does not contribute to flow output')
  const usedInputs = new Set(
    definition.bindings.flatMap((binding) =>
      binding.source === 'input' ? [binding.inputKey] : [],
    ),
  )
  for (const input of definition.inputs)
    if (!usedInputs.has(input.key))
      add('unused_input', input.key, 'Flow input has no consumer')
  const layoutIds = new Set<string>()
  for (const item of definition.layout) {
    if (!nodes.has(item.nodeId) || layoutIds.has(item.nodeId))
      add(
        'invalid_layout',
        item.nodeId,
        'Layout references missing or duplicate node',
      )
    layoutIds.add(item.nodeId)
  }
  if (definition.budget.maxAttempts < definition.nodes.length)
    add(
      'attempt_budget',
      'budget.maxAttempts',
      'Budget cannot run every node once',
    )
  return {
    valid: issues.length === 0,
    issues,
    order: issues.length ? [] : order,
  }
}
