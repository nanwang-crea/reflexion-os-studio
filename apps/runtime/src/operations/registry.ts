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

/** Session-local receipts, never parameters or secrets. No replay after unknown results. */
export class OperationRegistry {
  private readonly entries = new Map<
    string,
    {
      fingerprint: string
      snapshot: OperationSnapshot
      result: Promise<Record<string, unknown>>
    }
  >()
  constructor(
    private readonly notify: (snapshot: OperationSnapshot) => void = () => {},
  ) {}

  get(method: string, requestId: string): OperationSnapshot | null {
    const snapshot = this.entries.get(`${method}:${requestId}`)?.snapshot
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
    // Never evict a receipt and then accidentally execute the same request again.
    if (this.entries.size >= 4096)
      return Promise.reject(
        new CommandError(
          'invalid_request',
          '本次启动的操作记录已满，请核对未确认操作后重启应用',
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
      this.notify({ ...snapshot })
    }
    // Defer execution until the receipt is registered, including synchronous failures.
    const result = Promise.resolve().then(() =>
      execution.run(
        () => update('running'),
        async () => {
          if (!method.startsWith('workspace.git_')) update('running')
          try {
            const result = await task()
            update('succeeded')
            return result
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error)
            update(
              /timeout|timed out/i.test(message) ? 'uncertain' : 'failed',
              message,
            )
            throw error
          }
        },
      ),
    )
    this.entries.set(key, { fingerprint, snapshot, result })
    update('queued')
    return result
  }
}
