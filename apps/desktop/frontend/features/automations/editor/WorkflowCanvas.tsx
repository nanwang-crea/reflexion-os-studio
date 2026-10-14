import { useMemo, useState, useEffect } from 'react'
import {
  applyNodeChanges,
  ReactFlow,
  Background,
  Controls,
  Handle,
  Position,
  useUpdateNodeInternals,
  type NodeProps,
  type Node,
} from '@xyflow/react'
import type {
  WorkflowDefinition,
  WorkflowNode,
  WorkflowRunDetail,
} from '@reflexion-os-studio/contracts'
import { canvasNodeId, connectPorts, removeNodes } from './definition'
import { CanvasFit } from './CanvasFit'
import '@xyflow/react/dist/style.css'

type RoleNode = Node<{ node: WorkflowNode; status: string }, 'role'>
function RoleCard({ id, data }: NodeProps<RoleNode>) {
  const update = useUpdateNodeInternals()
  const ports = JSON.stringify([
    data.node.inputs.map((port) => port.key),
    data.node.outputs.map((port) => port.key),
  ])
  useEffect(() => update(id), [id, ports, update])
  return (
    <article className="workflow-role-card">
      <header>
        <strong>{data.node.name}</strong>
        <small>
          {data.node.kind === 'agent' ? 'Agent' : '人工确认'} · {data.status}
        </small>
      </header>
      <div className="workflow-port-columns">
        <div>
          {data.node.inputs.map((port) => (
            <div key={port.key} className="workflow-port">
              <Handle
                type="target"
                position={Position.Left}
                id={port.key}
                style={{ left: -10 }}
              />
              <span
                className="workflow-port-label"
                title={`${port.title} · ${port.type}`}
              >
                {port.title} · {port.type}
              </span>
            </div>
          ))}
        </div>
        <div>
          {data.node.outputs.map((port) => (
            <div key={port.key} className="workflow-port">
              <Handle
                type="source"
                position={Position.Right}
                id={port.key}
                style={{ right: -10 }}
              />
              <span
                className="workflow-port-label"
                title={`${port.title} · ${port.type}`}
              >
                {port.title} · {port.type}
              </span>
            </div>
          ))}
        </div>
      </div>
    </article>
  )
}
const nodeTypes = { role: RoleCard }
export function WorkflowCanvas({
  definition,
  detail,
  readOnly = false,
  onChange,
  onSelect,
  onError,
}: {
  definition: WorkflowDefinition
  detail?: WorkflowRunDetail | null
  readOnly?: boolean
  onChange: (definition: WorkflowDefinition) => void
  onSelect: (id: string) => void
  onError: (message: string) => void
}): React.JSX.Element {
  const nodes = useMemo<RoleNode[]>(
    () =>
      definition.nodes.map((node, index) => ({
        id: canvasNodeId(node.id),
        type: 'role',
        position: definition.layout.find(
          (layout) => layout.nodeId === node.id,
        ) ?? { x: (index % 4) * 270, y: Math.floor(index / 4) * 220 },
        data: {
          node,
          status:
            detail?.attempts
              .filter((attempt) => attempt.nodeId === node.id)
              .at(-1)?.status ?? '待运行',
        },
      })),
    [definition, detail],
  )
  const [canvasNodes, setCanvasNodes] = useState(nodes)
  useEffect(() => setCanvasNodes(nodes), [nodes])
  const edges = useMemo(
    () =>
      definition.edges.map((edge, index) => ({
        id: String(index),
        source: canvasNodeId(edge.from.nodeId),
        sourceHandle: edge.from.portKey,
        target: canvasNodeId(edge.to.nodeId),
        ariaLabel: `${definition.nodes.find((node) => node.id === edge.from.nodeId)?.name ?? edge.from.nodeId} (${edge.from.portKey}) → ${definition.nodes.find((node) => node.id === edge.to.nodeId)?.name ?? edge.to.nodeId} (${edge.to.portKey})`,
        targetHandle: edge.to.portKey,
      })),
    [definition.edges, definition.nodes],
  )
  const originalIds = useMemo(
    () =>
      new Map(definition.nodes.map((node) => [canvasNodeId(node.id), node.id])),
    [definition.nodes],
  )
  return (
    <div className="workflow-canvas">
      <ReactFlow
        nodes={canvasNodes}
        onNodesChange={(changes) =>
          setCanvasNodes((old) => applyNodeChanges(changes, old))
        }
        edges={edges}
        nodeTypes={nodeTypes}
        fitView
        minZoom={0.05}
        fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
        nodesDraggable={!readOnly}
        nodesConnectable={!readOnly}
        elementsSelectable
        deleteKeyCode={readOnly ? null : ['Backspace', 'Delete']}
        onNodeClick={(_, node) => onSelect(node.data.node.id)}
        onNodeDragStop={(_, node) => {
          if (readOnly) return
          onChange({
            ...definition,
            layout: [
              ...definition.layout.filter(
                (item) => item.nodeId !== node.data.node.id,
              ),
              {
                nodeId: node.data.node.id,
                x: node.position.x,
                y: node.position.y,
              },
            ],
          })
        }}
        onConnect={(connection) => {
          if (readOnly) return
          if (!connection.sourceHandle || !connection.targetHandle) return
          const source = originalIds.get(connection.source)
          const target = originalIds.get(connection.target)
          if (!source || !target) return
          try {
            onChange(
              connectPorts(
                definition,
                {
                  nodeId: source,
                  portKey: connection.sourceHandle,
                },
                {
                  nodeId: target,
                  portKey: connection.targetHandle,
                },
              ),
            )
          } catch (error) {
            onError(error instanceof Error ? error.message : '连线无效')
          }
        }}
        onDelete={({ nodes: deletedNodes, edges: deletedEdges }) => {
          if (readOnly) return
          const next = removeNodes(
            definition,
            new Set(deletedNodes.map((node) => node.data.node.id)),
          )
          onChange({
            ...next,
            edges: next.edges.filter(
              (edge) =>
                !deletedEdges.some(
                  (item) =>
                    item.source === canvasNodeId(edge.from.nodeId) &&
                    item.sourceHandle === edge.from.portKey &&
                    item.target === canvasNodeId(edge.to.nodeId) &&
                    item.targetHandle === edge.to.portKey,
                ),
            ),
          })
        }}
      >
        <Background />
        <CanvasFit
          topology={definition.nodes.map((node) => node.id).join('|')}
        />
        <Controls showInteractive={!readOnly} />
      </ReactFlow>
    </div>
  )
}
