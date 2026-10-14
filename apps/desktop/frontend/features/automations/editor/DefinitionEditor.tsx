import { useState } from 'react'
import {
  WorkflowDefinitionSchema,
  type ProviderProfile,
  type AgentTemplate,
  type WorkflowVersion,
  type WorkflowRunDetail,
} from '@reflexion-os-studio/contracts'
import type { ConfirmDialogState } from '../../../components/ConfirmDialog'
import { Select } from '../../../components/forms/Select'
import { archiveWorkflow } from '../../../api/workflow'
import type { useWorkflowEditor } from '../useWorkflowEditor'
import { WorkflowCanvas } from './WorkflowCanvas'
import { createNode } from './definition'
import { NodeInspector } from './NodeInspector'
import { JsonField } from './JsonField'

export function DefinitionEditor({
  editor,
  saved,
  providers,
  templates,
  detail,
  showRun,
  onShowRun,
  confirm,
}: {
  editor: ReturnType<typeof useWorkflowEditor>
  saved: WorkflowVersion | null | undefined
  providers: ProviderProfile[]
  templates: AgentTemplate[]
  detail: WorkflowRunDetail | null
  showRun: boolean
  onShowRun: (value: boolean) => void
  confirm: (state: ConfirmDialogState) => Promise<boolean>
}): React.JSX.Element {
  const [selectedNode, setSelectedNode] = useState<string | null>(null)
  const definition =
    showRun && detail ? detail.run.snapshot.definition : editor.definition
  const node = definition.nodes.find((node) => node.id === selectedNode)
  const select = (value: Parameters<typeof editor.select>[0]) => {
    setSelectedNode(null)
    onShowRun(false)
    void editor.select(value)
  }
  return (
    <>
      <div className="workflow-toolbar">
        <label>
          已保存版本
          <Select
            value={
              editor.draft?.definitionId ?? editor.base?.definitionId ?? ''
            }
            disabled={editor.busy}
            onValueChange={(id) =>
              select(
                editor.versions.find(
                  (version) => version.definitionId === id,
                ) ?? null,
              )
            }
          >
            <option value="">新流程</option>
            {editor.versions.map((version) => (
              <option key={version.definitionId} value={version.definitionId}>
                {version.definition.name} · v{version.revision}
              </option>
            ))}
          </Select>
        </label>
        <label>
          草稿
          <Select
            value={editor.draft?.id ?? ''}
            disabled={editor.busy}
            onValueChange={(id) =>
              select(editor.drafts.find((draft) => draft.id === id) ?? null)
            }
          >
            <option value="">请选择</option>
            {editor.drafts.map((draft) => (
              <option key={draft.id} value={draft.id}>
                {draft.definition.name} · 草稿 {draft.revision}
              </option>
            ))}
          </Select>
        </label>
        <button
          type="button"
          disabled={editor.busy}
          onClick={() => select(null)}
        >
          新建
        </button>
        <button
          type="button"
          disabled={editor.busy}
          onClick={() => void editor.saveDraft()}
        >
          保存草稿
        </button>
        <button
          type="button"
          disabled={editor.busy}
          onClick={() => void editor.validate()}
        >
          校验
        </button>
        <button
          type="button"
          disabled={editor.busy}
          onClick={() => void editor.save()}
        >
          保存版本
        </button>
        {saved && (
          <button
            type="button"
            disabled={editor.busy}
            onClick={() =>
              void editor.action(async () => {
                if (
                  await confirm({
                    title: '归档工作流',
                    message: `归档 ${saved.definition.name}？运行记录仍可查看。`,
                    confirmLabel: '归档',
                  })
                ) {
                  const result = await archiveWorkflow({
                    projectId: saved.projectId,
                    definitionId: saved.definitionId,
                    baseRevision: saved.revision,
                  })
                  if (!result.archived)
                    throw new Error('版本已变化，请刷新后操作')
                  await editor.refresh()
                  await editor.select(null)
                }
              })
            }
          >
            归档
          </button>
        )}
        <button
          type="button"
          disabled={editor.busy}
          onClick={() => void editor.action(editor.refresh)}
        >
          刷新定义
        </button>
        <span>
          {editor.dirty
            ? '有未保存编辑'
            : `草稿 ${editor.draft?.revision ?? '—'}`}
        </span>
      </div>
      {editor.error && (
        <p className="workflow-error" role="alert">
          {editor.error}
        </p>
      )}
      {editor.validation && (
        <div aria-live="polite">
          {editor.validation.valid
            ? '校验通过'
            : editor.validation.issues.map((issue, index) => (
                <p key={index}>
                  {issue.path}：{issue.message}
                </p>
              ))}
        </div>
      )}
      <div className="workflow-toolbar">
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
          查看运行快照
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
              }}
            >
              添加{kind === 'agent' ? '角色' : '确认'}
            </button>
          ))}
      </div>
      <div className="workflow-editor">
        <WorkflowCanvas
          definition={definition}
          detail={showRun ? detail : null}
          readOnly={showRun || editor.busy}
          onChange={editor.change}
          onSelect={setSelectedNode}
          onError={editor.setError}
        />
        {node && !showRun && (
          <fieldset disabled={editor.busy}>
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
        )}
      </div>
      {!showRun && (
        <fieldset disabled={editor.busy}>
          <label>
            工作流名称
            <input
              value={editor.definition.name}
              onChange={(event) =>
                editor.change({
                  ...editor.definition,
                  name: event.target.value,
                })
              }
            />
          </label>
          <label>
            说明
            <textarea
              value={editor.definition.description}
              onChange={(event) =>
                editor.change({
                  ...editor.definition,
                  description: event.target.value,
                })
              }
            />
          </label>
          <details>
            <summary>
              高级配置：流程端口、绑定、最终成果、预算与完整定义
            </summary>
            <JsonField
              key={`${editor.draft?.id ?? editor.base?.definitionId ?? 'new'}:${editor.generation?.status ?? ''}`}
              label="完整定义 JSON"
              value={editor.definition}
              onApply={(value) =>
                editor.change(WorkflowDefinitionSchema.parse(value))
              }
            />
          </details>
        </fieldset>
      )}
    </>
  )
}
