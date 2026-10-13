import { BrowserRuntimePanel } from './BrowserRuntimePanel'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  DEFAULT_AGENT_BROWSER_SETTINGS,
  AgentBrowserSourceSchema,
  AgentBrowserDisplaySchema,
  AgentBrowserApprovalSchema,
  type AgentBrowserSettings,
} from '@reflexion-os-studio/contracts'
import {
  getAgentBrowserSettings,
  updateAgentBrowserSettings,
} from '../../../api/agent-browser-settings'
import { Select } from '../../../components/forms/Select'
import '../../../components/browser-settings/browser-settings.css'

export function AgentBrowserSettingsPanel(): React.JSX.Element {
  const [settings, setSettings] = useState<AgentBrowserSettings>(
    DEFAULT_AGENT_BROWSER_SETTINGS,
  )
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const savingRef = useRef(false)
  useEffect(() => {
    let disposed = false
    void getAgentBrowserSettings()
      .then((stored) => {
        if (!disposed) {
          setSettings(stored)
          setLoaded(true)
        }
      })
      .catch((error: unknown) => {
        if (!disposed)
          setNotice(error instanceof Error ? error.message : String(error))
      })
    return () => {
      disposed = true
    }
  }, [])
  const save = useCallback(async (next: AgentBrowserSettings) => {
    if (savingRef.current) return
    savingRef.current = true
    setSaving(true)
    setNotice(null)
    try {
      setSettings(await updateAgentBrowserSettings(next))
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }, [])
  return (
    <section className="settings-panel">
      <div className="settings-panel-head settings-page-heading">
        <h3 className="settings-panel-title">Agent 浏览器</h3>
        <p className="hint">配置 Agent 使用的独立 Playwright 浏览器。</p>
      </div>
      <BrowserRuntimePanel />
      {notice && (
        <p className="settings-error" role="alert">
          {notice}
        </p>
      )}
      <fieldset className="browser-settings-card" disabled={!loaded || saving}>
        <legend>浏览器运行</legend>
        <label className="browser-settings-field">
          <span>浏览器来源</span>
          <Select
            aria-label="Agent 浏览器来源"
            value={settings.source}
            onValueChange={(value) =>
              void save({
                ...settings,
                source: AgentBrowserSourceSchema.parse(value),
              })
            }
          >
            <option value="auto">自动选择（优先本机 Chrome）</option>
            <option value="system-chrome">仅本机 Chrome</option>
            <option value="managed">仅受管 Chromium</option>
          </Select>
        </label>
        <p className="hint">
          复用 Chrome
          程序，仍使用独立临时会话，不读取日常浏览器登录态。自动模式下本机
          Chrome 启动失败时，仅在受管版本已安装的情况下回退。
        </p>
        <label className="browser-settings-checkbox">
          <input
            type="checkbox"
            className="ui-switch"
            role="switch"
            checked={settings.enabled}
            onChange={(event) =>
              void save({ ...settings, enabled: event.target.checked })
            }
          />
          <span>允许 Agent 请求浏览器工具</span>
        </label>
        <label className="browser-settings-field">
          <span>显示模式</span>
          <Select
            aria-label="Agent 浏览器显示模式"
            value={settings.display}
            onValueChange={(value) =>
              void save({
                ...settings,
                display: AgentBrowserDisplaySchema.parse(value),
              })
            }
          >
            <option value="headless">无头运行（不显示窗口）</option>
            <option value="headed">显示浏览器窗口（有头模式）</option>
          </Select>
        </label>
        <label className="browser-settings-field">
          <span>批准模式</span>
          <Select
            aria-label="Agent 浏览器批准模式"
            value={settings.approval}
            onValueChange={(value) =>
              void save({
                ...settings,
                approval: AgentBrowserApprovalSchema.parse(value),
              })
            }
          >
            <option value="follow-session">跟随对话权限</option>
            <option value="ask">每次询问</option>
            <option value="allow-read-only">自动允许只读浏览</option>
          </Select>
        </label>
        <p className="hint">
          跟随对话权限时，“工作区完全允许”自动批准当前浏览器工具；其他档位仍询问。对话的“所有操作均询问”始终优先。
        </p>
        <p className="hint">
          自动允许只读浏览仅覆盖导航、读取和关闭；敏感内容、私网与页面版本检查仍生效。
        </p>
        <p className="hint">
          显示窗口后，可以观察 Agent
          打开的网页。浏览器在获准导航时启动，在任务结束或取消时关闭。
        </p>
        <p className="hint">
          切换来源、显示或批准模式会关闭当前 Agent
          浏览器，下一次导航使用新配置。
        </p>
        <p className="hint">使用临时隔离会话，不加载用户浏览器资料。</p>
        {saving && (
          <p className="hint" role="status">
            正在保存…
          </p>
        )}
      </fieldset>
    </section>
  )
}
