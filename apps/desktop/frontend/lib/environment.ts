/** Browser entry and desktop entry share business components, not host globals. */
export const isDesktopHost =
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
export const isRemoteClient =
  typeof document !== 'undefined' &&
  document.documentElement.dataset.client === 'remote'
