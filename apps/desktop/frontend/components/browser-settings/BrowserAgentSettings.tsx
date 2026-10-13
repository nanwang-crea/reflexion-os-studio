import type { BrowserSettings } from '@reflexion-os-studio/contracts'

export function BrowserAgentSettings({
  settings,
  disabled,
  save,
}: {
  settings: BrowserSettings
  disabled: boolean
  save: (settings: BrowserSettings) => Promise<void>
}): React.JSX.Element {
  return (
    <fieldset className="browser-settings-card" disabled={disabled}>
      <legend>Agent 浏览器 · Playwright</legend>
      <label className="browser-settings-checkbox">
        <input
          type="checkbox"
          className="ui-switch"
          role="switch"
          checked={settings.agentBrowserEnabled}
          onChange={(event) =>
            void save({
              ...settings,
              agentBrowserEnabled: event.target.checked,
            })
          }
        />
        <span>允许 Agent 请求浏览器工具</span>
      </label>
      <p className="hint">
        使用独立临时浏览器，导航与页面读取逐次审批。关闭后结束所有 Agent
        浏览器任务；不访问用户浏览器资料。本批提供导航、读取和关闭。
      </p>
    </fieldset>
  )
}
