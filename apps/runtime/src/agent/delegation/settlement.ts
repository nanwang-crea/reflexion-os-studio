import type { DelegationResult } from '@reflexion-os-studio/contracts'
import type { RunEventEmitter } from '../../events.js'
import type { Store } from '../../store/index.js'
import type { LaunchOptions } from '../launcher.js'
import { ChildLimitError } from '../errors.js'

/** A notification failure must not prevent execution or Promise settlement. */
export function emitDelegationEvent(
  emitter: RunEventEmitter,
  event: Parameters<RunEventEmitter['next']>[0],
): void {
  try {
    emitter.next(event)
  } catch {
    process.stderr.write(
      `[runtime] delegation notification failed (run:${emitter.runId})\n`,
    )
  }
}

/** Settle exactly once, including failures while recording the child outcome. */
export function createDelegationSettlement(input: {
  store: Store
  runId: string
  delegationId: string
  parentSignal: AbortSignal
  emitter: RunEventEmitter
  resolve: (result: DelegationResult) => void
  reject: (error: Error) => void
}): Required<Pick<LaunchOptions, 'onResult' | 'onFailure' | 'onCancel'>> {
  const { store, runId, delegationId, parentSignal, emitter, resolve, reject } =
    input
  let settled = false
  const once = (action: () => void, failure?: Error): void => {
    if (settled) return
    settled = true
    try {
      action()
    } catch {
      process.stderr.write(
        `[runtime] delegation settlement failed (run:${runId})\n`,
      )
      reject(
        failure ?? new Error('子 Run 结果收尾失败，请检查任务记录与运行日志'),
      )
    }
  }
  return {
    onResult: (summary) =>
      once(() => {
        const result = store.delegations.buildStructuredResult(runId, summary)
        const delegation = store.delegations.update(
          delegationId,
          'completed',
          summary,
          null,
          result,
        )
        emitDelegationEvent(emitter, { type: 'delegation.updated', delegation })
        resolve(result)
      }),
    onFailure: (error) =>
      once(() => {
        const childRun = store.runs.get(runId)
        const failure = childRun?.errorCode
          ? new ChildLimitError(childRun.errorCode, error.message)
          : error
        try {
          const delegation = store.delegations.update(
            delegationId,
            'failed',
            null,
            error.message,
          )
          emitDelegationEvent(emitter, {
            type: 'delegation.updated',
            delegation,
          })
        } catch {
          process.stderr.write(
            `[runtime] delegation failure persistence failed (run:${runId})\n`,
          )
        }
        reject(failure)
      }, error),
    onCancel: () => {
      const error = new DOMException('The operation was aborted.', 'AbortError')
      once(() => {
        const delegation = store.delegations.update(
          delegationId,
          'cancelled',
          null,
          parentSignal.aborted ? '父 Run 已取消' : '子 Run 已取消',
        )
        emitDelegationEvent(emitter, { type: 'delegation.updated', delegation })
        reject(error)
      }, error)
    },
  }
}
