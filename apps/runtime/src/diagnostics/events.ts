import type { Store } from '../store/index.js'

// Runtime supplies the transport callback; diagnostic persistence stays host-free.
const notifications = new WeakMap<Store, () => void>()
export function registerDeveloperNotifications(
  store: Store,
  notify: () => void,
): void {
  notifications.set(store, notify)
}
export function notifyDeveloperChanged(store: Store): void {
  try {
    notifications.get(store)?.()
  } catch {
    // A disconnected observer cannot change a request's outcome.
    process.stderr.write('[runtime] developer notification unavailable\n')
  }
}
