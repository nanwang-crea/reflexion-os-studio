import { BrowserNavigationFailure } from './BrowserNavigationFailure'
import type { BrowserNavigationCompletion } from '../../api/browser-navigation'
import { useEffect, useRef, useState } from 'react'
import { useBrowserSurface } from './useBrowserSurface'
import { useLoadingProgress } from './useLoadingProgress'
import './browser.css'
import './browser-control.css'
import { useBrowserViewport } from './useBrowserViewport'
import { BrowserIcon } from './BrowserIcon'
import { BrowserPanelHeader } from './BrowserPanelHeader'
import { BrowserImportDialog } from './BrowserImportDialog'
import { BrowserSettingsDialog } from './BrowserSettingsDialog'
import { browserHomeUrl } from '@reflexion-os-studio/contracts'
import { BrowserMenu } from './BrowserMenu'
import { BrowserLoadNotice } from './BrowserLoadNotice'
import { useBrowserSettings } from '../../api/browser-settings'
import { getBrowserCapabilities } from '../../api/browser-capabilities'

/** Trusted browser chrome; native webpage content remains a separate view. */
export function BrowserSurfacePanel({
  visible,
  navigationFailure,
  onDismissNavigationFailure,
  onWorkspace,
  onTerminal,
  onCollapse,
}: {
  visible: boolean
  navigationFailure?: BrowserNavigationCompletion | null
  onDismissNavigationFailure?: () => void
  onWorkspace: () => void
  onTerminal: () => void
  onCollapse: () => void
}): React.JSX.Element {
  const settings = useBrowserSettings()
  const [addressFocused, setAddressFocused] = useState(false)
  const addressFocus = useRef(false)
  const { state, error, control, navigate, external, externalNotice } =
    useBrowserSurface(visible && !navigationFailure)
  const activeTab = state?.tabs.find((tab) => tab.id === state.activeTabId)
  const agentTab =
    activeTab?.control === 'agent' || activeTab?.control === 'paused'
  const agentLocked = activeTab?.control === 'agent'
  const [findOpen, setFindOpen] = useState(false)
  const [find, setFind] = useState('')
  const [menuOpen, setMenuOpen] = useState(false)
  const [bannerVisible, setBannerVisible] = useState(true)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [credentialsAvailable, setCredentialsAvailable] = useState(false)
  useEffect(() => {
    let disposed = false
    void getBrowserCapabilities()
      .then((report) => {
        if (!disposed)
          setCredentialsAvailable(report.features?.passwordManagement === true)
      })
      .catch(() => {})
    return () => {
      disposed = true
    }
  }, [state?.available])
  const viewport = useRef<HTMLDivElement>(null)
  const layoutError = useBrowserViewport(
    viewport,
    visible &&
      !navigationFailure &&
      (agentTab || settings.mode !== 'system') &&
      (agentTab || Boolean(state?.url)) &&
      !menuOpen &&
      !importOpen &&
      !settingsOpen,
    state?.available === true,
    state?.activeTabId ?? null,
  )
  const [address, setAddress] = useState('')
  const addressTab = useRef<number | null>(null)
  useEffect(() => {
    if (
      !addressFocus.current ||
      addressTab.current !== (state?.activeTabId ?? null)
    )
      setAddress(state?.url ?? '')
    addressTab.current = state?.activeTabId ?? null
  }, [state?.url, state?.activeTabId])
  const target = address.trim() || state?.url || ''
  const progress = useLoadingProgress(state)
  const busy = progress.running
  if (navigationFailure)
    return (
      <section className="browser-surface-panel" aria-label="浏览器面板">
        <BrowserPanelHeader
          state={state}
          control={control}
          onWorkspace={onWorkspace}
          onCollapse={onCollapse}
        />
        <BrowserNavigationFailure
          failure={navigationFailure}
          onDismiss={() => onDismissNavigationFailure?.()}
        />
      </section>
    )
  return (
    <section className="browser-surface-panel" aria-label="浏览器面板">
      <BrowserPanelHeader
        state={state}
        control={control}
        onWorkspace={onWorkspace}
        onCollapse={onCollapse}
      />
      {agentTab && (
        <div className="browser-agent-control" role="status">
          <span>
            {activeTab?.control === 'paused'
              ? '你正在接管，Agent 已暂停操作此页'
              : 'Agent 正在使用此页'}
          </span>
          <button
            type="button"
            onClick={() =>
              void control({
                kind: activeTab?.control === 'paused' ? 'resume' : 'takeover',
              })
            }
          >
            {activeTab?.control === 'paused' ? '交还 Agent' : '接管操作'}
          </button>
        </div>
      )}
      {settingsOpen && (
        <BrowserSettingsDialog onClose={() => setSettingsOpen(false)} />
      )}
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
            disabled={agentLocked || !state?.canGoBack}
            onClick={() => void control({ kind: 'back' })}
          >
            <BrowserIcon name="back" />
          </button>
          <button
            type="button"
            className="browser-icon-button"
            title="前进"
            aria-label="前进"
            disabled={agentLocked || !state?.canGoForward}
            onClick={() => void control({ kind: 'forward' })}
          >
            <BrowserIcon name="forward" />
          </button>
          <button
            type="button"
            className="browser-icon-button"
            title={busy ? '停止' : '刷新或重试'}
            aria-label={busy ? '停止加载' : '刷新'}
            disabled={agentLocked || !state?.available || !state.url}
            onClick={() => {
              if (state?.status === 'failed' && state.url)
                void navigate(state.url)
              else void control({ kind: busy ? 'stop' : 'reload' })
            }}
          >
            <BrowserIcon name={busy ? 'close' : 'reload'} />
          </button>
          <button
            type="button"
            className="browser-icon-button"
            title="主页"
            aria-label="主页"
            disabled={agentLocked || !state?.available}
            onClick={() => {
              const url = browserHomeUrl(settings)
              if (url) void navigate(url)
              else void control({ kind: 'newtab' })
            }}
          >
            ⌂
          </button>
        </nav>
        <form
          className="browser-address"
          onSubmit={(event) => {
            event.preventDefault()
            if (!agentLocked && address.trim()) {
              const input = event.currentTarget.querySelector('input')
              void navigate(address).then(() => input?.blur())
            }
          }}
        >
          {!busy &&
            state?.status === 'ready' &&
            state.url?.startsWith('http:') && (
              <span className="browser-http" title="HTTP 连接未加密">
                不安全
              </span>
            )}
          <input
            readOnly={agentLocked}
            aria-label="网址"
            value={
              !addressFocused &&
              !settings.showFullUrl &&
              address === state?.url &&
              state?.url
                ? new URL(state.url).origin
                : address
            }
            onFocus={() => {
              addressFocus.current = true
              setAddressFocused(true)
            }}
            onBlur={() => {
              addressFocus.current = false
              setAddressFocused(false)
            }}
            onChange={(event) => setAddress(event.target.value)}
            placeholder="输入网址或搜索"
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
          available={!agentTab && state?.available === true}
          credentialsAvailable={credentialsAvailable}
          onSettings={() => setSettingsOpen(true)}
          onFind={() => setFindOpen(true)}
          onPrint={() => void control({ kind: 'print' })}
          onZoom={(factor) => void control({ kind: 'zoom', factor })}
          onImport={() => setImportOpen(true)}
          onNewTab={() => void control({ kind: 'newtab' })}
          onClear={() =>
            void control({ kind: 'closeuser' }).then(() =>
              control({ kind: 'attach' }),
            )
          }
        />
      </header>
      {findOpen && (
        <form
          className="browser-toolbar"
          onSubmit={(event) => {
            event.preventDefault()
            void control({ kind: 'find', text: find, backwards: false })
          }}
        >
          <input
            autoFocus
            aria-label="页面中查找"
            value={find}
            maxLength={1000}
            onChange={(event) => setFind(event.target.value)}
          />
          <button type="submit">下一个</button>
          <button
            type="button"
            onClick={() =>
              void control({ kind: 'find', text: find, backwards: true })
            }
          >
            上一个
          </button>
          <button type="button" onClick={() => setFindOpen(false)}>
            关闭查找
          </button>
        </form>
      )}
      <BrowserLoadNotice
        progress={progress}
        info={externalNotice}
        state={state}
        error={error ?? layoutError}
        navigate={navigate}
        external={external}
      />
      <div className="browser-viewport" ref={viewport}>
        {!agentTab &&
          credentialsAvailable &&
          bannerVisible &&
          state?.available &&
          !state.url && (
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

        {!state?.url && !agentTab ? (
          <div className="browser-start-page">
            <p className="browser-mode">
              {state?.available
                ? settings.storageMode === 'persistent'
                  ? '持久浏览会话'
                  : '临时浏览会话'
                : '系统浏览器模式'}
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
                ? '输入网址或搜索。浏览数据按设置中的会话类型保留。'
                : '输入网址后按 Enter，使用系统浏览器打开。'}
            </p>
          </div>
        ) : (
          <p className="browser-empty">
            {state?.status === 'failed'
              ? '网页未能加载，请重试或使用系统浏览器。'
              : ''}
          </p>
        )}
      </div>
    </section>
  )
}
