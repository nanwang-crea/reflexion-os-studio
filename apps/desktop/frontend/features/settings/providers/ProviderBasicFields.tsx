import type { ProviderProfile } from '@reflexion-os-studio/runtime-client'
import { EyeIcon, PlusIcon } from '../../../ui/icons'
import type { Draft } from '../provider-form'

/** 供应商“基本配置”：名称之外最常改的 Base URL、Key 与模型列表。 */
export function ProviderBasicFields(props: {
  draft: Draft
  profile: ProviderProfile | null
  showSecret: boolean
  onToggleSecret: () => void
  onChange: (patch: Partial<Draft>) => void
}): React.JSX.Element {
  const { draft, profile, showSecret, onChange } = props
  const updateDraft = onChange
  return (
    <section className="provider-section">
      <div className="provider-section-title">基本配置</div>
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
            onClick={props.onToggleSecret}
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
    </section>
  )
}
