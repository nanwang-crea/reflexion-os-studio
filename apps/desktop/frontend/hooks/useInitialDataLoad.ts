import { useCallback, useEffect, useRef } from 'react'

interface InitialDataDeps {
  refreshProfiles: () => Promise<void>
  refreshProjects: () => Promise<void>
  refreshStandaloneSessions: () => Promise<void>
  setNotice: (notice: string | null) => void
}

/**
 * 启动期初始数据：并行拉取，失败自动重试一次后降级为通知（非致命）。
 * 拉取失败只降级为通知，不把整个应用打成启动失败
 * （sidecar 就绪竞态、瞬时错误都能自愈）。
 */
export function useInitialDataLoad(deps: InitialDataDeps): () => void {
  const initialRetryTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const fail = useCallback(
    (error: unknown): void => {
      deps.setNotice(error instanceof Error ? error.message : String(error))
    },
    [deps],
  )

  const loadInitialData = useCallback(
    async (retry = true): Promise<void> => {
      const fetchAll = () =>
        Promise.allSettled([
          deps.refreshProfiles(),
          deps.refreshProjects(),
          deps.refreshStandaloneSessions(),
        ])
      const findFailure = (
        settled: PromiseSettledResult<void>[],
      ): PromiseRejectedResult | undefined =>
        settled.find(
          (result): result is PromiseRejectedResult =>
            result.status === 'rejected',
        )
      let failure = findFailure(await fetchAll())
      if (failure && retry) {
        // sidecar 就绪竞态等瞬时错误：稍等后自动重试一次
        await new Promise<void>((resolve) => {
          initialRetryTimer.current = setTimeout(() => {
            initialRetryTimer.current = null
            resolve()
          }, 2000)
        })
        failure = findFailure(await fetchAll())
      }
      if (failure) fail(failure.reason)
    },
    [deps, fail],
  )

  useEffect(
    () => () => {
      if (initialRetryTimer.current) {
        clearTimeout(initialRetryTimer.current)
        initialRetryTimer.current = null
      }
    },
    [],
  )

  return loadInitialData
}
