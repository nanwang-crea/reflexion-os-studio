import { useEffect, useState } from 'react'
import type { ProviderProfile } from '@reflexion-os-studio/runtime-client'
import {
  configureProvider,
  deleteProvider,
  testProvider,
} from '../../api/providers'
import { EyeIcon, PlusIcon, RefreshIcon, TrashIcon } from '../../ui/icons'
import { ProviderList } from './ProviderList'

interface SettingsViewProps {
  profiles: ProviderProfile[]
  onSaved: () => Promise<void>
}

interface Draft {
  /** null 表示尚未保存的新供应商。 */
  id: string | null
  name: string
  baseUrl: string
  models: string[]
  /** 新输入的明文 Key；为空表示沿用已保存的密钥。 */
  secret: string
  secretRef: string | null
  enabled: boolean
}

const EMPTY_DRAFT: Draft = {
  id: null,
  name: '',
  baseUrl: '',
  models: [''],
  secret: '',
  secretRef: null,
  enabled: true,
}

function draftFromProfile(profile: ProviderProfile): Draft {
  return {
    id: profile.id,
    name: profile.name,
    baseUrl: profile.baseUrl,
    models: [...profile.models],
    secret: '',
    secretRef: profile.secretRef,
    enabled: profile.enabled,
  }
}

export function SettingsView(props: SettingsViewProps): React.JSX.Element {
  const [selectedKey, setSelectedKey] = useState<string | null>(
    props.profiles[0]?.id ?? null,
  )
  const [draft, setDraft] = useState<Draft | null>(
    props.profiles[0] ? draftFromProfile(props.profiles[0]) : EMPTY_DRAFT,
  )
  const [showSecret, setShowSecret] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testState, setTestState] = useState<{
    ok: boolean
    text: string
  } | null>(null)
  const [busy, setBusy] = useState(false)
  const [savedAt, setSavedAt] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const selected = selectedKey
    ? (props.profiles.find((profile) => profile.id === selectedKey) ?? null)
    : null

  useEffect(() => {
    if (selectedKey === 'new') {
      setDraft({ ...EMPTY_DRAFT, models: [''] })
      setTestState(null)
      return
    }
    const target =
      props.profiles.find((profile) => profile.id === selectedKey) ??
      props.profiles[0]
    if (!target) {
      setDraft(null)
      return
    }
    setDraft(draftFromProfile(target))
    setTestState(null)
    if (selectedKey !== target.id) setSelectedKey(target.id)
  }, [selectedKey, props.profiles])

  const updateDraft = (patch: Partial<Draft>): void => {
    setDraft((current) => (current ? { ...current, ...patch } : current))
  }

  const dirty =
    draft !== null &&
    (selected
      ? draft.name !== selected.name ||
        draft.baseUrl !== selected.baseUrl ||
        draft.models.join('\u0000') !== selected.models.join('\u0000') ||
        draft.secret.trim() !== '' ||
        draft.enabled !== selected.enabled
      : draft.name.trim() !== '' ||
        draft.baseUrl.trim() !== '' ||
        draft.secret.trim() !== '' ||
        draft.models.some((model) => model.trim() !== ''))

  const saveDraft = async (): Promise<void> => {
    if (!draft || busy) return
    const models = [
      ...new Set(
        draft.models.map((model) => model.trim()).filter((model) => model),
      ),
    ]
    if (!draft.name.trim() || !draft.baseUrl.trim() || models.length === 0) {
      setError('名称、Base URL 和至少一个模型为必填项')
      return
    }
    if (!draft.id && !draft.secret.trim()) {
      setError('新供应商需要填写 API Key')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const result = await configureProvider({
        id: draft.id ?? undefined,
        name: draft.name.trim(),
        baseUrl: draft.baseUrl.trim(),
        models,
        secret: draft.secret.trim() || undefined,
        secretRef: draft.secret.trim()
          ? undefined
          : (draft.secretRef ?? undefined),
        enabled: draft.enabled,
      })
      // 新建后直接选中创建出的供应商，避免停留在空白的新建表单。
      if (!draft.id) setSelectedKey(result.profile.id)
      setDraft((current) => (current ? { ...current, secret: '' } : current))
      setSavedAt(new Date().toLocaleTimeString())
      setShowSecret(false)
      await props.onSaved()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(false)
    }
  }

  const toggleEnabled = async (): Promise<void> => {
    if (!selected || busy) return
    setBusy(true)
    setError(null)
    try {
      await configureProvider({
        id: selected.id,
        name: selected.name,
        baseUrl: selected.baseUrl,
        models: selected.models,
        secretRef: selected.secretRef,
        enabled: !selected.enabled,
      })
      await props.onSaved()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(false)
    }
  }

  const removeProvider = async (): Promise<void> => {
    if (!selected || busy) return
    setBusy(true)
    setError(null)
    try {
      await deleteProvider(selected.id)
      setSelectedKey(null)
      setSavedAt(null)
      await props.onSaved()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(false)
    }
  }

  /** 连接测试：Provider 的鉴权/网络/模型错误直接回显到界面。 */
  const testConnection = async (): Promise<void> => {
    if (!draft || testing) return
    const model = draft.models.map((item) => item.trim()).find(Boolean)
    if (!draft.baseUrl.trim() || !model) {
      setTestState({ ok: false, text: '先填写 Base URL 和至少一个模型' })
      return
    }
    if (!draft.id && !draft.secret.trim()) {
      setTestState({ ok: false, text: '请先填写 API Key' })
      return
    }
    setTesting(true)
    setTestState(null)
    try {
      const result = await testProvider({
        baseUrl: draft.baseUrl.trim(),
        model,
        secret: draft.secret.trim() || undefined,
        secretRef: draft.secret.trim()
          ? undefined
          : (draft.secretRef ?? undefined),
      })
      setTestState(
        result.ok
          ? {
              ok: true,
              text: `连接正常 · ${result.model} · ${result.latencyMs}ms`,
            }
          : { ok: false, text: result.error ?? '连接失败' },
      )
    } catch (caught) {
      setTestState({
        ok: false,
        text: caught instanceof Error ? caught.message : String(caught),
      })
    } finally {
      setTesting(false)
    }
  }

  return (
    <div className="settings-view">
      <div className="settings-head">
        <div>
          <h2>模型设置</h2>
          <p className="hint">
            管理自定义模型供应商，配置后可在聊天时选择使用。
          </p>
        </div>
        <button
          className="ghost"
          title="刷新列表"
          onClick={() => void props.onSaved()}
        >
          <RefreshIcon />
        </button>
      </div>

      <div className="provider-manager">
        <ProviderList
          profiles={props.profiles}
          selectedKey={selectedKey}
          onSelect={setSelectedKey}
          creating={false}
          onCreate={() => setSelectedKey('new')}
        />

        <section className="provider-detail">
          {draft && (selected || selectedKey === 'new') ? (
            <div className="detail-form">
              <div className="detail-head">
                <input
                  className="detail-name"
                  value={draft.name}
                  placeholder="供应商名称"
                  onChange={(event) =>
                    updateDraft({ name: event.target.value })
                  }
                />
                <span className={`badge-state${draft.enabled ? ' on' : ''}`}>
                  {draft.enabled ? '已启用' : '已禁用'}
                </span>
                {selected && (
                  <button
                    className="ghost"
                    disabled={busy}
                    onClick={() => void toggleEnabled()}
                  >
                    {selected.enabled ? '禁用' : '启用'}
                  </button>
                )}
                <span className="spacer" />
                {selected && (
                  <button
                    className="icon-btn danger"
                    title="删除供应商"
                    disabled={busy}
                    onClick={() => void removeProvider()}
                  >
                    <TrashIcon />
                  </button>
                )}
              </div>

              <label className="field">
                Base URL
                <input
                  value={draft.baseUrl}
                  placeholder="https://open.bigmodel.cn/api/paas/v4"
                  onChange={(event) =>
                    updateDraft({ baseUrl: event.target.value })
                  }
                />
              </label>
              <p className="field-hint">
                需与模型服务商匹配：GLM 用 https://open.bigmodel.cn/api/paas/v4
                · DeepSeek 用 https://api.deepseek.com · OpenAI 用
                https://api.openai.com/v1
              </p>

              <label className="field">
                API 格式
                <select defaultValue="chat-completions">
                  <option value="chat-completions">
                    Chat Completions (/chat/completions)
                  </option>
                </select>
              </label>

              <label className="field">
                API Key
                <div className="secret-row">
                  <input
                    type={showSecret ? 'text' : 'password'}
                    placeholder={selected ? '已配置（输入可覆盖）' : 'sk-…'}
                    value={draft.secret}
                    onChange={(event) =>
                      updateDraft({ secret: event.target.value })
                    }
                  />
                  <button
                    className="icon-btn"
                    title={showSecret ? '隐藏' : '显示'}
                    onClick={() => setShowSecret(!showSecret)}
                  >
                    <EyeIcon />
                  </button>
                </div>
              </label>
              <p className="field-hint">
                {selected
                  ? '留空表示沿用已保存的密钥；修改其他配置无需重新输入。'
                  : 'Key 仅在保存时传输一次并落盘到本地密钥文件（0600）。'}
              </p>

              <div className="field-label">模型列表</div>
              <div className="model-rows">
                {draft.models.map((model, index) => (
                  <div className="model-row" key={index}>
                    <input
                      value={model}
                      placeholder="模型 ID，例如 glm-4.7"
                      onChange={(event) => {
                        const next = [...draft.models]
                        next[index] = event.target.value
                        updateDraft({ models: next })
                      }}
                    />
                    {draft.models.length > 1 && (
                      <button
                        className="icon-btn"
                        title="移除模型"
                        onClick={() =>
                          updateDraft({
                            models: draft.models.filter(
                              (_, inner) => inner !== index,
                            ),
                          })
                        }
                      >
                        ×
                      </button>
                    )}
                  </div>
                ))}
              </div>
              <button
                className="ghost add-model"
                onClick={() => updateDraft({ models: [...draft.models, ''] })}
              >
                <PlusIcon />
                添加模型
              </button>

              <div className="form-actions">
                <button
                  disabled={busy || !dirty}
                  onClick={() => void saveDraft()}
                >
                  {busy ? '保存中…' : selected ? '保存修改' : '创建供应商'}
                </button>
                <button
                  className="ghost"
                  disabled={testing || busy}
                  onClick={() => void testConnection()}
                >
                  {testing ? '测试中…' : '测试连接'}
                </button>
                {savedAt && <span className="saved">已保存 {savedAt}</span>}
                {error && <span className="error">{error}</span>}
                {testState && (
                  <span className={testState.ok ? 'saved' : 'error'}>
                    {testState.text}
                  </span>
                )}
              </div>
            </div>
          ) : (
            <div className="provider-empty">选择或添加一个供应商</div>
          )}
        </section>
      </div>
    </div>
  )
}
