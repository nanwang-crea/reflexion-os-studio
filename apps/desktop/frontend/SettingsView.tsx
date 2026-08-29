import { useState } from 'react'
import type { ProviderProfile } from '@reflexion-os-studio/runtime-client'
import { newRequestId, transport } from './transport'

interface SettingsViewProps {
  profiles: ProviderProfile[]
  onSaved: () => Promise<void>
}

export function SettingsView(props: SettingsViewProps): React.JSX.Element {
  const [name, setName] = useState('默认 Provider')
  const [baseUrl, setBaseUrl] = useState('https://api.openai.com/v1')
  const [model, setModel] = useState('')
  const [secret, setSecret] = useState('')
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const save = async (): Promise<void> => {
    if (!name.trim() || !baseUrl.trim() || !model.trim() || !secret) return
    setSaving(true)
    setError(null)
    try {
      const editing = props.profiles[0]
      await transport.request('provider.configure', {
        requestId: newRequestId(),
        id: editing?.id,
        name: name.trim(),
        baseUrl: baseUrl.trim(),
        model: model.trim(),
        secret,
        enabled: true,
      })
      setSecret('')
      setSavedAt(new Date().toLocaleTimeString())
      await props.onSaved()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="settings-view">
      <h2>Provider 配置</h2>
      <p className="hint">
        API Key
        仅在保存时传输一次并落盘到本地密钥文件（0600），保存后不会再次显示。
      </p>

      {props.profiles.length > 0 && (
        <ul className="profile-list">
          {props.profiles.map((profile) => (
            <li key={profile.id}>
              <strong>{profile.name}</strong>
              <span className="meta">
                {profile.model} · {profile.baseUrl} ·{' '}
                {profile.enabled ? '已启用' : '未启用'} · 密钥已配置
              </span>
            </li>
          ))}
        </ul>
      )}

      <div className="form">
        <label>
          名称
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <label>
          Base URL（OpenAI-compatible）
          <input
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
          />
        </label>
        <label>
          模型
          <input
            placeholder="例如 gpt-4o-mini"
            value={model}
            onChange={(event) => setModel(event.target.value)}
          />
        </label>
        <label>
          API Key
          <input
            type="password"
            placeholder={
              props.profiles.length > 0 ? '已配置（输入可覆盖）' : 'sk-…'
            }
            value={secret}
            onChange={(event) => setSecret(event.target.value)}
          />
        </label>
        <div className="form-actions">
          <button
            disabled={
              saving ||
              !name.trim() ||
              !baseUrl.trim() ||
              !model.trim() ||
              !secret
            }
            onClick={() => void save()}
          >
            {saving ? '保存中…' : '保存配置'}
          </button>
          {savedAt && <span className="saved">已保存 {savedAt}</span>}
          {error && <span className="error">{error}</span>}
        </div>
      </div>
    </div>
  )
}
