import type { Store } from '../store/index.js'
import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import {
  CoreMutationMethodSchema,
  type OperationSnapshot,
} from '@reflexion-os-studio/contracts'
import { CommandError } from '../agent/errors.js'

const execution = new AsyncLocalStorage<() => void>()
/** Git calls this only when its real workspace queue starts executing. */
export function markOperationRunning(): void {
  execution.getStore()?.()
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

/** Durable identity/status plus bounded recent results. Never persist mutation parameters. */
export class OperationRegistry {
  private readonly entries = new Map<
    string,
    {
      fingerprint: string
      snapshot: OperationSnapshot
      result: Promise<Record<string, unknown>>
    }
  >()
  private readonly tombstones = new Map<
    string,
    { fingerprint: string; snapshot: OperationSnapshot }
  >()
  constructor(
    private readonly notify: (snapshot: OperationSnapshot) => void = () => {},
    private readonly receipts?: Store['operationReceipts'],
  ) {}

  private receipt(key: string) {
    return this.receipts?.get(key) ?? this.tombstones.get(key) ?? null
  }

  private remember(
    key: string,
    fingerprint: string,
    snapshot: OperationSnapshot,
  ): void {
    if (this.receipts) this.receipts.save(key, fingerprint, snapshot)
    else this.tombstones.set(key, { fingerprint, snapshot: { ...snapshot } })
    // Only completed results are evictable; the durable identity still prevents replay.
    if (this.entries.size > 256) {
      for (const [id, entry] of this.entries) {
        if (this.entries.size <= 256) break
        if (!['queued', 'running'].includes(entry.snapshot.phase))
          this.entries.delete(id)
      }
    }
  }

  get(method: string, requestId: string): OperationSnapshot | null {
    const key = `${method}:${requestId}`
    const snapshot =
      this.entries.get(key)?.snapshot ?? this.receipt(key)?.snapshot
    return snapshot ? { ...snapshot } : null
  }

  execute(
    method: string,
    params: Record<string, unknown>,
    task: () => Promise<Record<string, unknown>>,
  ): Promise<Record<string, unknown>> {
    const parsed = CoreMutationMethodSchema.safeParse(method)
    if (!parsed.success || typeof params.requestId !== 'string') return task()
    const requestId = params.requestId
    const key = `${method}:${requestId}`
    const fingerprint = createHash('sha256')
      .update(canonical(params))
      .digest('hex')
    const existing = this.entries.get(key)
    if (existing) {
      if (existing.fingerprint !== fingerprint)
        return Promise.reject(
          new CommandError(
            'invalid_request',
            '同一请求标识不能用于不同操作内容',
          ),
        )
      return existing.result
    }
    const receipt = this.receipt(key)
    if (receipt)
      return Promise.reject(
        new CommandError(
          'invalid_request',
          receipt.fingerprint !== fingerprint
            ? '同一请求标识不能用于不同操作内容'
            : '该请求已有执行回执，结果缓存已释放；请查询操作状态，禁止重新执行',
        ),
      )
    const snapshot: OperationSnapshot = {
      requestId,
      method: parsed.data,
      phase: 'queued',
      error: null,
    }
    const update = (
      phase: OperationSnapshot['phase'],
      error: string | null = null,
    ): void => {
      snapshot.phase = phase
      snapshot.error = error
      this.remember(key, fingerprint, snapshot)
      try {
        this.notify({ ...snapshot })
      } catch {
        /* Delivery cannot change execution facts. */
      }
    }
    // Persist admission before scheduling any effect. A storage failure must not
    // leave an already-scheduled task executing after the caller receives failure.
    try {
      this.remember(key, fingerprint, snapshot)
    } catch (error) {
      return Promise.reject(error)
    }
    const result = Promise.resolve().then(() =>
      execution.run(
        () => update('running'),
        async () => {
          let effectCompleted = false
          try {
            if (!method.startsWith('workspace.git_')) update('running')
            const result = await task()
            effectCompleted = true
            update('succeeded')
            return result
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error)
            try {
              update(
                effectCompleted || /timeout|timed out/i.test(message)
                  ? 'uncertain'
                  : 'failed',
                message,
              )
            } catch {
              snapshot.phase = 'uncertain'
              snapshot.error = '回执存储不可用，操作状态需核对；禁止重放'
            }
            throw error
          }
        },
      ),
    )
    this.entries.set(key, { fingerprint, snapshot, result })
    try {
      this.notify({ ...snapshot })
    } catch {
      /* The receipt is already registered. */
    }
    return result
  }
}
