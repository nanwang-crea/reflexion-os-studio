import {
  canonicalJson,
  type WorkflowDefinition,
  type WorkflowNode,
  type WorkflowPort,
} from '@reflexion-os-studio/contracts'

export const textPort = (key = 'text'): WorkflowPort => ({
  key,
  title: key,
  type: 'text',
  required: true,
})

/** Preserve arbitrary legacy IDs, including lone surrogates, in CSS-safe view keys. */
export function canvasNodeId(id: string): string {
  let value = 'n'
  for (let index = 0; index < id.length; index++)
    value += id.charCodeAt(index).toString(16).padStart(4, '0')
  return value
}
export function createNode(kind: WorkflowNode['kind']): WorkflowNode {
  const base = {
    id: crypto.randomUUID(),
    name: kind === 'agent' ? '新角色' : '人工确认',
    inputs: [textPort()],
    outputs: [textPort()],
  }
  return kind === 'confirmation'
    ? { ...base, kind, instruction: '请审阅上游成果，确认后继续。' }
    : {
        ...base,
        kind,
        role: {
          templateId: null,
          templateUpdatedAt: null,
          name: '自定义角色',
          systemPrompt: '根据输入完成任务，返回符合端口契约的结构化成果。',
          policy: {
            version: 1,
            permissionCeiling: 'workspace-read',
            allowedTools: [],
            canDelegate: false,
          },
        },
        taskPrompt: '处理输入并输出成果。',
        model: { mode: 'default' },
        budget: { maxTokens: 32000, maxToolCalls: 30, maxExecutionSec: 600 },
      }
}
export function newDefinition(): WorkflowDefinition {
  const node = createNode('agent')
  return {
    schemaVersion: 1,
    name: '新工作流',
    description: '',
    inputs: [textPort()],
    outputs: [{ port: textPort(), from: { nodeId: node.id, portKey: 'text' } }],
    nodes: [node],
    edges: [],
    bindings: [
      {
        source: 'input',
        inputKey: 'text',
        to: { nodeId: node.id, portKey: 'text' },
      },
    ],
    budget: {
      maxAttempts: 64,
      maxParallel: 3,
      maxTokens: 200000,
      maxToolCalls: 100,
      maxExecutionSec: 1800,
      confirmationExpirySec: 86400,
    },
    layout: [{ nodeId: node.id, x: 0, y: 0 }],
  }
}
export function removeNodes(
  definition: WorkflowDefinition,
  ids: ReadonlySet<string>,
): WorkflowDefinition {
  return {
    ...definition,
    nodes: definition.nodes.filter((node) => !ids.has(node.id)),
    edges: definition.edges.filter(
      (edge) => !ids.has(edge.from.nodeId) && !ids.has(edge.to.nodeId),
    ),
    bindings: definition.bindings.filter(
      (binding) => !ids.has(binding.to.nodeId),
    ),
    outputs: definition.outputs.filter(
      (output) => !ids.has(output.from.nodeId),
    ),
    layout: definition.layout.filter((position) => !ids.has(position.nodeId)),
  }
}
export function connectPorts(
  definition: WorkflowDefinition,
  from: { nodeId: string; portKey: string },
  to: { nodeId: string; portKey: string },
): WorkflowDefinition {
  if (from.nodeId === to.nodeId) throw new Error('节点不能连接自身')
  if (
    definition.edges.some(
      (edge) => edge.to.nodeId === to.nodeId && edge.to.portKey === to.portKey,
    ) ||
    definition.bindings.some(
      (binding) =>
        binding.to.nodeId === to.nodeId && binding.to.portKey === to.portKey,
    )
  )
    throw new Error('此输入已有来源，请先删除现有连线或绑定')
  const source = definition.nodes
    .find((node) => node.id === from.nodeId)
    ?.outputs.find((port) => port.key === from.portKey)
  const target = definition.nodes
    .find((node) => node.id === to.nodeId)
    ?.inputs.find((port) => port.key === to.portKey)
  if (
    !source ||
    !target ||
    source.type !== target.type ||
    (source.type === 'json' &&
      target.type === 'json' &&
      canonicalJson(source.schema) !== canonicalJson(target.schema)) ||
    (source.type === 'resource' &&
      target.type === 'resource' &&
      source.resourceKind !== target.resourceKind)
  )
    throw new Error('端口类型或契约不匹配')
  const visited = new Set<string>()
  const pending = [to.nodeId]
  while (pending.length) {
    const id = pending.pop()!
    if (id === from.nodeId) throw new Error('此连线会形成循环')
    if (visited.has(id)) continue
    visited.add(id)
    pending.push(
      ...definition.edges
        .filter((edge) => edge.from.nodeId === id)
        .map((edge) => edge.to.nodeId),
    )
  }
  return { ...definition, edges: [...definition.edges, { from, to }] }
}
