import { useEffect, useState, type ComponentProps } from 'react'
import {
  type ProviderProfile,
  type AgentTemplate,
} from '@reflexion-os-studio/contracts'
import type { ConfirmDialogState } from '../../components/ConfirmDialog'
import { listProviders } from '../../api/providers'
import { listAgentTemplates } from '../../api/agents'
import * as api from '../../api/workflow'
import { useWorkflowEditor } from './useWorkflowEditor'
import { useWorkflowRuns } from './run/useWorkflowRuns'
import { useWorkflowEvents } from './run/useWorkflowEvents'
import { DefinitionEditor, type WorkflowPanel } from './editor/DefinitionEditor'
import { WorkflowGenerationView } from './generation/WorkflowGenerationView'
import type { WorkflowCreationMode } from './editor/CreationModes'
import { RunPanel } from './run/RunPanel'
import { RunControls } from './run/RunControls'

export function WorkflowWorkspace({
  projectId,
  visible = true,
  confirm,
  approvals,
  onChoose,
  onResource,
}: {
  projectId: string
  visible?: boolean
  confirm: (state: ConfirmDialogState) => Promise<boolean>
  approvals: ComponentProps<typeof RunPanel>['approvals']
  onChoose: ComponentProps<typeof RunPanel>['onChoose']
  onResource?: ComponentProps<typeof RunPanel>['onResource']
}): React.JSX.Element {
  const editor = useWorkflowEditor(projectId, confirm)
  const { setError, setGeneration } = editor
  const runs = useWorkflowRuns(projectId, setError)
  const [providers, setProviders] = useState<ProviderProfile[]>([])
  const [templates, setTemplates] = useState<AgentTemplate[]>([])
  const [modelKey, setModelKey] = useState('')
  const [showRun, setShowRun] = useState(false)
  const [creationMode, setCreationMode] =
    useState<WorkflowCreationMode>('language')
  const [panel, setPanel] = useState<WorkflowPanel>(null)
  useEffect(() => {
    if (!visible) return
    let alive = true
    void Promise.all([listProviders(), listAgentTemplates()])
      .then(([providers, templates]) => {
        if (alive) {
          setProviders(providers.profiles)
          setTemplates(templates)
        }
      })
      .catch((error) => {
        if (alive) setError(String(error))
      })
    return () => {
      alive = false
    }
  }, [visible, setError])
  useWorkflowEvents((event) => {
    if (event.type === 'workflow.run.updated' && event.projectId === projectId)
      void runs
        .event(event.workflowRunId)
        .catch((error) => setError(String(error)))
    if (
      event.type === 'workflow.generation.updated' &&
      event.generationId === editor.generation?.id
    )
      void api
        .getWorkflowGeneration({ projectId, generationId: event.generationId })
        .then((result) =>
          setGeneration((old) =>
            old?.id === result.generation.id &&
            old.stateVersion <= result.generation.stateVersion
              ? result.generation
              : old,
          ),
        )
        .catch((error) => setError(String(error)))
  })
  const draftId = editor.draft?.id
  useEffect(() => {
    if (!draftId) return
    let alive = true
    void api
      .listWorkflowGenerations({ projectId, draftId })
      .then((result) => {
        if (alive) setGeneration((old) => old ?? result.generations[0] ?? null)
      })
      .catch((error) => {
        if (alive) setError(String(error))
      })
    return () => {
      alive = false
    }
  }, [draftId, projectId, setGeneration, setError])
  const generationId = editor.generation?.id
  useEffect(() => {
    if (!generationId) return
    let alive = true
    void api
      .getWorkflowGeneration({ projectId, generationId })
      .then((result) => {
        if (alive)
          setGeneration((old) =>
            old?.id === result.generation.id &&
            old.stateVersion <= result.generation.stateVersion
              ? result.generation
              : old,
          )
      })
      .catch((error) => {
        if (alive) setError(String(error))
      })
    return () => {
      alive = false
    }
  }, [generationId, projectId, setGeneration, setError])
  const saved =
    editor.versions.find(
      (version) =>
        version.definitionId === editor.draft?.definitionId &&
        version.revision === editor.draft.baseVersion,
    ) ?? editor.base
  return (
    <div className="workflow-workspace">
      <DefinitionEditor
        editor={editor}
        saved={saved}
        providers={providers}
        templates={templates}
        detail={runs.detail}
        showRun={showRun}
        onShowRun={setShowRun}
        confirm={confirm}
        panel={panel}
        onPanel={setPanel}
        creationMode={creationMode}
        onCreationMode={setCreationMode}
        pendingActions={
          runs.detail
            ? approvals.filter(
                (approval) =>
                  approval.context?.agent?.workflowRunId ===
                  runs.detail?.run.id,
              ).length +
              runs.detail.confirmations.filter(
                (item) => item.status === 'pending',
              ).length
            : 0
        }
        generationPanel={
          <WorkflowGenerationView
            editor={editor}
            projectId={projectId}
            providers={providers}
            modelKey={modelKey}
            onModel={setModelKey}
            onOpenCanvas={() => {
              setCreationMode('canvas')
              setShowRun(false)
              setPanel(null)
            }}
          />
        }
        runPanel={
          <>
            <RunControls
              providers={providers}
              definition={editor.definition}
              disabled={editor.busy}
              modelKey={modelKey}
              onModel={setModelKey}
              onStart={(input) =>
                void editor.action(async () => {
                  if (!(await editor.validateForRun())) {
                    setCreationMode('canvas')
                    setShowRun(false)
                    return
                  }
                  if (
                    !saved ||
                    editor.dirty ||
                    JSON.stringify(editor.definition) !==
                      JSON.stringify(saved.definition)
                  )
                    throw new Error('请先保存当前版本，再运行')
                  const result = await api.startWorkflow({
                    projectId,
                    definitionId: saved.definitionId,
                    revision: saved.revision,
                    ...input,
                  })
                  runs.update(result.detail)
                  setCreationMode('canvas')
                  setShowRun(true)
                  setPanel('run')
                  await runs.refresh()
                })
              }
            />
            <RunPanel
              key={runs.detail?.run.id ?? 'none'}
              detail={runs.detail}
              runs={runs.runs}
              onSelect={(id) => {
                setCreationMode('canvas')
                setShowRun(true)
                setPanel('run')
                void editor.action(() => runs.select(id))
              }}
              onUpdate={runs.update}
              action={editor.action}
              approvals={approvals}
              onChoose={onChoose}
              onResource={onResource}
            />
            <button
              type="button"
              onClick={() => void editor.action(runs.older)}
            >
              加载更早运行
            </button>
          </>
        }
      />
    </div>
  )
}
