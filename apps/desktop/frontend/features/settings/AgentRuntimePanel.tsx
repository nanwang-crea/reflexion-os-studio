import { useEffect, useRef, useState } from 'react'
import type { AgentSettings } from '@reflexion-os-studio/runtime-client'
import {
  formatFieldFeedbacks,
  validateCommandParams,
} from '@reflexion-os-studio/runtime-client'
import {
  AgentRuntimeField,
  UNLIMITED_FIELDS,
  type LimitMode,
} from './AgentRuntimeField'
import { getAgentSettings, updateAgentSettings } from '../../api/settings'
import {
  AGENT_RUNTIME_FIELDS,
  AGENT_RUNTIME_FIELD_BY_KEY,
  AGENT_RUNTIME_GROUPS,
} from './agent-runtime-fields'

function toDraft(settings: AgentSettings): Record<string, string> {
  return Object.fromEntries(
    AGENT_RUNTIME_FIELDS.map((field) => [
      field.key,
      settings[field.key] == null ? '' : String(settings[field.key]),
    ]),
  )
}

function toModes(settings: AgentSettings): Record<string, LimitMode> {
  return Object.fromEntries(
    AGENT_RUNTIME_FIELDS.map(({ key }) => [
      key,
      settings.unlimitedLimits?.includes(
        key as NonNullable<AgentSettings['unlimitedLimits']>[number],
      )
        ? 'unlimited'
        : settings[key] == null
          ? 'default'
          : 'custom',
    ]),
  )
}

/**
 * Agent 运行时全局设置(设置页分组):留空=内置默认;与 Provider 参数相互独立。
 */
export function AgentRuntimePanel(): React.JSX.Element {
  const [draft, setDraft] = useState<Record<string, string> | null>(null)
  const [modes, setModes] = useState<Record<string, LimitMode>>({})
  const initialModesRef = useRef<Record<string, LimitMode>>({})
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
        const nextModes = toModes(result.settings)
        setModes(nextModes)
        initialModesRef.current = nextModes
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
    for (const field of AGENT_RUNTIME_FIELDS) {
      if (
        UNLIMITED_FIELDS.includes(field.key) &&
        modes[field.key] === 'custom' &&
        !draft[field.key]?.trim()
      ) {
        setError(
          `请为“${field.label}”输入自定义上限，或选择“使用默认值” / “不限制”。`,
        )
        return
      }
    }
    const numeric = (key: string) =>
      UNLIMITED_FIELDS.includes(key) && modes[key] === 'default'
        ? null
        : parseNumber(draft[key])
    const settings: AgentSettings = {
      unlimitedLimits: UNLIMITED_FIELDS.filter(
        (key) => modes[key] === 'unlimited',
      ) as AgentSettings['unlimitedLimits'],
      maxTurns: numeric('maxTurns'),
      reflectionThreshold: numeric('reflectionThreshold'),
      requestRetries: numeric('requestRetries'),
      requestBackoffInitialSec: numeric('requestBackoffInitialSec'),
      requestBackoffMaxSec: numeric('requestBackoffMaxSec'),
      requestTimeoutSec: numeric('requestTimeoutSec'),
      maxRunTimeoutSec: numeric('maxRunTimeoutSec'),
      maxRunTotalTokens: numeric('maxRunTotalTokens'),
      maxToolCalls: numeric('maxToolCalls'),
      maxContinuationTurns: numeric('maxContinuationTurns'),
      maxDepth: numeric('maxDepth'),
      maxChildRuns: numeric('maxChildRuns'),
      maxParallelChildren: numeric('maxParallelChildren'),
      maxChildTimeoutSec: numeric('maxChildTimeoutSec'),
      maxChildTotalTokens: numeric('maxChildTotalTokens'),
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
      initialModesRef.current = { ...modes }
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
      (field) =>
        draft[field.key] !== initialRef.current?.[field.key] ||
        modes[field.key] !== initialModesRef.current[field.key],
    ) ||
      enableChildRuns !== initialEnabledRef.current)

  if (draft === null) {
    return <div className="agent-runtime">加载中…</div>
  }

  return (
    <div className="agent-runtime">
      <div className="agent-runtime-body">
        <section className="runtime-limit-overview">
          <p className="hint">
            8
            项运行预算支持“不限制”。默认值与“不限制”不同，保存后用于新启动的运行；已启动的任务使用启动时配置。
          </p>
          <p className="hint">
            “不限制”仅取消对应应用级预算；子任务仍随父任务停止，权限审批、无进展检测、模型与服务商限制继续生效。
          </p>
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              setModes((current) => ({
                ...current,
                ...Object.fromEntries(
                  UNLIMITED_FIELDS.map((key) => [key, 'unlimited']),
                ),
              }))
            }
          >
            将 8 项可选上限设为不限制
          </button>
          <p className="hint">
            并发最多 8 个、委派深度最多 4
            层；请求超时、有限重试和反思阈值仍单独配置。单次模型输出和上下文参数请到「设置
            → 模型供应商 → 选择供应商 → 模型独立配置」调整。
          </p>
        </section>
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
              className="ui-switch"
              role="switch"
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
                  return (
                    <AgentRuntimeField
                      key={field.key}
                      field={field}
                      value={draft[field.key] ?? ''}
                      mode={modes[field.key] ?? 'default'}
                      disabled={busy}
                      onMode={(mode) =>
                        setModes((current) => ({
                          ...current,
                          [field.key]: mode,
                        }))
                      }
                      onValue={(value) =>
                        setDraft((current) => ({
                          ...(current ?? {}),
                          [field.key]: value,
                        }))
                      }
                    />
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
