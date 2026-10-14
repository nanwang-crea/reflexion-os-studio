import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  WorkflowRunDetail,
  WorkflowRunSummary,
} from '@reflexion-os-studio/contracts'
import * as api from '../../../api/workflow'
import { mergeWorkflowRuns } from './history'

export function useWorkflowRuns(
  projectId: string,
  onError: (message: string) => void,
) {
  const [runs, setRuns] = useState<WorkflowRunSummary[]>([])
  const [detail, setDetail] = useState<WorkflowRunDetail | null>(null)
  const selected = useRef<string | null>(null)
  const alive = useRef(true)
  const refreshEpoch = useRef(0)
  const refresh = useCallback(async () => {
    const epoch = ++refreshEpoch.current
    const result = await api.listWorkflowRuns({ projectId })
    if (alive.current && epoch === refreshEpoch.current)
      setRuns((old) => mergeWorkflowRuns(old, result.runs, 'latest'))
  }, [projectId])
  useEffect(() => {
    alive.current = true
    void refresh().catch((error) => onError(String(error)))
    return () => {
      alive.current = false
    }
  }, [refresh, onError])
  const update = useCallback((value: WorkflowRunDetail) => {
    selected.current = value.run.id
    setDetail((old) =>
      old?.run.id === value.run.id &&
      old.run.stateVersion > value.run.stateVersion
        ? old
        : value,
    )
  }, [])
  const select = useCallback(
    async (id: string) => {
      selected.current = id
      const result = await api.getWorkflowRun({ projectId, runId: id })
      if (alive.current && selected.current === id) update(result.detail)
    },
    [projectId, update],
  )
  const event = useCallback(
    async (id: string) => {
      await refresh()
      if (selected.current === id) await select(id)
    },
    [refresh, select],
  )
  const older = useCallback(async () => {
    const result = await api.listWorkflowRuns({
      projectId,
      offset: runs.length,
    })
    if (alive.current)
      setRuns((old) => mergeWorkflowRuns(old, result.runs, 'older'))
  }, [projectId, runs.length])
  return { runs, detail, refresh, update, select, event, older }
}
