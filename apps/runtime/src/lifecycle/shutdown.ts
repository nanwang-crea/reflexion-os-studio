/** One ordered cleanup path for protocol shutdown, host disconnect and signals. */
export function createRuntimeShutdown(
  steps: Record<string, () => void | Promise<void>>,
  reportError: (step: string, error: unknown) => void,
  complete: () => void,
): { readonly started: boolean; run: () => Promise<void> } {
  let pending: Promise<void> | undefined
  return {
    get started() {
      return pending !== undefined
    },
    run() {
      // Assign before invoking any step, including synchronous/reentrant ones.
      pending ??= Promise.resolve().then(async () => {
        for (const [name, cleanup] of Object.entries(steps)) {
          try {
            await cleanup()
          } catch (error) {
            reportError(name, error)
          }
        }
        complete()
      })
      return pending
    },
  }
}
