import { memo, useMemo, useState, useEffect, useCallback } from 'react'
import {
  applyNodeChanges,
  type NodeChange,
  Background,
  Controls,
  Handle,
  Position,
  ReactFlow,
  type Node,
  type NodeProps,
  type Edge,
} from '@xyflow/react'
import type { Delegation, Plan, Run } from '@reflexion-os-studio/runtime-client'
import '@xyflow/react/dist/style.css'
import { collaborationStatus } from './presentation'
import { FitGraph } from './FitGraph'

type CollaborationNode = Node<
  {
    title: string
    description: string
    status: string
    model: string
    delegationId?: string
  },
  'collaborator'
>
function Collaborator({
  data,
}: NodeProps<CollaborationNode>): React.JSX.Element {
  return (
    <article className={`collaboration-node collaboration-${data.status}`}>
      <Handle type="target" position={Position.Top} />
      <header>
        <strong>{data.title}</strong>
        <span>{collaborationStatus(data.status)}</span>
      </header>
      <p>{data.description}</p>
      {data.model && <small>{data.model}</small>}
      {data.delegationId && <small>点击查看会话过程</small>}
      <Handle type="source" position={Position.Bottom} />
    </article>
  )
}
const nodeTypes = { collaborator: Collaborator }
export const CollaborationGraph = memo(function CollaborationGraph({
  run,
  plan,
  items,
  onSelect,
}: {
  run: Run | null
  plan: Plan | null
  items: Delegation[]
  onSelect: (item: Delegation) => void
}): React.JSX.Element {
  const { nodes, edges } = useMemo(() => {
    const nodes: CollaborationNode[] = [],
      edges: Edge[] = []
    if (plan)
      plan.steps.forEach((step, index) => {
        nodes.push({
          id: `plan-${step.id}`,
          type: 'collaborator',
          position: { x: 0, y: index * 190 },
          data: {
            title: `${index + 1}. ${step.title}`,
            description: '计划步骤',
            status: step.status,
            model: '',
          },
        })
        if (index)
          edges.push({
            id: `plan-edge-${step.id}`,
            source: `plan-${plan.steps[index - 1].id}`,
            target: `plan-${step.id}`,
            type: 'smoothstep',
            label: '计划顺序',
            style: { strokeDasharray: '4 4' },
          })
      })
    if (run) {
      const x = plan?.steps.length ? 350 : 0
      nodes.push({
        id: 'primary',
        type: 'collaborator',
        position: { x, y: 0 },
        data: {
          title: '主 Agent',
          description: plan?.goal ?? '理解目标、规划、执行并检查成果',
          status: run.status,
          model: run.model ?? '模型未记录',
        },
      })
      const parentNodes = new Map<string, string>([[run.id, 'primary']])
      items.forEach((item) => {
        if (item.childRunId)
          parentNodes.set(item.childRunId, `agent-${item.id}`)
      })
      const depthCounts = new Map<number, number>()
      items.forEach((item) => {
        const depth = item.execution?.depth ?? 1
        const column = depthCounts.get(depth) ?? 0
        depthCounts.set(depth, column + 1)
        const id = `agent-${item.id}`
        nodes.push({
          id,
          type: 'collaborator',
          position: { x: x + column * 280, y: depth * 210 },
          data: {
            title: item.agentInstance?.name ?? item.agentId,
            description: item.task,
            status: item.status,
            model:
              item.execution?.model ??
              item.agentInstance?.model ??
              '模型未记录',
            delegationId: item.id,
          },
        })
        const parent = parentNodes.get(item.parentRunId)
        if (parent)
          edges.push({
            id: `delegation-${item.id}`,
            source: parent,
            target: id,
            type: 'smoothstep',
            label: '委派',
          })
      })
    }
    return { nodes, edges }
  }, [run, plan, items])
  const [displayNodes, setDisplayNodes] = useState(nodes)
  useEffect(() => {
    setDisplayNodes((previous) => {
      const measured = new Map(previous.map((node) => [node.id, node]))
      return nodes.map((node) => ({
        ...node,
        measured: measured.get(node.id)?.measured,
      }))
    })
  }, [nodes])
  const onNodesChange = useCallback(
    (changes: NodeChange<CollaborationNode>[]) => {
      setDisplayNodes((current) => applyNodeChanges(changes, current))
    },
    [],
  )
  return (
    <div className="collaboration-graph" aria-label="任务计划与 Agent 协作图">
      <ReactFlow
        colorMode="dark"
        nodes={displayNodes}
        onNodesChange={onNodesChange}
        edges={edges}
        nodeTypes={nodeTypes}
        autoPanOnNodeFocus={false}
        nodesDraggable={false}
        nodesConnectable={false}
        edgesFocusable={false}
        deleteKeyCode={null}
        minZoom={0.2}
        maxZoom={1.5}
        fitView
        onNodeClick={(_, node) => {
          const item = items.find((item) => item.id === node.data.delegationId)
          if (item) onSelect(item)
        }}
      >
        <Background />
        <Controls showInteractive={false} />
        <FitGraph
          signature={`${run?.id}:${plan?.id}:${plan?.steps.length}:${items.map((item) => item.id).join(',')}`}
        />
      </ReactFlow>
    </div>
  )
})
