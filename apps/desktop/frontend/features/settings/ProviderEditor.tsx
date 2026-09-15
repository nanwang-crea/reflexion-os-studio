import { useEffect, useMemo, useState } from 'react'
import type { ProviderProfile } from '@reflexion-os-studio/runtime-client'
import {
  configureProvider,
  deleteProvider,
  testProvider,
} from '../../api/providers'
import { EyeIcon, PlusIcon, TrashIcon } from '../../ui/icons'
import {
  draftFromProfile,
  EMPTY_DRAFT,
  preflightProviderSave,
  preflightProviderTest,
  preflightProviderToggle,
  samplingHint,
  type Draft,
} from './provider-form'

interface ProviderEditorProps {
  /** 当前选中供应商；isNew 时必为 null。 */
  profile: ProviderProfile | null
  isNew: boolean
  profiles: ProviderProfile[]
  onSaved: () => Promise<void>
  onCreated: (id: string) => void
  onDeleted: () => void
}

/**
 * 供应商表单与操作（保存/切换启用/删除/连接测试）。
 * 选择变化时重置表单；dirty 基于选中 profile 与草稿对比。
 * 校验规则与预检逻辑在 `provider-form.ts`，此处只负责视图与状态编排。
 */
export function ProviderEditor(props: ProviderEditorProps): React.JSX.Element {
  const [draft, setDraft] = useState<Draft | null>(
    props.profile ? draftFromProfile(props.profile) : EMPTY_DRAFT,
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

  const { profile, isNew } = props

  // 草稿模板只跟随"选中哪个"变化:profile 对象引用变化(保存后外部刷新)
  // 不重建,避免把用户的未保存编辑冲掉。
  const snapshot = useMemo(() => {
    return profile ? draftFromProfile(profile) : null
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 有意只依赖 id
  }, [profile?.id])

  useEffect(() => {
    if (isNew) {
      setDraft({ ...EMPTY_DRAFT, models: [''] })
      setTestState(null)
      setSavedAt(null)
      return
    }
    setDraft(snapshot === null ? null : { ...snapshot })
    setTestState(null)
  }, [isNew, snapshot])

  const updateDraft = (patch: Partial<Draft>): void => {
    setDraft((current) => (current ? { ...current, ...patch } : current))
  }

  const dirty =
    draft !== null &&
    (profile
      ? draft.name !== profile.name ||
        draft.baseUrl !== profile.baseUrl ||
        draft.models.join('\u0000') !== profile.models.join('\u0000') ||
        draft.secret.trim() !== '' ||
        draft.enabled !== profile.enabled ||
        draft.temperature !==
          (profile.temperature == null ? '' : String(profile.temperature)) ||
        draft.maxTokens !==
          (profile.maxTokens == null ? '' : String(profile.maxTokens)) ||
        draft.contextWindow !==
          (profile.contextWindow == null
            ? ''
            : String(profile.contextWindow)) ||
        draft.contextBudget !==
          (profile.contextBudget == null ? '' : String(profile.contextBudget))
      : draft.name.trim() !== '' ||
        draft.baseUrl.trim() !== '' ||
        draft.secret.trim() !== '' ||
        draft.models.some((model) => model.trim() !== ''))

  const saveDraft = async (): Promise<void> => {
    if (!draft || busy) return
    const preflight = preflightProviderSave(draft)
    if (!preflight.ok) {
      setError(preflight.error)
      return
    }
    setBusy(true)
    setError(null)
    try {
      const result = await configureProvider(preflight.payload)
      // 新建后外层选中创建出的供应商，避免停留在空白的新建表单。
      if (!draft.id) props.onCreated(result.profile.id)
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
    if (!profile || busy) return
    const preflight = preflightProviderToggle(profile, !profile.enabled)
    if (!preflight.ok) {
      setError(preflight.error)
      return
    }
    setBusy(true)
    setError(null)
    try {
      await configureProvider(preflight.payload)
      await props.onSaved()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(false)
    }
  }

  const removeProvider = async (): Promise<void> => {
    if (!profile || busy) return
    setBusy(true)
    setError(null)
    try {
      await deleteProvider(profile.id)
      props.onDeleted()
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
    const preflight = preflightProviderTest(draft)
    if (!preflight.ok) {
      setTestState({ ok: false, text: preflight.error })
      return
    }
    setTesting(true)
    setTestState(null)
    try {
      const result = await testProvider(preflight.payload)
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

  if (!(draft && (profile || isNew))) {
    return <div className="provider-empty">选择或添加一个供应商</div>
  }

  return (
    <div className="detail-form">
      <div className="detail-head">
        <input
          className="detail-name"
          value={draft.name}
          placeholder="供应商名称"
          onChange={(event) => updateDraft({ name: event.target.value })}
        />
        <span className={`badge-state${draft.enabled ? ' on' : ''}`}>
          {draft.enabled ? '已启用' : '已禁用'}
        </span>
        {profile && (
          <button
            className="ghost"
            disabled={busy}
            onClick={() => void toggleEnabled()}
          >
            {profile.enabled ? '禁用' : '启用'}
          </button>
        )}
        <span className="spacer" />
        {profile && (
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
          onChange={(event) => updateDraft({ baseUrl: event.target.value })}
        />
      </label>
      <p className="field-hint">
        需与模型服务商匹配：GLM 用 https://open.bigmodel.cn/api/paas/v4 ·
        DeepSeek 用 https://api.deepseek.com · OpenAI 用
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
            placeholder={profile ? '已配置（输入可覆盖）' : 'sk-…'}
            value={draft.secret}
            onChange={(event) => updateDraft({ secret: event.target.value })}
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
        {profile
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
                    models: draft.models.filter((_, inner) => inner !== index),
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

      <div className="sampling-grid">
        <label className="field">
          温度（0–2，留空默认）
          <input
            type="number"
            min={0}
            max={2}
            step={0.1}
            value={draft.temperature}
            placeholder="服务端默认"
            onChange={(event) =>
              updateDraft({ temperature: event.target.value })
            }
          />
          <span className="field-hint">
            {samplingHint('temperature', '超过上限会被保存拦截')}
          </span>
        </label>
        <label className="field">
          最大输出 tokens（留空默认）
          <input
            type="number"
            min={1}
            step={1}
            value={draft.maxTokens}
            placeholder="服务端默认"
            onChange={(event) => updateDraft({ maxTokens: event.target.value })}
          />
          <span className="field-hint">
            {samplingHint('maxTokens', '输入 0 或非法值会被保存拦截')}
          </span>
        </label>
        <label className="field sampling-wide">
          模型上下文窗口 tokens（留空用保守默认预算）
          <input
            type="number"
            min={1}
            step={1}
            value={draft.contextWindow}
            placeholder="例如 128000"
            onChange={(event) =>
              updateDraft({ contextWindow: event.target.value })
            }
          />
          <span className="field-hint">
            {samplingHint('contextWindow', '按模型标称窗口填写')}
          </span>
        </label>
        <label className="field sampling-wide">
          上下文预算上限 tokens（留空默认 64000）
          <input
            type="number"
            min={1}
            step={1}
            value={draft.contextBudget}
            placeholder="例如 64000"
            onChange={(event) =>
              updateDraft({ contextBudget: event.target.value })
            }
          />
          <span className="field-hint">
            {samplingHint(
              'contextBudget',
              '实际使用取本值与上下文窗口的较小者',
            )}
          </span>
        </label>
      </div>

      <div className="form-actions">
        <button disabled={busy || !dirty} onClick={() => void saveDraft()}>
          {busy ? '保存中…' : profile ? '保存修改' : '创建供应商'}
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
  )
}
