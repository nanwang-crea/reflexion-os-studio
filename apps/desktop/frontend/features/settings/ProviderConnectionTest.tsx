import { useState } from 'react'
import { Select } from '../../components/forms/Select'
import { testProvider } from '../../api/providers'
import { preflightProviderTest, type Draft } from './provider-form'

export function ProviderConnectionTest({
  draft,
  busy,
}: {
  draft: Draft
  busy: boolean
}): React.JSX.Element {
  const models = [
    ...new Set(draft.models.map((model) => model.trim()).filter(Boolean)),
  ]
  const [selectedModel, setSelectedModel] = useState('')
  const [testingModel, setTestingModel] = useState<string | null>(null)
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(
    null,
  )
  const model = models.includes(selectedModel)
    ? selectedModel
    : (models[0] ?? '')

  const testConnection = async (): Promise<void> => {
    if (testingModel !== null || busy) return
    const preflight = preflightProviderTest({ ...draft, models: [model] })
    if (!preflight.ok) {
      setResult({ ok: false, text: preflight.error })
      return
    }
    setTestingModel(model)
    setResult(null)
    try {
      const response = await testProvider(preflight.payload)
      setResult({
        ok: response.ok,
        text: response.ok
          ? `连接正常 · ${response.model} · ${response.latencyMs}ms`
          : `连接失败 · ${response.model} · ${response.error ?? '连接失败'}`,
      })
    } catch (error) {
      setResult({
        ok: false,
        text: `连接失败 · ${model} · ${error instanceof Error ? error.message : String(error)}`,
      })
    } finally {
      setTestingModel(null)
    }
  }

  return (
    <div>
      <label className="field">
        测试模型
        <Select
          value={model}
          disabled={busy || testingModel !== null || models.length === 0}
          aria-label="测试模型"
          onValueChange={(value) => {
            setSelectedModel(value)
            setResult(null)
          }}
        >
          {models.length === 0 && <option value="">请先添加模型</option>}
          {models.map((item) => (
            <option key={item} value={item}>
              {item}
            </option>
          ))}
        </Select>
      </label>
      <p className="field-hint">
        使用当前表单配置，仅测试所选模型，无需先保存。
      </p>
      <div className="form-actions" aria-live="polite">
        <button
          className="ghost"
          disabled={busy || testingModel !== null || !model}
          onClick={() => void testConnection()}
        >
          {testingModel !== null ? `正在测试 ${testingModel}…` : '测试连接'}
        </button>
        {result && (
          <span className={result.ok ? 'saved' : 'error'}>{result.text}</span>
        )}
      </div>
    </div>
  )
}
