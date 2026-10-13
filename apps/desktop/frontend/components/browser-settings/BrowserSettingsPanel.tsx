import { BrowserAgentSettings } from './BrowserAgentSettings'
import { useEffect, useRef, useState } from 'react'
import './browser-settings.css'
import { DEFAULT_BROWSER_SETTINGS } from '@reflexion-os-studio/contracts'
import { BrowserPreferences } from './BrowserPreferences'
import { BrowserContacts } from './BrowserContacts'
import { BrowserSitePermissions } from './BrowserSitePermissions'
import { BrowserDownloads } from './BrowserDownloads'
import { BrowserDataPanel } from './BrowserDataPanel'
import { Select } from '../../components/forms/Select'
import type {
  BrowserCapabilities,
  BrowserSettings,
} from '@reflexion-os-studio/runtime-client'
import {
  getBrowserSettings,
  updateBrowserSettings,
} from '../../api/browser-settings'
import { getBrowserCapabilities } from '../../api/browser-capabilities'

export function BrowserSettingsPanel(): React.JSX.Element {
  const [settings, setSettings] = useState<BrowserSettings>(
    DEFAULT_BROWSER_SETTINGS,
  )
  const [capabilities, setCapabilities] = useState<BrowserCapabilities | null>(
    null,
  )
  const [notice, setNotice] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const savingRef = useRef(false)

  useEffect(() => {
    let disposed = false
    void Promise.all([getBrowserSettings(), getBrowserCapabilities()])
      .then(([stored, reported]) => {
        if (disposed) return
        setSettings(stored.settings)
        setCapabilities(reported)
        setLoaded(true)
      })
      .catch((error: unknown) => {
        if (!disposed)
          setNotice(error instanceof Error ? error.message : String(error))
      })
    return () => {
      disposed = true
    }
  }, [])

  async function save(next: BrowserSettings): Promise<void> {
    if (savingRef.current) return
    savingRef.current = true
    setSaving(true)
    setNotice(null)
    try {
      const result = await updateBrowserSettings(next)
      setSettings(result.settings)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }

  return (
    <section className="settings-panel">
      <div className="settings-panel-head settings-page-heading">
        <h3 className="settings-panel-title">浏览器</h3>
        <p className="hint">配置普通网页、localhost 与系统浏览器的路由偏好。</p>
      </div>
      {notice && (
        <p className="settings-error" role="alert">
          {notice}
        </p>
      )}
      <fieldset className="browser-settings-card" disabled={!loaded || saving}>
        <legend>链接打开方式</legend>
        <label>
          <span>默认打开方式</span>
          <Select
            disabled={!loaded || saving}
            value={settings.defaultRoute}
            onValueChange={(value) =>
              void save({
                ...settings,
                defaultRoute: value as BrowserSettings['defaultRoute'],
              })
            }
            aria-label="默认打开方式"
          >
            <option
              value="embedded"
              disabled={!capabilities?.embeddedAvailable}
            >
              内嵌浏览器
            </option>
            <option value="system">系统浏览器</option>
          </Select>
        </label>
        <label>
          <span>内嵌浏览器模式</span>
          <Select
            disabled={!loaded || saving}
            value={settings.mode}
            onValueChange={(value) =>
              void save({
                ...settings,
                mode: value as BrowserSettings['mode'],
              })
            }
            aria-label="内嵌浏览器模式"
          >
            <option
              value="embedded"
              disabled={!capabilities?.embeddedAvailable}
            >
              内嵌浏览器
            </option>
            <option value="system">始终使用系统浏览器</option>
          </Select>
        </label>
        <label>
          <span>本地 URL 打开方式</span>
          <Select
            disabled={!loaded || saving}
            value={settings.localRoute}
            onValueChange={(value) =>
              void save({
                ...settings,
                localRoute: value as BrowserSettings['localRoute'],
              })
            }
            aria-label="本地 URL 打开方式"
          >
            <option
              value="embedded"
              disabled={!capabilities?.embeddedAvailable}
            >
              内嵌浏览器
            </option>
            <option value="system">系统浏览器</option>
          </Select>
        </label>
        <label className="browser-settings-checkbox">
          <input
            type="checkbox"
            className="ui-switch"
            role="switch"
            checked={settings.showFullUrl}
            onChange={(event) =>
              void save({ ...settings, showFullUrl: event.target.checked })
            }
          />
          <span>显示完整网址（编辑时始终显示完整网址）</span>
        </label>
        {saving && <p className="hint">正在保存…</p>}
      </fieldset>
      <BrowserPreferences
        settings={settings}
        capabilities={capabilities}
        disabled={!loaded || saving}
        save={save}
      />
      <BrowserDataPanel
        supported={capabilities?.features?.dataClearing === true}
      />
      <BrowserContacts
        settings={settings}
        supported={capabilities?.features?.contactFill === true}
        save={save}
      />
      <BrowserSitePermissions
        settings={settings}
        supported={capabilities?.features?.sitePermissions ?? []}
        save={save}
      />
      <BrowserDownloads
        settings={settings}
        supported={capabilities?.features?.downloads === true}
        save={save}
      />
      <BrowserAgentSettings
        settings={settings}
        disabled={!loaded || saving}
        save={save}
      />
      {capabilities && (
        <div className="browser-capability-card">
          <strong>当前平台能力</strong>
          <span>
            {capabilities.platform} · {capabilities.status}
          </span>
          <span>
            {capabilities.embeddedAvailable
              ? '内嵌浏览器可用'
              : '内嵌浏览器不可用，将回退系统浏览器'}
          </span>
          {capabilities.notice && <p className="hint">{capabilities.notice}</p>}
        </div>
      )}
    </section>
  )
}
