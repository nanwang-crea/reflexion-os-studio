export type ThemePreference = 'light' | 'dark' | 'system'
export type ResolvedTheme = 'light' | 'dark'
const STORAGE_KEY = 'appearance.theme'
let preference: ThemePreference = 'dark'
let resolved: ResolvedTheme = 'dark'
let initialized = false
const listeners = new Set<() => void>()

function readPreference(): ThemePreference {
  try {
    const value = localStorage.getItem(STORAGE_KEY)
    return value === 'light' || value === 'system' ? value : 'dark'
  } catch {
    return 'dark'
  }
}

function apply(): void {
  resolved =
    preference === 'system'
      ? window.matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light'
      : preference
  document.documentElement.dataset.theme = resolved
  for (const listener of listeners) listener()
}

export function initializeTheme(): void {
  if (initialized) return
  initialized = true
  preference = readPreference()
  apply()
  window
    .matchMedia('(prefers-color-scheme: dark)')
    .addEventListener('change', () => {
      if (preference === 'system') apply()
    })
  window.addEventListener('storage', (event) => {
    if (event.key === STORAGE_KEY || event.key === null) {
      preference = readPreference()
      apply()
    }
  })
}

export function setThemePreference(value: ThemePreference): void {
  preference = value
  try {
    localStorage.setItem(STORAGE_KEY, value)
  } catch {
    /* Session still works without storage. */
  }
  apply()
}

export const getThemePreference = (): ThemePreference => preference
export const getResolvedTheme = (): ResolvedTheme => resolved
export function subscribeTheme(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
