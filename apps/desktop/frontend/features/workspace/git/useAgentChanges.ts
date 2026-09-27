import { useCallback, useEffect, useState } from 'react'
import type { GitChangeEntry } from '@reflexion-os-studio/runtime-client'
import { agentChanges } from '../../../api/workspace'

export function useAgentChanges(
  projectId: string,
  sessionId: string | null,
  refreshSignal: readonly GitChangeEntry[],
) {
  const [entries, setEntries] = useState<GitChangeEntry[]>([])

  const refresh = useCallback(async (): Promise<void> => {
    if (sessionId === null) {
      setEntries([])
      return
    }
    const result = await agentChanges(projectId, sessionId)
    setEntries(result.changes.map(toGitEntry))
  }, [projectId, sessionId])

  useEffect(() => {
    let cancelled = false
    if (sessionId === null) {
      setEntries([])
      return
    }
    void agentChanges(projectId, sessionId)
      .then((result) => {
        if (!cancelled) setEntries(result.changes.map(toGitEntry))
      })
      .catch(() => {
        if (!cancelled) setEntries([])
      })
    return () => {
      cancelled = true
    }
  }, [projectId, refreshSignal, sessionId])

  return { entries, refresh }
}

function toGitEntry(
  change: Awaited<ReturnType<typeof agentChanges>>['changes'][number],
): GitChangeEntry {
  return {
    path: change.path,
    oldPath: change.oldPath,
    staged: false,
    status:
      change.action === 'created'
        ? 'added'
        : change.action === 'deleted'
          ? 'deleted'
          : change.action === 'moved'
            ? 'renamed'
            : 'modified',
  }
}
