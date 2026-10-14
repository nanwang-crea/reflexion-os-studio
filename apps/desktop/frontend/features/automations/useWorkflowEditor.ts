import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  WorkflowDefinition,
  WorkflowDraft,
  WorkflowGeneration,
  WorkflowVersion,
  WorkflowValidationResult,
} from '@reflexion-os-studio/contracts'
import type { ConfirmDialogState } from '../../components/ConfirmDialog'
import * as api from '../../api/workflow'
import { WorkflowDefinitionSchema } from '@reflexion-os-studio/contracts'
import { newDefinition } from './editor/definition'

export function useWorkflowEditor(
  projectId: string,
  confirm: (state: ConfirmDialogState) => Promise<boolean>,
) {
  const [versions, setVersions] = useState<WorkflowVersion[]>([])
  const [drafts, setDrafts] = useState<WorkflowDraft[]>([])
  const [base, setBase] = useState<WorkflowVersion | null>(null)
  const [draft, setDraft] = useState<WorkflowDraft | null>(null)
  const [definition, setDefinition] =
    useState<WorkflowDefinition>(newDefinition)
  const [dirty, setDirty] = useState(false)
  const [generation, setGeneration] = useState<WorkflowGeneration | null>(null)
  const [validation, setValidation] = useState<WorkflowValidationResult | null>(
    null,
  )
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const revision = useRef(0)
  const mounted = useRef(true)
  const latest = useRef({ draft, definition, dirty, base })
  latest.current = { draft, definition, dirty, base }
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const refresh = useCallback(async () => {
    const [saved, drafts] = await Promise.all([
      api.listWorkflows({ projectId }),
      api.listWorkflowDrafts({ projectId }),
    ])
    if (mounted.current) {
      setVersions(saved.versions)
      setDrafts(drafts.drafts)
    }
  }, [projectId])
  useEffect(() => {
    void refresh().catch((error) => setError(String(error)))
  }, [refresh])
  const change = useCallback((value: WorkflowDefinition) => {
    revision.current++
    latest.current = { ...latest.current, definition: value, dirty: true }
    setDefinition(value)
    setDirty(true)
    setValidation(null)
  }, [])
  const working = useRef(false)
  const action = useCallback(
    async (work: () => Promise<void>, propagate = false) => {
      if (working.current) {
        if (propagate) throw new Error('已有操作进行中，请保留 JSON 编辑后重试')
        return
      }
      working.current = true
      setBusy(true)
      setError(null)
      try {
        await work()
      } catch (error) {
        if (mounted.current)
          setError(error instanceof Error ? error.message : String(error))
        if (propagate) throw error
      } finally {
        working.current = false
        if (mounted.current) setBusy(false)
      }
    },
    [],
  )
  const persist = useCallback(async (): Promise<WorkflowDraft> => {
    const state = latest.current
    if (state.draft && !state.dirty) return state.draft
    const localRevision = revision.current
    const { draft: saved } = await api.saveWorkflowDraft({
      projectId,
      draftId: state.draft?.id,
      baseRevision: state.draft?.revision ?? 0,
      definitionId:
        state.draft?.definitionId ?? state.base?.definitionId ?? null,
      baseVersion: state.draft?.baseVersion ?? state.base?.revision ?? 0,
      definition: state.definition,
    })
    if (mounted.current) {
      setDraft(saved)
      setDrafts((old) => [saved, ...old.filter((item) => item.id !== saved.id)])
      if (localRevision === revision.current) {
        setDirty(false)
        latest.current = {
          draft: saved,
          definition: state.definition,
          dirty: false,
          base: state.base,
        }
      } else latest.current = { ...latest.current, draft: saved }
    }
    return saved
  }, [projectId])
  const select = useCallback(
    async (value: WorkflowDraft | WorkflowVersion | null) => {
      if (
        latest.current.dirty &&
        !(await confirm({
          title: '切换工作流',
          message: '当前编辑尚未保存到草稿。放弃这些编辑并切换？',
          confirmLabel: '放弃并切换',
        }))
      )
        return
      revision.current++
      setGeneration(null)
      setValidation(null)
      setError(null)
      if (value && 'baseVersion' in value) {
        setBase(null)
        setDraft(value)
        setDefinition(value.definition)
        setDirty(false)
      } else {
        setDraft(null)
        setBase(value)
        setDefinition(value?.definition ?? newDefinition())
        setDirty(true)
      }
    },
    [confirm],
  )
  const save = useCallback(
    async () =>
      action(async () => {
        const epoch = revision.current
        const saved = await persist()
        const result = await api.saveWorkflow({
          projectId,
          draftId: saved.id,
          definitionId: saved.definitionId ?? undefined,
          baseRevision: saved.baseVersion,
          definition: saved.definition,
        })
        if (!result.draft) throw new Error('保存响应缺少关联草稿')
        setDraft(result.draft)
        if (epoch === revision.current) {
          setDefinition(result.version.definition)
          setDirty(false)
        } else setDirty(true)
        await refresh()
      }),
    [action, persist, projectId, refresh],
  )
  const generate = useCallback(
    async (
      mode: WorkflowGeneration['mode'],
      description: string,
      providerId: string,
      model: string,
    ) =>
      action(async () => {
        const epoch = revision.current
        const saved = await persist()
        if (epoch !== revision.current)
          throw new Error('生成前草稿已被修改，请保存后重新生成')
        const result = await api.generateWorkflow({
          projectId,
          draftId: saved.id,
          baseRevision: saved.revision,
          mode,
          description,
          providerId,
          model,
        })
        setGeneration(result.generation)
      }),
    [action, persist, projectId],
  )
  const apply = useCallback(
    async (onApplied?: () => void) =>
      action(async () => {
        if (!generation || latest.current.dirty)
          throw new Error('当前草稿有新编辑，请保留候选并重新生成或人工合并')
        const result = await api.applyWorkflowGeneration({
          projectId,
          generationId: generation.id,
          stateVersion: generation.stateVersion,
        })
        revision.current++
        setDraft(result.draft)
        setDefinition(result.draft.definition)
        setDirty(false)
        setGeneration({ ...generation, status: 'applied' })
        onApplied?.()
        await refresh()
      }),
    [action, generation, projectId, refresh],
  )
  const validateForRun = useCallback(async () => {
    const epoch = revision.current
    const parsed = WorkflowDefinitionSchema.safeParse(latest.current.definition)
    const result = parsed.success
      ? await api.validateWorkflow({ definition: parsed.data })
      : {
          valid: false,
          order: [],
          issues: parsed.error.issues.map((issue) => ({
            code: 'schema_invalid',
            path: issue.path.join('.'),
            message: issue.message,
          })),
        }
    if (epoch !== revision.current) throw new Error('配置已变化，请重新运行')
    setValidation(result)
    return result.valid
  }, [])
  const saveDraft = useCallback(
    () =>
      action(async () => {
        await persist()
        await refresh()
      }),
    [action, persist, refresh],
  )
  const cancelGeneration = useCallback(
    () =>
      action(async () => {
        if (generation)
          setGeneration(
            (
              await api.cancelWorkflowGeneration({
                projectId,
                generationId: generation.id,
              })
            ).generation,
          )
      }),
    [action, generation, projectId],
  )
  return {
    versions,
    drafts,
    draft,
    base,
    definition,
    dirty,
    generation,
    validation,
    error,
    busy,
    change,
    action,
    persist,
    select,
    save,
    generate,
    apply,
    refresh,
    setGeneration,
    setError,
    validateForRun,
    saveDraft,
    cancelGeneration,
  }
}
