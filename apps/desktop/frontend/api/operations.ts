import {
  CoreMutationMethodSchema,
  type CoreMutationMethod,
  type OperationSnapshot,
} from '@reflexion-os-studio/contracts'
import { newRequestId, transport } from '../lib/transport'

export type OperationFeedback = OperationSnapshot & {
  key: string
  unconfirmed: boolean
  canAcknowledge?: boolean
}
const records = new Map<string, OperationFeedback>()
let snapshot: readonly OperationFeedback[] = []
const listeners = new Set<() => void>()
const STORAGE_KEY = 'operations.unconfirmed'
let initialized = false
const completionListeners = new Set<
  (item: OperationFeedback, previous: OperationFeedback | undefined) => void
>()

function publish(): void {
  const settled = [...records.values()].filter((item) =>
    ['succeeded', 'failed'].includes(item.phase),
  )
  const previous = snapshot
  for (const item of settled) records.delete(item.key)
  snapshot = [...records.values()]
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(
        snapshot
          .filter((item) =>
            ['queued', 'running', 'uncertain'].includes(item.phase),
          )
          .map(({ key, requestId, method }) => ({ key, requestId, method })),
      ),
    )
  } catch {
    /* Runtime receipts still protect the current session. */
  }
  for (const listener of listeners) listener()
  for (const item of settled) {
    const prior = previous.find((record) => record.requestId === item.requestId)
    for (const listener of completionListeners) listener(item, prior)
  }
}
function keyFor(
  method: CoreMutationMethod,
  params: Record<string, unknown>,
): string {
  if (method.startsWith('workspace.git_')) return `git:${params.projectId}`
  if (method === 'workspace.write_file')
    return `file:${params.projectId}:${params.path}`
  if (method === 'provider.configure')
    return `provider:${params.id ?? params.name}`
  if (method === 'project.create') return `project:${params.folderPath}`
  if (method === 'session.create')
    return `session-create:${params.projectId ?? 'standalone'}`
  return `chat:${params.sessionId ?? params.runId}`
}

export function initializeOperations(): void {
  if (initialized) return
  initialized = true
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]')
    if (Array.isArray(saved))
      for (const item of saved.slice(0, 100)) {
        const method = CoreMutationMethodSchema.safeParse(item?.method)
        if (
          !method.success ||
          typeof item?.key !== 'string' ||
          typeof item?.requestId !== 'string'
        )
          continue
        records.set(item.key, {
          key: item.key,
          requestId: item.requestId,
          method: method.data,
          phase: 'uncertain',
          error: '上次请求未确认，请核对结果；应用不会自动重做。',
          unconfirmed: true,
        })
      }
  } catch {
    /* A broken preference never blocks startup. */
  }
  publish()
  transport.onEvent((event) => {
    if (event.type !== 'operation.changed') return
    for (const [key, current] of records) {
      if (
        current.requestId !== event.operation.requestId ||
        current.method !== event.operation.method
      )
        continue
      const operation = event.operation
      const stillPending =
        current.unconfirmed && ['queued', 'running'].includes(operation.phase)
      records.set(key, {
        ...current,
        ...operation,
        phase: stillPending ? 'uncertain' : operation.phase,
      })
      publish()
      break
    }
  })
}

export const getOperations = (): readonly OperationFeedback[] => snapshot
export function subscribeOperations(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
export function subscribeOperationCompletions(
  listener: (
    item: OperationFeedback,
    previous: OperationFeedback | undefined,
  ) => void,
): () => void {
  completionListeners.add(listener)
  return () => {
    completionListeners.delete(listener)
  }
}

export async function performMutation<T>(
  method: CoreMutationMethod,
  params: Record<string, unknown>,
  timeoutMs?: number,
): Promise<T> {
  const key = keyFor(method, params)
  const existing = records.get(key)
  if (existing)
    throw new Error(
      '该资源已有操作尚未完成或确认，请先检查结果，避免重复写入。',
    )
  const current: OperationFeedback = {
    key,
    requestId: newRequestId(),
    method,
    phase: 'queued',
    error: null,
    unconfirmed: false,
  }
  records.set(key, current)
  publish()
  const update = (next: Partial<OperationFeedback>): void => {
    const record = records.get(key)
    if (record?.requestId === current.requestId) {
      records.set(key, { ...record, ...next })
      publish()
    }
  }
  try {
    const result = await transport.request<T>(
      method,
      { ...params, requestId: current.requestId },
      timeoutMs,
    )
    update({ phase: 'succeeded', error: null })
    return result
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const uncertain =
      records.get(key)?.phase === 'uncertain' ||
      (error instanceof Error &&
        error.name === 'TransportError' &&
        !('runtimeError' in error && error.runtimeError)) ||
      /timeout|timed out|transport disposed|response validation failed/i.test(
        message,
      )
    update({
      phase: uncertain ? 'uncertain' : 'failed',
      error: uncertain
        ? `结果尚未确认，操作可能仍在执行。请检查结果，不要重复提交。\n${message}`
        : message,
      unconfirmed: uncertain,
    })
    throw new Error(records.get(key)?.error ?? message)
  }
}

/** Explicit read-only check: never retries or reconstructs the write request. */
export async function checkOperation(key: string): Promise<void> {
  const current = records.get(key)
  if (!current) return
  try {
    const result = await transport.request<{
      operation: OperationSnapshot | null
    }>('operation.get', {
      requestId: newRequestId(),
      targetRequestId: current.requestId,
      method: current.method,
    })
    if (records.get(key)?.requestId !== current.requestId) return
    if (
      result.operation &&
      ['succeeded', 'failed'].includes(result.operation.phase)
    ) {
      records.set(key, { ...current, ...result.operation })
    } else {
      records.set(key, {
        ...current,
        phase: 'uncertain',
        canAcknowledge:
          result.operation === null || result.operation.phase === 'uncertain',
        error:
          result.operation?.phase === 'running' ||
          result.operation?.phase === 'queued'
            ? '请求仍在等待或执行，请等待结果。'
            : '未取得确定结果。请先在文件、Git 历史或对话中核对实际状态。',
      })
    }
    publish()
  } catch (error) {
    if (records.get(key)?.requestId !== current.requestId) return
    records.set(key, {
      ...current,
      error: `无法确认结果：${error instanceof Error ? error.message : String(error)}`,
    })
    publish()
  }
}

/** Only after a read check says no running request; the user must verify actual state. */
export function acknowledgeOperation(key: string): void {
  const current = records.get(key)
  if (current?.phase === 'uncertain' && current.canAcknowledge) {
    records.delete(key)
    publish()
  }
}
