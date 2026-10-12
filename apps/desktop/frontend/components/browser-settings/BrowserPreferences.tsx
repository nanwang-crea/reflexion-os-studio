import type {
  BrowserCapabilities,
  BrowserSettings,
} from '@reflexion-os-studio/contracts'
import { Select } from '../../components/forms/Select'

export function BrowserPreferences({
  settings,
  capabilities,
  disabled,
  save,
}: {
  settings: BrowserSettings
  capabilities: BrowserCapabilities | null
  disabled: boolean
  save: (settings: BrowserSettings) => Promise<void>
}) {
  return (
    <fieldset className="browser-settings-card" disabled={disabled}>
      <legend>浏览与隐私</legend>
      <label>
        <span>搜索引擎</span>
        <Select
          aria-label="搜索引擎"
          disabled={disabled}
          value={settings.searchEngine}
          onValueChange={(value) =>
            void save({
              ...settings,
              searchEngine: value as BrowserSettings['searchEngine'],
            })
          }
        >
          <option value="google">Google</option>
          <option value="bing">Bing</option>
          <option value="duckduckgo">DuckDuckGo</option>
        </Select>
      </label>
      <label>
        <span>主页</span>
        <Select
          aria-label="主页"
          disabled={disabled}
          value={settings.homepage}
          onValueChange={(value) =>
            void save({
              ...settings,
              homepage: value as BrowserSettings['homepage'],
            })
          }
        >
          <option value="blank">空白页</option>
          <option value="google">Google</option>
          <option value="bing">Bing</option>
          <option value="duckduckgo">DuckDuckGo</option>
        </Select>
      </label>
      <label>
        <span>新标签页</span>
        <Select
          aria-label="新标签页"
          disabled={disabled}
          value={settings.newTabPage}
          onValueChange={(value) =>
            void save({
              ...settings,
              newTabPage: value as BrowserSettings['newTabPage'],
            })
          }
        >
          <option value="blank">空白页</option>
          <option value="homepage">主页</option>
        </Select>
      </label>
      <label>
        <span>会话数据</span>
        <Select
          aria-label="会话数据"
          disabled={disabled}
          value={settings.storageMode}
          onValueChange={(value) =>
            void save({
              ...settings,
              storageMode: value as BrowserSettings['storageMode'],
              saveHistory: false,
            })
          }
        >
          <option value="temporary">临时（关闭会话即清除）</option>
          <option
            value="persistent"
            disabled={!capabilities?.features?.persistentSession}
          >
            持久（独立配置）
          </option>
        </Select>
      </label>
      <p className="hint">
        切换会话类型会关闭全部标签页。持久配置保留 Cookie
        和网站数据，清理须显式操作。
      </p>
      <label className="browser-settings-checkbox">
        <input
          type="checkbox"
          disabled={disabled || settings.storageMode !== 'persistent'}
          className="ui-switch"
          role="switch"
          checked={settings.saveHistory}
          onChange={(event) =>
            void save({ ...settings, saveHistory: event.target.checked })
          }
        />
        <span>保存持久会话的本地历史记录</span>
      </label>
      <p className="hint">
        历史记录与联系信息不会自动注入
        Agent。网站权限默认拒绝；可用的原生能力在下方分别配置。
      </p>
    </fieldset>
  )
}
