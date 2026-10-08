import { useSyncExternalStore } from 'react'
import { getResolvedTheme, getThemePreference, subscribeTheme } from './index'

export function useTheme() {
  const preference = useSyncExternalStore(subscribeTheme, getThemePreference)
  const resolved = useSyncExternalStore(subscribeTheme, getResolvedTheme)
  return { preference, resolved }
}
