import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  GitChangeEntry,
  RuntimeEvent,
} from '@reflexion-os-studio/runtime-client'
import { gitStatus } from '../../api/workspace'
import { transport } from '../../lib/transport'

export interface WorkspaceGitStatus {
  repo: boolean
  entries: GitChangeEntry[]
  truncated: boolean
  branch: string | null
  upstream: string | null
  ahead: number | null
  behind: number | null
}

export function useWorkspaceGitStatus(
  projectId: string | null,
  systemReady: boolean,
) {
  const [snapshot, setSnapshot] = useState<WorkspaceGitStatus | null>(null)
  const generationRef = useRef(0)
  const scopeRef = useRef({ projectId, systemReady })
  scopeRef.current = { projectId, systemReady }
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const refresh = useCallback(async (): Promise<WorkspaceGitStatus> => {
    if (projectId === null || !systemReady) {
      throw new Error('工具 Runtime 不可用')
    }
    if (
      scopeRef.current.projectId !== projectId ||
      !scopeRef.current.systemReady
    ) {
      throw new Error('工作区上下文已变更')
    }
    const generation = ++generationRef.current
    const next = await gitStatus(projectId)
    if (
      generation === generationRef.current &&
      scopeRef.current.projectId === projectId &&
      scopeRef.current.systemReady
    )
      setSnapshot(next)
    return next
  }, [projectId, systemReady])

  const refreshRef = useRef(refresh)
  refreshRef.current = refresh

  useEffect(() => {
    setSnapshot(null)
    if (projectId !== null && systemReady) void refresh().catch(() => {})
    return () => {
      generationRef.current += 1
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
    }
  }, [projectId, refresh, systemReady])

  useEffect(() => {
    const unlisten = transport.onEvent((event: RuntimeEvent) => {
      if (
        event.type !== 'workspace.changed' ||
        event.projectId !== scopeRef.current.projectId ||
        !scopeRef.current.systemReady
      ) {
        return
      }
      if (timerRef.current !== null) clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => {
        timerRef.current = null
        void refreshRef.current().catch(() => {})
      }, 250)
    })
    return () => {
      unlisten()
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
    }
  }, [])

  return { snapshot, refresh }
}
