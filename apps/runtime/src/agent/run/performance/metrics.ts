import {
  RunPerformanceSchema,
  type ProviderRequestAttempt,
  type RunPerformance,
} from '@reflexion-os-studio/contracts'

/** Numeric diagnostics only; never retain tool arguments or model contents. */
export class RunMetrics {
  private readonly started = performance.now()
  private readonly baseline: number
  private readonly values: RunPerformance
  private readonly attempts = new Set<string>()

  constructor(
    previous?: RunPerformance | null,
    private readonly persist?: (metrics: RunPerformance) => void,
    initialElapsedMs = 0,
  ) {
    this.values = previous
      ? { ...previous }
      : RunPerformanceSchema.parse({
          version: 1,
          elapsedMs: 0,
          modelMs: 0,
          modelCalls: 0,
          requestAttempts: 0,
          requestRetries: 0,
          firstDataWaitMs: 0,
          firstDataSamples: 0,
          approvalWaitMs: 0,
          mutationWaitMs: 0,
          toolExecutionMs: 0,
          shellExecutionMs: 0,
          toolBatchMs: 0,
          toolCalls: 0,
          toolFailures: 0,
          editFailures: 0,
          streamedReads: 0,
        })
    this.baseline = Math.max(this.values.elapsedMs, initialElapsedMs)
  }

  add(key: Exclude<keyof RunPerformance, 'version' | 'elapsedMs'>, value = 1) {
    this.values[key] += Math.max(0, value)
    this.flush()
  }

  async measure<T>(
    key: 'modelMs' | 'approvalWaitMs' | 'toolBatchMs',
    operation: () => Promise<T>,
  ): Promise<T> {
    const started = performance.now()
    try {
      return await operation()
    } finally {
      this.add(key, performance.now() - started)
    }
  }

  attempt(attempt: ProviderRequestAttempt) {
    if (attempt.status === 'running' || this.attempts.has(attempt.id)) return
    this.attempts.add(attempt.id)
    this.values.requestAttempts++
    if (attempt.attempt > 1) this.values.requestRetries++
    if (attempt.firstDataMs !== undefined) {
      this.values.firstDataWaitMs += attempt.firstDataMs
      this.values.firstDataSamples++
    }
    this.flush()
  }

  snapshot(): RunPerformance {
    return {
      ...this.values,
      elapsedMs: this.baseline + performance.now() - this.started,
    }
  }

  flush() {
    this.persist?.(this.snapshot())
  }
}
