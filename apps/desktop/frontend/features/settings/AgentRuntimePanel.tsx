import { useEffect, useRef, useState } from 'react'
import type { AgentSettings } from '@reflexion-os-studio/runtime-client'
import {
  contractRangeHint,
  formatFieldFeedbacks,
  validateCommandParams,
} from '@reflexion-os-studio/runtime-client'
import { getAgentSettings, updateAgentSettings } from '../../api/settings'
import { AgentDefinitionsPanel } from './AgentDefinitionsPanel'
import {
  AGENT_RUNTIME_FIELDS,
  AGENT_RUNTIME_FIELD_BY_KEY,
  AGENT_RUNTIME_GROUPS,
  type AgentRuntimeField,
} from './agent-runtime-fields'

function toDraft(settings: AgentSettings): Record<string, string> {
  return Object.fromEntries(
    AGENT_RUNTIME_FIELDS.map((field) => [
      field.key,
      settings[field.key] == null ? '' : String(settings[field.key]),
    ]),
  )
}

/**
 * 字段 hint = 契约范围（派生自 agent_settings.update zod）+ 语义描述。
 * 契约是范围数字的唯一真源；改上限时 UI 自动同步，不再手写常量。
 */
function buildFieldHint(field: AgentRuntimeField): string {
  const range = contractRangeHint('agent_settings.update', field.path)
  return range ? `范围：${range}。${field.description}` : field.description
}

/**
 * Agent 运行时全局设置(设置页分组):留空=内置默认;与 Provider 参数相互独立。
 */
export function AgentRuntimePanel(): React.JSX.Element {
  const [draft, setDraft] = useState<Record<string, string> | null>(null)
  const initialRef = useRef<Record<string, string> | null>(null)
  const [enableChildRuns, setEnableChildRuns] = useState(true)
  const initialEnabledRef = useRef(true)
  const [busy, setBusy] = useState(false)
  const [savedAt, setSavedAt] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let disposed = false
    void getAgentSettings()
      .then((result) => {
        if (disposed) return
        setEnableChildRuns(result.settings.enableChildRuns)
        initialEnabledRef.current = result.settings.enableChildRuns
        const next = toDraft(result.settings)
        initialRef.current = next
        setDraft(next)
      })
      .catch((caught) => {
        if (!disposed) {
          setError(caught instanceof Error ? caught.message : String(caught))
        }
      })
    return () => {
      disposed = true
    }
  }, [])

  const save = async (): Promise<void> => {
    if (draft === null || busy) return
    const settings: AgentSettings = {
      maxTurns: parseNumber(draft.maxTurns),
      reflectionThreshold: parseNumber(draft.reflectionThreshold),
      requestRetries: parseNumber(draft.requestRetries),
      requestTimeoutSec: parseNumber(draft.requestTimeoutSec),
      maxRunTimeoutSec: parseNumber(draft.maxRunTimeoutSec),
      maxRunTotalTokens: parseNumber(draft.maxRunTotalTokens),
      maxToolCalls: parseNumber(draft.maxToolCalls),
      maxContinuationTurns: parseNumber(draft.maxContinuationTurns),
      maxDepth: parseNumber(draft.maxDepth),
      maxChildRuns: parseNumber(draft.maxChildRuns),
      maxParallelChildren: parseNumber(draft.maxParallelChildren),
      maxChildTimeoutSec: parseNumber(draft.maxChildTimeoutSec),
      maxChildTotalTokens: parseNumber(draft.maxChildTotalTokens),
      enableChildRuns,
    }
    // 保存前契约预检：把"必然被后端拒"的边界值就地报出中文字段名与范围，
    // 不再吐 "Invalid params" 一句话吞掉原因。
    const feedbacks = validateCommandParams('agent_settings.update', {
      requestId: 'preflight',
      settings,
    })
    if (feedbacks) {
      setError(formatFieldFeedbacks(feedbacks))
      return
    }
    setBusy(true)
    setError(null)
    try {
      await updateAgentSettings(settings)
      initialRef.current = { ...draft }
      initialEnabledRef.current = enableChildRuns
      setSavedAt(new Date().toLocaleTimeString())
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(false)
    }
  }

  const dirty =
    draft !== null &&
    initialRef.current !== null &&
    (AGENT_RUNTIME_FIELDS.some(
      (field) => draft[field.key] !== initialRef.current?.[field.key],
    ) ||
      enableChildRuns !== initialEnabledRef.current)

  if (draft === null) {
    return <div className="agent-runtime">加载中…</div>
  }

  return (
    <div className="agent-runtime">
      <div className="agent-runtime-body">
        <AgentDefinitionsPanel />
        <section className="runtime-group">
          <h4 className="runtime-group-title">委派总开关</h4>
          <label className="agent-definition-row">
            <span>
              <strong>允许子 Agent</strong>
              <small>
                关闭后新 Run 不再获得 task 工具；进行中的子 Run 不受影响。
              </small>
            </span>
            <input
              type="checkbox"
              checked={enableChildRuns}
              onChange={(event) => setEnableChildRuns(event.target.checked)}
            />
          </label>
        </section>
        {AGENT_RUNTIME_GROUPS.map((group) => {
          return (
            <section className="runtime-group" key={group.id}>
              <h4 className="runtime-group-title">{group.title}</h4>
              <div className="agent-runtime-grid">
                {group.keys.map((key) => {
                  const field = AGENT_RUNTIME_FIELD_BY_KEY.get(key)!
                  const hint = buildFieldHint(field)
                  return (
                    <label className="field" key={field.key}>
                      {field.label}
                      <input
                        type="number"
                        min={0}
                        step={1}
                        value={draft[field.key]}
                        placeholder={field.placeholder}
                        title={hint}
                        onChange={(event) => {
                          setDraft((current) => ({
                            ...(current ?? {}),
                            [field.key]: event.target.value,
                          }))
                        }}
                      />
                      <span className="field-hint">{hint}</span>
                    </label>
                  )
                })}
              </div>
            </section>
          )
        })}
      </div>
      <div className="form-actions">
        <button
          className="primary"
          disabled={busy || !dirty}
          onClick={() => void save()}
        >
          {busy ? '保存中…' : '保存设置'}
        </button>
        {savedAt && <span className="saved">已保存 {savedAt}</span>}
        {error && (
          <span className="error" role="alert">
            {error}
          </span>
        )}
      </div>
    </div>
  )
}

/** 空串/非法输入 → null(回默认)；整数字段取整。 */
function parseNumber(text: string | undefined): number | null {
  if (text === undefined || text.trim() === '') return null
  const value = Number.parseFloat(text)
  if (!Number.isFinite(value)) return null
  return Math.trunc(value)
}
