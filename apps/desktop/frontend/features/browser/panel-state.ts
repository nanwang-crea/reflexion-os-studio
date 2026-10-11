import { useSyncExternalStore } from 'react'

let open = false
const listeners = new Set<() => void>()
export function setBrowserPanelOpen(next: boolean): void {
  if (open === next) return
  open = next
  for (const listener of listeners) listener()
}
const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
export function useBrowserPanelOpen(): boolean {
  return useSyncExternalStore(subscribe, () => open)
}
