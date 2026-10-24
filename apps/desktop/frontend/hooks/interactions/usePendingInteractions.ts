import { useCallback, useRef, useState } from 'react'
import type {
  RuntimeEvent,
  UserInteraction,
} from '@reflexion-os-studio/runtime-client'

type RequiredPayload = Omit<
  Extract<RuntimeEvent, { type: 'interaction.required' }>,
  | 'type'
  | 'protocolVersion'
  | 'eventId'
  | 'scope'
  | 'seq'
  | 'occurredAt'
  | 'runId'
>

export interface PendingInteraction extends RequiredPayload {
  runId: string
}

type Change =
  | { kind: 'required'; entry: PendingInteraction }
  | { kind: 'resolved'; id: string }
  | { kind: 'cleared'; runId: string }

function applyChange(
  pending: PendingInteraction[],
  change: Change,
): PendingInteraction[] {
  if (change.kind === 'resolved')
    return pending.filter((item) => item.interactionId !== change.id)
  if (change.kind === 'cleared')
    return pending.filter((item) => item.runId !== change.runId)
  const next = [...pending]
  const index = next.findIndex(
    (item) => item.interactionId === change.entry.interactionId,
  )
  if (index < 0) next.push(change.entry)
  else next[index] = change.entry
  return next
}

function fromStored(entry: UserInteraction): PendingInteraction {
  return {
    interactionId: entry.id,
    toolCallId: entry.toolCallId,
    sessionId: entry.sessionId,
    runId: entry.runId,
    kind: entry.kind,
    questions: entry.questions,
    ...(entry.agent !== undefined ? { agent: entry.agent } : {}),
  }
}

export function usePendingInteractions() {
  const [pendingInteractions, setPendingInteractions] = useState<
    PendingInteraction[]
  >([])
  const pending = useRef<PendingInteraction[]>([])
  // 只在启动快照请求期间记录增量，合并后释放，不累积已结束 Run 的墓碑。
  const restoring = useRef<Change[] | null>(null)
  const publish = useCallback((next: PendingInteraction[]): void => {
    pending.current = next
    setPendingInteractions(next)
  }, [])
  const apply = useCallback(
    (change: Change): void => {
      restoring.current?.push(change)
      publish(applyChange(pending.current, change))
    },
    [publish],
  )
  const onRequired = useCallback(
    (entry: PendingInteraction): void => {
      apply({ kind: 'required', entry })
    },
    [apply],
  )
  const onResolved = useCallback(
    (interactionId: string): void => {
      apply({ kind: 'resolved', id: interactionId })
    },
    [apply],
  )
  const clearForRun = useCallback(
    (runId: string): void => {
      apply({ kind: 'cleared', runId })
    },
    [apply],
  )
  const beginRestore = useCallback(() => {
    const changes: Change[] = []
    restoring.current = changes
    return (entries: UserInteraction[] | null): void => {
      if (restoring.current !== changes) return
      restoring.current = null
      if (entries === null) return
      let next = entries.map(fromStored)
      for (const change of changes) next = applyChange(next, change)
      publish(next)
    }
  }, [publish])
  return {
    pendingInteractions,
    onRequired,
    onResolved,
    clearForRun,
    beginRestore,
  }
}
