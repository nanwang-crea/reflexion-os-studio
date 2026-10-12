import { useEffect, useRef, useState } from 'react'
import { useBrowserSurface } from './useBrowserSurface'
import './browser.css'
import { useBrowserViewport } from './useBrowserViewport'
import { BrowserIcon } from './BrowserIcon'
import { BrowserTabs } from './BrowserTabs'
import { BrowserImportDialog } from './BrowserImportDialog'
import { BrowserMenu } from './BrowserMenu'
import { useBrowserSettings } from '../../api/browser-settings'

/** Trusted browser chrome; native webpage content remains a separate view. */
export function BrowserSurfacePanel({
  visible,
  onWorkspace,
  onTerminal,
  onCollapse,
}: {
  visible: boolean
  onWorkspace: () => void
  onTerminal: () => void
  onCollapse: () => void
}): React.JSX.Element {
  const settings = useBrowserSettings()
  const [addressFocused, setAddressFocused] = useState(false)
  const { state, error, control, navigate, external } =
    useBrowserSurface(visible)
  const [menuOpen, setMenuOpen] = useState(false)
  const [bannerVisible, setBannerVisible] = useState(true)
  const [importOpen, setImportOpen] = useState(false)
  const viewport = useRef<HTMLDivElement>(null)
  useBrowserViewport(
    viewport,
    visible &&
      settings.mode !== 'system' &&
      Boolean(state?.url) &&
      !menuOpen &&
      !importOpen,
    state?.available === true,
    state?.revision ?? -1,
  )
  const [address, setAddress] = useState('')
  useEffect(() => {
    setAddress(state?.url ?? '')
  }, [state?.url, state?.activeTabId])
  const target = state?.url ?? address
  const busy = state?.status === 'loading'
  const notice = error ?? (state?.status === 'failed' ? state.notice : null)
  return (
    <section className="browser-surface-panel" aria-label="浏览器面板">
      <div className="browser-tabstrip">
        <BrowserTabs state={state} control={control} />
        <div className="browser-tabstrip-spacer" />
        <button
          type="button"
          className="browser-icon-button"
          title="切换工作区"
          aria-label="切换工作区"
          onClick={onWorkspace}
        >
          <BrowserIcon name="folder" />
        </button>
        <button
          type="button"
          className="browser-icon-button"
          title="收起浏览器面板"
          aria-label="收起浏览器面板"
          onClick={onCollapse}
        >
          <BrowserIcon name="panel" />
        </button>
      </div>
      {importOpen && (
        <BrowserImportDialog onClose={() => setImportOpen(false)} />
      )}
      <header className="browser-toolbar">
        <nav className="browser-navigation" aria-label="网页导航">
          <button
            type="button"
            className="browser-icon-button"
            title="后退"
            aria-label="后退"
            disabled={!state?.canGoBack}
            onClick={() => void control({ kind: 'back' })}
          >
            <BrowserIcon name="back" />
          </button>
          <button
            type="button"
            className="browser-icon-button"
            title="前进"
            aria-label="前进"
            disabled={!state?.canGoForward}
            onClick={() => void control({ kind: 'forward' })}
          >
            <BrowserIcon name="forward" />
          </button>
          <button
            type="button"
            className="browser-icon-button"
            title={busy ? '停止' : '刷新或重试'}
            aria-label={busy ? '停止加载' : '刷新'}
            disabled={!state?.available || !state.url}
            onClick={() => {
              if (state?.status === 'failed' && state.url)
                void navigate(state.url)
              else void control({ kind: busy ? 'stop' : 'reload' })
            }}
          >
            <BrowserIcon name={busy ? 'close' : 'reload'} />
          </button>
        </nav>
        <form
          className="browser-address"
          onSubmit={(event) => {
            event.preventDefault()
            if (address.trim()) void navigate(address)
          }}
        >
          {state?.url?.startsWith('http:') && (
            <span className="browser-http" title="HTTP 连接未加密">
              不安全
            </span>
          )}
          <input
            aria-label="网址"
            value={
              !addressFocused && !settings.showFullUrl && state?.url
                ? new URL(state.url).origin
                : address
            }
            onFocus={() => setAddressFocused(true)}
            onBlur={() => setAddressFocused(false)}
            onChange={(event) => setAddress(event.target.value)}
            placeholder="输入网址"
            autoComplete="off"
            spellCheck={false}
          />
        </form>
        <button
          type="button"
          className="browser-icon-button browser-external"
          title="系统浏览器打开"
          aria-label="系统浏览器打开"
          disabled={!target}
          onClick={() => void external(target)}
        >
          <BrowserIcon name="external" />
        </button>
        <BrowserMenu
          open={menuOpen}
          onOpenChange={setMenuOpen}
          available={state?.available === true}
          onImport={() => setImportOpen(true)}
          onNewTab={() => void control({ kind: 'newtab' })}
          onClear={() =>
            void control({ kind: 'close' }).then(() =>
              control({ kind: 'attach' }),
            )
          }
        />
      </header>
      {(notice || busy) && (
        <div className="browser-notice" role="status" aria-live="polite">
          {notice ?? '正在加载…'}
          {state?.status === 'failed' && state.url?.startsWith('https:') && (
            <button
              type="button"
              onClick={() =>
                void navigate(state.url!.replace(/^https:/, 'http:'))
              }
            >
              尝试 HTTP
            </button>
          )}
        </div>
      )}
      {bannerVisible && state?.available && (
        <div className="browser-import-banner">
          <BrowserIcon name="globe" />
          <div>
            <strong>从系统浏览器导入数据</strong>
            <span>导入 Chrome / Edge 的密码和 Cookie</span>
          </div>
          <button type="button" onClick={() => setImportOpen(true)}>
            导入
          </button>
          <button
            type="button"
            className="browser-icon-button"
            aria-label="关闭导入提示"
            onClick={() => setBannerVisible(false)}
          >
            <BrowserIcon name="close" />
          </button>
        </div>
      )}
      <div className="browser-viewport" ref={viewport}>
        {!state?.url ? (
          <div className="browser-start-page">
            <p className="browser-mode">
              {state?.available ? '临时浏览会话' : '系统浏览器模式'}
            </p>
            <h2>工具</h2>
            <div className="browser-start-tools">
              <button type="button" onClick={onWorkspace}>
                <BrowserIcon name="folder" />
                <span>工作区文件</span>
                <span aria-hidden="true">→</span>
              </button>
              <button type="button" onClick={onTerminal}>
                <BrowserIcon name="terminal" />
                <span>终端</span>
                <span aria-hidden="true">→</span>
              </button>
            </div>
            <p className="browser-start-hint">
              {state?.available
                ? '输入 HTTP / HTTPS 网址开始浏览。关闭整个浏览会话后清除临时数据。'
                : '输入网址后按 Enter，使用系统浏览器打开。'}
            </p>
          </div>
        ) : (
          <p className="browser-empty">
            {state.status === 'failed'
              ? '网页未能加载，请重试或使用系统浏览器。'
              : busy
                ? '正在加载网页…'
                : ''}
          </p>
        )}
      </div>
    </section>
  )
}
