import { useEffect, useRef, useState } from 'react'
import type { AgentSettings } from '@reflexion-os-studio/runtime-client'
import { getAgentSettings, updateAgentSettings } from '../../api/settings'

const FIELDS: {
  key: keyof AgentSettings
  label: string
  placeholder: string
  hint: string
}[] = [
  {
    key: 'maxTurns',
    label: '最大轮次（模型调用上限）',
    placeholder: '16（默认）',
    hint: '一次回复最多经历多少轮模型调用；超限如实失败，不假装完成。',
  },
  {
    key: 'reflectionThreshold',
    label: '反思阈值（失败次数）',
    placeholder: '2（默认）',
    hint: '工具失败累计达到该次数后自动注入反思消息；0 表示禁用反思。',
  },
  {
    key: 'requestRetries',
    label: '请求重试次数',
    placeholder: '2（默认）',
    hint: 'Provider 请求建立阶段失败(429/5xx/网络)自动重试次数；0 表示不重试。',
  },
  {
    key: 'requestTimeoutSec',
    label: '请求超时（秒）',
    placeholder: '120（默认）',
    hint: '单次 Provider 请求超时；流式输出期间也受此约束。',
  },
]

function toDraft(settings: AgentSettings): Record<string, string> {
  return Object.fromEntries(
    FIELDS.map((field) => [
      field.key,
      settings[field.key] == null ? '' : String(settings[field.key]),
    ]),
  )
}

/**
 * Agent 运行时全局设置(设置页分组):留空=内置默认;与 Provider 参数相互独立。
 */
export function AgentRuntimePanel(): React.JSX.Element {
  const [draft, setDraft] = useState<Record<string, string> | null>(null)
  const initialRef = useRef<Record<string, string> | null>(null)
  const [busy, setBusy] = useState(false)
  const [savedAt, setSavedAt] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let disposed = false
    void getAgentSettings()
      .then((result) => {
        if (disposed) return
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
    setBusy(true)
    setError(null)
    try {
      const settings = Object.fromEntries(
        FIELDS.map((field) => [field.key, parseNumber(draft[field.key])]),
      ) as AgentSettings
      await updateAgentSettings(settings)
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
    FIELDS.some((field) => draft[field.key] !== initialRef.current?.[field.key])

  if (draft === null) {
    return <div className="agent-runtime">加载中…</div>
  }

  return (
    <div className="agent-runtime">
      <div className="agent-runtime-head">
        <h2>Agent 运行时</h2>
        <p className="hint">
          全局生效的循环参数；留空表示内置默认（64k 预算/16 轮/2 次反思/5
          次重试/120s 超时可在 Provider 设置中单独配置）。
        </p>
      </div>
      <div className="agent-runtime-grid">
        {FIELDS.map((field) => (
          <label className="field" key={field.key}>
            {field.label}
            <input
              type="number"
              min={0}
              step={1}
              value={draft[field.key]}
              placeholder={field.placeholder}
              title={field.hint}
              onChange={(event) => {
                setDraft((current) => ({
                  ...(current ?? {}),
                  [field.key]: event.target.value,
                }))
              }}
            />
            <span className="field-hint">{field.hint}</span>
          </label>
        ))}
      </div>
      <div className="form-actions">
        <button disabled={busy || !dirty} onClick={() => void save()}>
          {busy ? '保存中…' : '保存设置'}
        </button>
        {savedAt && <span className="saved">已保存 {savedAt}</span>}
        {error && <span className="error">{error}</span>}
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
