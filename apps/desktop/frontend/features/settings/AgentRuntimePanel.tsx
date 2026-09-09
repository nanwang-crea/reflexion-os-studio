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
    hint: 'Provider 请求建立阶段失败(可恢复 400/429/5xx/网络)自动重试次数；范围 0–15，0 表示不重试。',
  },
  {
    key: 'requestTimeoutSec',
    label: '请求超时（秒）',
    placeholder: '120（默认）',
    hint: '单次 Provider 请求超时；流式输出期间也受此约束。',
  },
  {
    key: 'maxRunTimeoutSec',
    label: 'Run 总时长上限（秒）',
    placeholder: '900（默认）',
    hint: '一次回复的总时长上限；到点如实失败（run_timeout），不假装完成。',
  },
  {
    key: 'maxRunTotalTokens',
    label: 'Run token 总预算',
    placeholder: '120000（默认）',
    hint: '各模型轮累计（输入+输出）token 上限；按 Provider 返回的 usage 计。',
  },
  {
    key: 'maxToolCalls',
    label: '工具调用次数上限',
    placeholder: '64（默认）',
    hint: '一次回复最多执行多少次工具调用；超限以稳定错误码失败。',
  },
  {
    key: 'maxContinuationTurns',
    label: '续写轮次上限',
    placeholder: '2（默认）',
    hint: '输出被截断（length）时自动续写的最大连续轮次；耗尽如实失败。',
  },
]

/** 字段分组：每个小组独立小标题 + 分隔线，改善视觉密度。 */
// Phase 3 未启动：子 Agent 委派设置分组整体隐藏，仅保留循环与网络。
const GROUPS: {
  id: string
  title: string
  keys: (keyof AgentSettings)[]
}[] = [
  {
    id: 'loop',
    title: '循环',
    keys: [
      'maxTurns',
      'reflectionThreshold',
      'maxRunTimeoutSec',
      'maxRunTotalTokens',
      'maxToolCalls',
      'maxContinuationTurns',
    ],
  },
  {
    id: 'network',
    title: '网络',
    keys: ['requestRetries', 'requestTimeoutSec'],
  },
]

const FIELD_BY_KEY = new Map(FIELDS.map((field) => [field.key, field]))

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
        // Phase 3 未启动：委派设置不可编辑，保存时强制回 false。
        enableChildRuns: false,
      }
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
      <div className="settings-section-heading">
        <span className="settings-eyebrow">Agent 运行时</span>
        <h3>让回复过程更符合你的工作节奏</h3>
        <p className="hint">
          调整循环、反思和网络请求参数；留空时使用推荐默认值。
        </p>
      </div>
      <div className="agent-runtime-body">
        {GROUPS.map((group) => {
          return (
            <section className="runtime-group" key={group.id}>
              <h4 className="runtime-group-title">{group.title}</h4>
              <div className="agent-runtime-grid">
                {group.keys.map((key) => {
                  const field = FIELD_BY_KEY.get(key)!
                  return (
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
