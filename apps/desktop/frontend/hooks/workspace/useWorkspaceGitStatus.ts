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
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const refresh = useCallback(async (): Promise<WorkspaceGitStatus> => {
    if (projectId === null || !systemReady) {
      throw new Error('工具 Runtime 不可用')
    }
    const generation = ++generationRef.current
    const next = await gitStatus(projectId)
    if (generation === generationRef.current) setSnapshot(next)
    return next
  }, [projectId, systemReady])

  useEffect(() => {
    setSnapshot(null)
    if (projectId !== null && systemReady) void refresh().catch(() => {})
  }, [projectId, refresh, systemReady])

  useEffect(() => {
    if (projectId === null) return
    return transport.onEvent((event: RuntimeEvent) => {
      if (event.type !== 'workspace.changed' || event.projectId !== projectId) {
        return
      }
      if (timerRef.current !== null) clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => void refresh().catch(() => {}), 250)
    })
  }, [projectId, refresh])

  useEffect(
    () => () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current)
    },
    [],
  )

  return { snapshot, refresh }
}
