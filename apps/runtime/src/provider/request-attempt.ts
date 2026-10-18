import { randomUUID } from 'node:crypto'
import type { ProviderRequestAttempt } from '@reflexion-os-studio/contracts'
import type { StreamChatOptions } from './types.js'
import { ProviderError, redactProviderError } from './provider-error.js'
import { StreamCallbackError } from './shared.js'

/** One lifecycle per physical HTTP request; callbacks never contain headers/body. */
export function createRequestAttemptTracker(options: StreamChatOptions) {
  let current: ProviderRequestAttempt | undefined
  let count = 0
  let started = 0
  let lastData = 0
  let checkpoint = 0
  const emit = () => {
    if (!current) return
    current.durationMs = Math.max(0, performance.now() - started)
    current.maxIdleMs = Math.max(
      current.maxIdleMs,
      performance.now() - lastData,
    )
    try {
      options.onAttempt?.({ ...current })
    } catch (error) {
      current = undefined
      throw new StreamCallbackError(error)
    }
  }
  const finish = (
    status: 'completed' | 'failed' | 'cancelled',
    error?: unknown,
  ) => {
    if (!current) return
    current.status = options.signal.aborted ? 'cancelled' : status
    current.completedAt = new Date().toISOString()
    if (error instanceof ProviderError) {
      current.errorCode = error.code
      current.errorMessage = redactProviderError(
        error.message,
        options.apiKey,
        options.headers,
      )
    }
    try {
      emit()
    } finally {
      current = undefined
    }
  }
  return {
    get id() {
      return current?.id
    },
    finish,
    async fetch(url: string, init: RequestInit): Promise<Response> {
      started = performance.now()
      lastData = started
      checkpoint = started
      current = {
        id: randomUUID(),
        attempt: ++count,
        status: 'running',
        phase: 'connect',
        startedAt: new Date().toISOString(),
        completedAt: null,
        durationMs: 0,
        maxIdleMs: 0,
        receivedBytes: 0,
        content: '',
        reasoning: '',
      }
      emit()
      const response = await fetch(url, init)
      current.responseHeadersMs = performance.now() - started
      current.phase = 'response'
      current.responseStatus = response.status
      for (const name of [
        'x-request-id',
        'request-id',
        'x-amzn-requestid',
        'cf-ray',
      ]) {
        const value = response.headers.get(name)
        if (value) {
          current.providerRequestId = redactProviderError(
            value,
            options.apiKey,
            options.headers,
          ).slice(0, 256)
          break
        }
      }
      emit()
      return response
    },
    content(kind: 'text' | 'reasoning') {
      if (!current) return
      const key = kind === 'text' ? 'firstTextMs' : 'firstReasoningMs'
      current[key] ??= performance.now() - started
    },
    received(bytes: number) {
      if (!current || bytes === 0) return
      current.phase = 'stream'
      const now = performance.now()
      current.firstDataMs ??= now - started
      current.maxIdleMs = Math.max(current.maxIdleMs, now - lastData)
      current.receivedBytes += bytes
      lastData = now
      if (now - checkpoint >= 2_000) {
        checkpoint = now
        emit()
      }
    },
  }
}
export type RequestAttemptTracker = ReturnType<
  typeof createRequestAttemptTracker
>
