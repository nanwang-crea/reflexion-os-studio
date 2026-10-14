import {
  useState,
  useRef,
  useId,
  type ReactNode,
  type ComponentProps,
} from 'react'
import type {
  ProviderProfile,
  AgentTemplate,
  WorkflowRunDetail,
} from '@reflexion-os-studio/contracts'
import { DefinitionToolbar } from './DefinitionToolbar'
import { WorkflowCanvas } from './WorkflowCanvas'
import { createNode } from './definition'
import { NodeInspector } from './NodeInspector'
import { FlowSettings } from './FlowSettings'

export type WorkflowPanel = 'node' | 'flow' | 'generate' | 'run' | null
export function DefinitionEditor({
  editor,
  saved,
  providers,
  templates,
  detail,
  showRun,
  onShowRun,
  confirm,
  panel,
  onPanel,
  generationPanel,
  runPanel,
  pendingActions = 0,
}: Omit<ComponentProps<typeof DefinitionToolbar>, 'select'> & {
  providers: ProviderProfile[]
  templates: AgentTemplate[]
  detail: WorkflowRunDetail | null
  showRun: boolean
  onShowRun: (value: boolean) => void
  panel: WorkflowPanel
  onPanel: (value: WorkflowPanel) => void
  generationPanel: ReactNode
  runPanel: ReactNode
  pendingActions?: number
}): React.JSX.Element {
  const [selectedNode, setSelectedNode] = useState<string | null>(null)
  const panelId = useId()
  const navigation = useRef<HTMLElement>(null)
  const definition =
    showRun && detail ? detail.run.snapshot.definition : editor.definition
  const node = definition.nodes.find((node) => node.id === selectedNode)
  const closePanel = () => {
    navigation.current
      ?.querySelector<HTMLButtonElement>('[aria-pressed="true"]')
      ?.focus()
    onPanel(null)
  }
  const select = (value: Parameters<typeof editor.select>[0]) => {
    setSelectedNode(null)
    onShowRun(false)
    void editor.select(value)
  }
  return (
    <>
      <DefinitionToolbar
        editor={editor}
        saved={saved}
        select={select}
        confirm={confirm}
      />
      <div className="workflow-stage-toolbar">
        <div className="workflow-canvas-actions">
          <button
            type="button"
            aria-pressed={!showRun}
            onClick={() => onShowRun(false)}
          >
            编辑草稿
          </button>
          <button
            type="button"
            disabled={!detail}
            aria-pressed={showRun}
            onClick={() => onShowRun(true)}
          >
            运行快照
          </button>
          {!showRun &&
            ['agent', 'confirmation'].map((kind) => (
              <button
                key={kind}
                type="button"
                disabled={editor.busy || editor.definition.nodes.length >= 64}
                onClick={() => {
                  const node = createNode(kind as 'agent' | 'confirmation')
                  editor.change({
                    ...editor.definition,
                    nodes: [...editor.definition.nodes, node],
                    layout: [
                      ...editor.definition.layout,
                      {
                        nodeId: node.id,
                        x: editor.definition.nodes.length * 40,
                        y: 220,
                      },
                    ],
                  })
                  setSelectedNode(node.id)
                  onPanel('node')
                }}
              >
                ＋ {kind === 'agent' ? '角色' : '人工确认'}
              </button>
            ))}
        </div>
        <nav
          ref={navigation}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && !event.defaultPrevented && panel) {
              event.preventDefault()
              closePanel()
            }
          }}
          aria-label="工作流面板"
          className="workflow-panel-tabs"
        >
          {(
            [
              ['node', '节点'],
              ['flow', '流程'],
              ['generate', 'AI 生成'],
              ['run', '运行'],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              aria-pressed={panel === id}
              aria-controls={`${panelId}-${id}`}
              onClick={() => onPanel(panel === id ? null : id)}
            >
              {label}
              {id === 'run' && pendingActions > 0 && (
                <span
                  className="workflow-pending"
                  role="img"
                  aria-label={`${pendingActions} 项待处理确认`}
                />
              )}
            </button>
          ))}
        </nav>
      </div>
      <div className="workflow-stage">
        <div className="workflow-canvas-area">
          <div className="workflow-canvas-caption">
            <span>{definition.name}</span>
            <span>
              {definition.nodes.length} 个节点 · {definition.edges.length}{' '}
              条连线{showRun ? ' · 只读快照' : ''}
            </span>
          </div>
          <WorkflowCanvas
            definition={definition}
            detail={showRun ? detail : null}
            readOnly={showRun || editor.busy}
            onChange={editor.change}
            onSelect={(id) => {
              setSelectedNode(id)
              onPanel('node')
            }}
            onError={editor.setError}
          />
          {!definition.nodes.length && (
            <div className="workflow-canvas-hint">
              <strong>从一个角色开始</strong>
              <p>添加角色并连接端口，或用 AI 生成协作流程。</p>
              <button type="button" onClick={() => onPanel('generate')}>
                描述你的工作流 →
              </button>
            </div>
          )}
          {(editor.error || editor.validation) && (
            <div className="workflow-notice">
              {editor.error && (
                <p className="workflow-error" role="alert">
                  {editor.error}
                </p>
              )}
              {editor.validation && (
                <details open={!editor.validation.valid}>
                  <summary>
                    {editor.validation.valid
                      ? '✓ 校验通过'
                      : `校验发现 ${editor.validation.issues.length} 个问题`}
                  </summary>
                  {editor.validation.issues.map((issue, index) => (
                    <p key={index}>
                      {issue.path}：{issue.message}
                    </p>
                  ))}
                </details>
              )}
            </div>
          )}
        </div>
        <aside
          className="workflow-side-panel"
          hidden={!panel}
          aria-label="工作流配置面板"
          onKeyDown={(event) => {
            if (event.key === 'Escape' && !event.defaultPrevented) {
              event.preventDefault()
              closePanel()
            }
          }}
        >
          <header className="workflow-side-head">
            <strong>
              {panel === 'node'
                ? '节点编辑'
                : panel === 'flow'
                  ? '流程配置'
                  : panel === 'generate'
                    ? 'AI 生成'
                    : '运行中心'}
            </strong>
            <button
              type="button"
              aria-label="收起配置面板"
              onClick={closePanel}
            >
              ×
            </button>
          </header>
          <div className="workflow-side-body">
            <div id={`${panelId}-node`} hidden={panel !== 'node'}>
              {node ? (
                <fieldset disabled={editor.busy || showRun}>
                  <NodeInspector
                    key={node.id}
                    node={node}
                    templates={templates}
                    providers={providers}
                    onChange={(node) =>
                      editor.change({
                        ...editor.definition,
                        nodes: editor.definition.nodes.map((existing) =>
                          existing.id === node.id ? node : existing,
                        ),
                      })
                    }
                  />
                </fieldset>
              ) : (
                <div className="workflow-panel-empty">
                  <strong>选择一个节点</strong>
                  <p>点击画布中的角色，编辑 Prompt、任务和连接端口。</p>
                </div>
              )}
              {showRun && node && (
                <p className="workflow-muted">当前为运行快照，配置只读。</p>
              )}
            </div>
            <div id={`${panelId}-flow`} hidden={panel !== 'flow'}>
              <fieldset disabled={editor.busy || showRun}>
                <FlowSettings
                  value={definition}
                  documentKey={`${editor.draft?.id ?? editor.base?.definitionId ?? 'new'}:${editor.generation?.status ?? ''}`}
                  onChange={editor.change}
                />
              </fieldset>
            </div>
            <div id={`${panelId}-generate`} hidden={panel !== 'generate'}>
              {generationPanel}
            </div>
            <div id={`${panelId}-run`} hidden={panel !== 'run'}>
              {runPanel}
            </div>
          </div>
        </aside>
      </div>
    </>
  )
}
