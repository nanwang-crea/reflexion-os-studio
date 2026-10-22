import type { Store } from '../store/index.js'
import { notifyDeveloperChanged } from './events.js'
import type { ModelInvocation, Usage } from '@reflexion-os-studio/contracts'

export async function observeModelInvocation<T extends { usage?: Usage }>(
  store: Store,
  input: Pick<
    ModelInvocation,
    'sessionId' | 'runId' | 'messageId' | 'providerId' | 'model' | 'purpose'
  > & {
    estimatedInputTokens?: number
    contextWindow?: number
    signal: AbortSignal
  },
  operation: () => Promise<T>,
): Promise<T> {
  const id = store.modelInvocations.start(input)
  notifyDeveloperChanged(store)
  const started = performance.now()
  try {
    const result = await operation()
    store.transaction(() => {
      store.modelInvocations.finish(
        id,
        'completed',
        performance.now() - started,
        result.usage,
      )
      if (input.purpose === 'chat' && input.runId && result.usage)
        store.runs.addUsage(input.runId, result.usage)
    })
    notifyDeveloperChanged(store)
    return result
  } catch (error) {
    // Only stable error identifiers; arbitrary error messages may contain secrets.
    const code =
      error &&
      typeof error === 'object' &&
      'code' in error &&
      typeof error.code === 'string' &&
      /^[a-z_]{1,64}$/.test(error.code)
        ? error.code
        : 'model_error'
    try {
      store.modelInvocations.finish(
        id,
        input.signal.aborted ? 'cancelled' : 'failed',
        performance.now() - started,
        undefined,
        code,
      )
    } catch {
      // Preserve the original failure if shutdown has already closed the store.
      process.stderr.write(
        '[runtime] model diagnostic finalization unavailable\n',
      )
    }
    notifyDeveloperChanged(store)
    throw error
  }
}
