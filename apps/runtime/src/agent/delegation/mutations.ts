import { resourcesConflict } from './resource-locks.js'

interface PendingMutation {
  keys: readonly string[]
  done: Promise<void>
  release: () => void
}

/** Root-scoped fair locks; unknown footprints and Shell remain global barriers. */
export class RootMutationCoordinator {
  private readonly pending = new Set<PendingMutation>()

  async run<T>(
    operation: () => Promise<T>,
    options: {
      keys?: readonly string[]
      signal?: AbortSignal
      onWait?: (milliseconds: number) => void
    } = {},
  ): Promise<T> {
    options.signal?.throwIfAborted()
    const keys = options.keys ?? []
    const predecessors = [...this.pending].filter((entry) =>
      resourcesConflict(entry.keys, keys),
    )
    let release!: () => void
    const done = new Promise<void>((resolve) => {
      release = resolve
    })
    const entry = { keys, done, release }
    this.pending.add(entry)
    const started = performance.now()
    let abort: (() => void) | undefined
    // A cancelled waiter keeps its position until predecessors settle, so later
    // barriers cannot overtake an earlier mutation through a cancelled entry.
    const ready = Promise.all(predecessors.map((item) => item.done))
    try {
      if (predecessors.length) {
        await Promise.race([
          ready,
          new Promise<never>((_resolve, reject) => {
            abort = () =>
              reject(
                options.signal?.reason ??
                  new DOMException('Aborted', 'AbortError'),
              )
            options.signal?.addEventListener('abort', abort, { once: true })
          }),
        ])
      }
      options.onWait?.(performance.now() - started)
      options.signal?.throwIfAborted()
      return await operation()
    } finally {
      if (abort) options.signal?.removeEventListener('abort', abort)
      void ready.then(() => {
        this.pending.delete(entry)
        entry.release()
      })
    }
  }
}

export function isMutatingTool(toolName: string): boolean {
  return (
    toolName === 'shell.execute' ||
    [
      'file.write',
      'file.write_stream',
      'file.edit',
      'file.delete',
      'file.move',
      'file.mkdir',
    ].includes(toolName)
  )
}
