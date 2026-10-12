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
      {(notice || busy) && (
        <div className="browser-notice" role="status" aria-live="polite">
          <span title={notice ?? undefined}>{notice ?? '正在加载…'}</span>
          {url && (failed || error) && (
            <>
              <button type="button" onClick={() => void navigate(url)}>
                重试
              </button>
              {failed && /^https?:/.test(url) && (
                <button
                  type="button"
                  onClick={() =>
                    void navigate(
                      url.startsWith('https:')
                        ? url.replace(/^https:/, 'http:')
                        : url.replace(/^http:/, 'https:'),
                    )
                  }
                >
                  尝试 {url.startsWith('https:') ? 'HTTP' : 'HTTPS'}
                </button>
              )}
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
