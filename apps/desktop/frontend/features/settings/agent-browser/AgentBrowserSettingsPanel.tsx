import { BrowserRuntimePanel } from './BrowserRuntimePanel'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  DEFAULT_AGENT_BROWSER_SETTINGS,
  AgentBrowserSourceSchema,
  AgentBrowserDisplaySchema,
  AgentBrowserApprovalSchema,
  AgentBrowserLifetimeSchema,
  type AgentBrowserSettings,
} from '@reflexion-os-studio/contracts'
import {
  getAgentBrowserSettings,
  updateAgentBrowserSettings,
  closeAgentBrowserWindows,
} from '../../../api/agent-browser-settings'
import { Select } from '../../../components/forms/Select'
import '../../../components/browser-settings/browser-settings.css'

export function AgentBrowserSettingsPanel(): React.JSX.Element {
  const [settings, setSettings] = useState<AgentBrowserSettings>(
    DEFAULT_AGENT_BROWSER_SETTINGS,
  )
  const [embedded, setEmbedded] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [windowsClosed, setWindowsClosed] = useState(false)
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
    setWindowsClosed(false)
    try {
      setSettings(await updateAgentBrowserSettings(next))
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }, [])
  const closeWindows = useCallback(async () => {
    if (savingRef.current) return
    savingRef.current = true
    setSaving(true)
    setNotice(null)
    setWindowsClosed(false)
    try {
      await closeAgentBrowserWindows()
      setWindowsClosed(true)
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
        <p className="hint">
          {embedded
            ? 'Agent 使用右侧内置浏览器，页面和操作保持一致。'
            : '配置 Agent 使用的独立 Playwright 浏览器。'}
        </p>
      </div>
      <BrowserRuntimePanel onEmbedded={setEmbedded} />
      {notice && (
        <p className="settings-error" role="alert">
          {notice}
        </p>
      )}
      {windowsClosed && (
        <p className="hint" role="status">
          已关闭所有 Agent 浏览器窗口；下次获准导航时重新打开。
        </p>
      )}
      <fieldset className="browser-settings-card" disabled={!loaded || saving}>
        <legend>浏览器运行</legend>
        {!embedded && (
          <>
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
          </>
        )}
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
        {!embedded && (
          <>
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
          </>
        )}
        <label className="browser-settings-field">
          <span>回复结束后</span>
          <Select
            aria-label="Agent 浏览器保留方式"
            value={settings.lifetime}
            onValueChange={(value) =>
              void save({
                ...settings,
                lifetime: AgentBrowserLifetimeSchema.parse(value),
              })
            }
          >
            <option value="session">保留浏览器，同一会话继续使用</option>
            <option value="run">关闭浏览器，每次回复重新打开</option>
          </Select>
        </label>
        <p className="hint">
          {embedded
            ? '默认保留同一会话的临时标签。接管后 Agent 不再操作，交还后需要重新读取页面；关闭标签会撤销当前页面身份。'
            : '默认保留。回复结束或切换会话后窗口仍在，可继续查看网页；同一会话的下一次请求复用浏览器，读取仍遵守审批与页面版本检查。显示网页请选择“显示浏览器窗口”。'}
        </p>
        <button type="button" onClick={() => void closeWindows()}>
          关闭所有 Agent 浏览器窗口
        </button>
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
          跟随对话权限时，“工作区完全允许”自动批准导航、读取和关闭；其他档位仍询问。对话的“所有操作均询问”始终优先。
        </p>
        <p className="hint">
          自动允许只读浏览仅覆盖导航、读取和关闭。点击、输入、通用动作及脚本始终单独审批，展示完整动作计划与输入文本；不支持凭据、支付、上传、跨站提交或
          POST 等写入请求。
        </p>
        <p className="hint">
          浏览器在获准导航时启动。保留仅持续到本次应用退出，不保存登录态到磁盘；取消任务、删除所属会话或项目、安全拦截时仍会关闭。最多保留
          8 个活动或空闲浏览器，达到上限后可用上方按钮释放。
        </p>
        <p className="hint">
          切换来源、显示或批准模式会关闭当前 Agent
          浏览器；改为“每次回复重新打开”也会立即关闭已有窗口。下一次导航使用新配置。
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
