import { useRef } from 'react'
import type {
  BrowserAction,
  BrowserSnapshot,
} from '@reflexion-os-studio/runtime-client'
import { BrowserIcon } from './BrowserIcon'

export function BrowserTabs({
  state,
  control,
}: {
  state: BrowserSnapshot | null
  control: (action: BrowserAction) => Promise<void>
}) {
  const buttons = useRef(new Map<number, HTMLButtonElement>())
  const tabs = state?.tabs ?? []
  return (
    <>
      <div className="browser-tabs" role="tablist" aria-label="浏览器标签">
        {state?.tabs.map((tab) => (
          <div
            className={`browser-current-tab${tab.id === state.activeTabId ? ' active' : ''}`}
            key={tab.id}
          >
            <button
              type="button"
              ref={(button) => {
                if (button) buttons.current.set(tab.id, button)
                else buttons.current.delete(tab.id)
              }}
              tabIndex={tab.id === state.activeTabId ? 0 : -1}
              onKeyDown={(event) => {
                if (
                  !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(
                    event.key,
                  )
                )
                  return
                event.preventDefault()
                const current = tabs.findIndex((item) => item.id === tab.id)
                const nextIndex =
                  event.key === 'Home'
                    ? 0
                    : event.key === 'End'
                      ? tabs.length - 1
                      : (current +
                          (event.key === 'ArrowRight' ? 1 : -1) +
                          tabs.length) %
                        tabs.length
                const next = tabs[nextIndex]
                if (next) {
                  void control({ kind: 'selecttab', tabId: next.id })
                  buttons.current.get(next.id)?.focus()
                }
              }}
              role="tab"
              aria-selected={tab.id === state.activeTabId}
              className="browser-tab-select"
              title={tab.url ?? '新标签页'}
              onClick={(event) => {
                event.currentTarget.focus()
                void control({ kind: 'selecttab', tabId: tab.id })
              }}
            >
              <BrowserIcon name="globe" />
              <span>{tab.title}</span>
            </button>
            <button
              type="button"
              className="browser-icon-button"
              title={`关闭 ${tab.title}`}
              aria-label={`关闭标签 ${tab.title}`}
              onClick={() => void control({ kind: 'closetab', tabId: tab.id })}
            >
              <BrowserIcon name="close" />
            </button>
          </div>
        ))}
      </div>
      <button
        type="button"
        className="browser-icon-button"
        title="新标签页"
        aria-label="新标签页"
        disabled={!state?.available || state.tabs.length >= 24}
        onClick={() => void control({ kind: 'newtab' })}
      >
        +
      </button>
    </>
  )
}
