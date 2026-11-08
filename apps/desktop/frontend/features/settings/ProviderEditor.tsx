import { EmptyState } from '../../components/feedback/EmptyState'
import { useEffect, useMemo, useState } from 'react'
import type { ProviderProfile } from '@reflexion-os-studio/runtime-client'
import { configureProvider, deleteProvider } from '../../api/providers'
import type { ConfirmDialogState } from '../../components/ConfirmDialog'
import { ProviderBasicFields } from './providers/ProviderBasicFields'
import { ProviderAdvancedFields } from './providers/ProviderAdvancedFields'
import {
  draftFromProfile,
  EMPTY_DRAFT,
  preflightProviderSave,
  preflightProviderToggle,
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
  confirm: (state: ConfirmDialogState) => Promise<boolean>
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
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [savedAt, setSavedAt] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const { profile, isNew } = props
  const advancedCount =
    draft === null
      ? 0
      : [
          draft.apiFormat !== 'openai-chat',
          draft.headers.length > 0,
          draft.reasoningEffort !== '',
          draft.temperature !== '',
          draft.maxTokens !== '',
          draft.contextWindow !== '',
          draft.contextBudget !== '',
        ].filter(Boolean).length

  // 草稿模板只跟随"选中哪个"变化:profile 对象引用变化(保存后外部刷新)
  // 不重建,避免把用户的未保存编辑冲掉。
  const snapshot = useMemo(() => {
    return profile ? draftFromProfile(profile) : null
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 有意只依赖 id
  }, [profile?.id])

  useEffect(() => {
    if (isNew) {
      setDraft({ ...EMPTY_DRAFT, models: [''] })
      setSavedAt(null)
      return
    }
    setDraft(snapshot === null ? null : { ...snapshot })
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
        JSON.stringify(draft.headers) !== JSON.stringify(profile.headers) ||
        draft.secret.trim() !== '' ||
        draft.enabled !== profile.enabled ||
        draft.apiFormat !== profile.apiFormat ||
        draft.reasoningEffort !== (profile.reasoningEffort ?? '') ||
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
    const confirmed = await props.confirm({
      title: '删除供应商？',
      message: `将删除“${profile.name}”及其本地配置。此操作无法撤销。`,
      confirmLabel: '删除供应商',
      danger: true,
    })
    if (!confirmed) return
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

  if (!(draft && (profile || isNew))) {
    return (
      <div className="provider-empty">
        <EmptyState
          title="配置你的模型供应商"
          description="点击左侧“添加”配置服务地址、API Key 和模型；已有配置可从列表中选择。"
        />
      </div>
    )
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
          <>
            <button
              className="ghost"
              disabled={busy}
              onClick={() => void toggleEnabled()}
            >
              {profile.enabled ? '禁用' : '启用'}
            </button>
            <button
              className="danger-text provider-delete"
              disabled={busy}
              onClick={() => void removeProvider()}
            >
              删除
            </button>
          </>
        )}
      </div>

      <ProviderBasicFields
        draft={draft}
        profile={profile}
        showSecret={showSecret}
        onToggleSecret={() => setShowSecret((current) => !current)}
        onChange={updateDraft}
      />

      <details
        className="provider-advanced"
        open={advancedOpen}
        onToggle={(event) => setAdvancedOpen(event.currentTarget.open)}
      >
        <summary>
          <span className="provider-advanced-title">高级设置</span>
          <span className="field-hint">
            API 格式、请求头、默认参数、模型单独配置与连接测试
          </span>
          {advancedCount > 0 && (
            <span className="provider-advanced-count">
              {advancedCount} 项已自定义
            </span>
          )}
        </summary>
        <ProviderAdvancedFields
          draft={draft}
          profile={profile}
          busy={busy}
          onSaved={props.onSaved}
          onChange={updateDraft}
        />
      </details>

      <div className="form-actions">
        <button
          className="primary"
          disabled={busy || !dirty}
          onClick={() => void saveDraft()}
        >
          {busy ? '保存中…' : profile ? '保存修改' : '创建供应商'}
        </button>
        {savedAt && <span className="saved">已保存 {savedAt}</span>}
        {error && <span className="error">{error}</span>}
      </div>
    </div>
  )
}
