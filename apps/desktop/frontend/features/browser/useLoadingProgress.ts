import { useEffect, useState } from 'react'
import type { BrowserSnapshot } from '@reflexion-os-studio/runtime-client'

export interface LoadingProgress {
  tabId: number | null
  value: number
  visible: boolean
  running: boolean
}

export function updateLoadingProgress(
  current: LoadingProgress,
  tabId: number | null,
  status: BrowserSnapshot['status'] | undefined,
  progress: number,
): LoadingProgress {
  if (current.tabId !== tabId)
    current = { tabId, value: 0, visible: false, running: false }
  if (status === 'loading') {
    return {
      tabId,
      value: Math.max(
        current.visible ? current.value : 0,
        Math.min(0.95, Math.max(0.03, progress)),
      ),
      visible: true,
      running: true,
    }
  }
  if (status !== 'ready')
    return { tabId, value: 0, visible: false, running: false }
  return current
}

/** Bridge short redirect gaps, then complete before fading. No idle polling. */
export function useLoadingProgress(state: BrowserSnapshot | null) {
  const tabId = state?.activeTabId ?? null
  const status = state?.status
  const progress = state?.progress ?? 0
  const [display, setDisplay] = useState<LoadingProgress>(() =>
    updateLoadingProgress(
      { tabId, value: 0, visible: false, running: false },
      tabId,
      status,
      progress,
    ),
  )
  useEffect(() => {
    setDisplay((current) =>
      updateLoadingProgress(current, tabId, status, progress),
    )
    if (status !== 'ready') return
    let fade: ReturnType<typeof setTimeout> | undefined
    const finish = setTimeout(() => {
      setDisplay((current) =>
        current.visible ? { ...current, value: 1, running: false } : current,
      )
      fade = setTimeout(() => {
        setDisplay((current) => ({ ...current, visible: false }))
      }, 240)
    }, 180)
    return () => {
      clearTimeout(finish)
      clearTimeout(fade)
    }
  }, [tabId, status, progress])
  return display.tabId === tabId
    ? display
    : updateLoadingProgress(display, tabId, status, progress)
}
