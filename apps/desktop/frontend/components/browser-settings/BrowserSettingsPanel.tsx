import { useEffect, useRef, useState } from 'react'
import './browser-settings.css'
import { DEFAULT_BROWSER_SETTINGS } from '@reflexion-os-studio/contracts'
import { BrowserPreferences } from './BrowserPreferences'
import { BrowserContacts } from './BrowserContacts'
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
import { configureBrowserKeychain } from '../../api/browser'
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
  const [keychainMock, setKeychainMock] = useState(false)
  const [keychainNotice, setKeychainNotice] = useState<string | null>(null)
  const [keychainBusy, setKeychainBusy] = useState(false)
  const savingRef = useRef(false)

  useEffect(() => {
    let disposed = false
    void Promise.all([getBrowserSettings(), getBrowserCapabilities()])
      .then(([stored, reported]) => {
        if (disposed) return
        setSettings(stored.settings)
        setCapabilities(reported)
        setKeychainMock(reported.mockKeychain ?? false)
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

  async function saveKeychain(mock: boolean): Promise<void> {
    if (keychainBusy) return
    setKeychainBusy(true)
    setKeychainNotice(null)
    const previous = keychainMock
    setKeychainMock(mock)
    try {
      await configureBrowserKeychain(mock)
      const reported = await getBrowserCapabilities()
      setCapabilities(reported)
      setKeychainMock(reported.mockKeychain ?? mock)
      setKeychainNotice('已保存，重启应用后生效')
    } catch (error) {
      setKeychainMock(previous)
      setNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setKeychainBusy(false)
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
      {capabilities?.platform === 'macos' && (
        <fieldset className="browser-settings-card" disabled={keychainBusy}>
          <legend>安全存储（macOS）</legend>
          <label className="browser-settings-checkbox">
            <input
              type="checkbox"
              className="ui-switch"
              role="switch"
              checked={keychainMock}
              onChange={(event) => void saveKeychain(event.target.checked)}
            />
            <span>使用内存密钥存储（不写入系统钥匙串）</span>
          </label>
          <p className="hint">
            开启后网站数据加密密钥只保存在内存中，不访问系统钥匙串，重启后内嵌浏览器的登录状态不会保留；关闭后密钥存入系统钥匙串，首次访问需在系统弹窗中授权。修改在重启应用后生效。
          </p>
          {keychainNotice && (
            <p className="hint" role="status">
              {keychainNotice}
            </p>
          )}
        </fieldset>
      )}
      <BrowserDataPanel
        supported={capabilities?.features?.dataClearing === true}
      />
      <BrowserContacts
        settings={settings}
        supported={capabilities?.features?.contactFill === true}
        save={save}
      />
      <BrowserDownloads
        settings={settings}
        supported={capabilities?.features?.downloads === true}
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
