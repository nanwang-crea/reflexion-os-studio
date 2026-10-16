import type { ComponentProps } from 'react'
import { BrowserTabs } from './BrowserTabs'
import { BrowserIcon } from './BrowserIcon'

export function BrowserPanelHeader({
  state,
  control,
  onWorkspace,
  onCollapse,
}: ComponentProps<typeof BrowserTabs> & {
  onWorkspace: () => void
  onCollapse: () => void
}): React.JSX.Element {
  return (
    <header className="browser-tabstrip">
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
    </header>
  )
}
