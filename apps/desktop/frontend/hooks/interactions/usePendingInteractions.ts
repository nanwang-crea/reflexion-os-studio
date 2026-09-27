import { useCallback, useState } from 'react'
import type { RuntimeEvent } from '@reflexion-os-studio/runtime-client'
import type { UserInteraction } from '@reflexion-os-studio/runtime-client'

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

export function usePendingInteractions() {
  const [pendingInteractions, setPendingInteractions] = useState<
    PendingInteraction[]
  >([])
  const onRequired = useCallback((entry: PendingInteraction): void => {
    setPendingInteractions((pending) => [
      ...pending.filter((item) => item.interactionId !== entry.interactionId),
      entry,
    ])
  }, [])
  const onResolved = useCallback((interactionId: string): void => {
    setPendingInteractions((pending) =>
      pending.filter((item) => item.interactionId !== interactionId),
    )
  }, [])
  const clearForRun = useCallback((runId: string): void => {
    setPendingInteractions((pending) =>
      pending.filter((item) => item.runId !== runId),
    )
  }, [])
  const replaceAll = useCallback((entries: UserInteraction[]): void => {
    setPendingInteractions(
      entries.map((entry) => ({
        interactionId: entry.id,
        toolCallId: entry.toolCallId,
        sessionId: entry.sessionId,
        runId: entry.runId,
        kind: entry.kind,
        questions: entry.questions,
        ...(entry.agent !== undefined ? { agent: entry.agent } : {}),
      })),
    )
  }, [])
  return {
    pendingInteractions,
    onRequired,
    onResolved,
    clearForRun,
    replaceAll,
  }
}
