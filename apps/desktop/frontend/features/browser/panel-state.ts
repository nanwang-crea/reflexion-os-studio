import { useSyncExternalStore } from 'react'

let state = { open: false, expanded: false }
const listeners = new Set<() => void>()
export function setBrowserPanelOpen(next: boolean): void {
  if (state.open === next) return
  state = { open: next, expanded: false }
  for (const listener of listeners) listener()
}
export function setBrowserPanelExpanded(expanded: boolean): void {
  if (!state.open || state.expanded === expanded) return
  state = { ...state, expanded }
  for (const listener of listeners) listener()
}
export function getBrowserPanelState(): Readonly<typeof state> {
  return state
}
export function useBrowserPanelState(): Readonly<typeof state> {
  return useSyncExternalStore(subscribeBrowserPanel, getBrowserPanelState)
}
export function subscribeBrowserPanel(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
export function useBrowserPanelOpen(): boolean {
  return useSyncExternalStore(subscribeBrowserPanel, () => state.open)
}
