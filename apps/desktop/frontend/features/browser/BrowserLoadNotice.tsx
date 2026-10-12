import type { BrowserSnapshot } from '@reflexion-os-studio/runtime-client'

export function BrowserLoadNotice({
  state,
  error,
  navigate,
  external,
}: {
  state: BrowserSnapshot | null
  error: string | null
  navigate: (url: string) => Promise<void>
  external: (url: string) => Promise<void>
}) {
  const notice = error ?? state?.notice
  const busy = state?.status === 'loading'
  const failed = state?.status === 'failed'
  const url = state?.url
  return (
    <div className="browser-status-slot">
      <div className="browser-load-progress" aria-hidden="true">
        <span
          style={{
            transform: `scaleX(${busy ? Math.max(0.03, state?.progress ?? 0) : 1})`,
            opacity: busy ? 1 : 0,
          }}
        />
      </div>
      {notice && (
        <div className="browser-notice" role="status" aria-live="polite">
          <span title={notice ?? undefined}>{notice}</span>
          {url && (failed || error) && (
            <>
              <button type="button" onClick={() => void navigate(url)}>
                重试
              </button>
              <button type="button" onClick={() => void external(url)}>
                系统浏览器打开
              </button>
            </>
          )}
        </div>
      )}
    </div>
  )
}
