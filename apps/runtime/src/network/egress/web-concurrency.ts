/** Shared by all web.fetch instances, including child Agents and sessions. */
const MAX_CONCURRENT_WEB_FETCHES = 10
let active = 0
const waiting = new Set<() => void>()

function acquire(signal: AbortSignal): Promise<() => void> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const abort = (): void => {
      waiting.delete(grant)
      reject(signal.reason)
    }
    const grant = (): void => {
      waiting.delete(grant)
      signal.removeEventListener('abort', abort)
      active += 1
      let released = false
      resolve(() => {
        if (released) return
        released = true
        active -= 1
        waiting.values().next().value?.()
      })
    }
    if (active < MAX_CONCURRENT_WEB_FETCHES) grant()
    else {
      waiting.add(grant)
      signal.addEventListener('abort', abort, { once: true })
    }
  })
}

/** Queue cancellation removes the waiter; every admitted operation releases its slot. */
export async function withWebFetchSlot<T>(
  signal: AbortSignal,
  execute: () => Promise<T>,
): Promise<T> {
  const release = await acquire(signal)
  try {
    signal.throwIfAborted()
    return await execute()
  } finally {
    release()
  }
}
