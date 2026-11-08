import type { ProviderProfile } from '@reflexion-os-studio/runtime-client'
import { Select } from '../../../components/forms/Select'
import type { ApiFormat } from '@reflexion-os-studio/runtime-client'
import type { Draft } from '../provider-form'
import { ProviderHeadersEditor } from '../ProviderHeadersEditor'
import { ProviderParametersFields } from './ProviderParametersFields'
import { ProviderModelsPanel } from './ProviderModelsPanel'
import { ProviderConnectionTest } from '../ProviderConnectionTest'

/** 供应商“高级设置”：API 方言、附加头、默认参数、单模型覆盖与连接测试。 */
export function ProviderAdvancedFields(props: {
  draft: Draft
  profile: ProviderProfile | null
  busy: boolean
  onSaved: () => Promise<void>
  onChange: (patch: Partial<Draft>) => void
}): React.JSX.Element {
  const { draft, profile, busy, onSaved, onChange } = props
  const updateDraft = onChange
  return (
    <div className="provider-advanced-body">
      <label className="field">
        API 格式
        <Select
          value={draft.apiFormat}
          onValueChange={(value) =>
            updateDraft({ apiFormat: value as ApiFormat })
          }
        >
          <option value="openai-chat">
            OpenAI Chat Completions (/chat/completions)
          </option>
          <option value="openai-responses">
            OpenAI Responses API (/v1/responses)
          </option>
          <option value="anthropic">
            Anthropic Messages API (/v1/messages)
          </option>
        </Select>
      </label>

      <ProviderHeadersEditor
        headers={draft.headers}
        onChange={(headers) => updateDraft({ headers })}
      />

      <p className="field-hint">Provider 默认参数：对未单独配置的模型生效。</p>
      <ProviderParametersFields
        draft={draft}
        apiFormat={draft.apiFormat}
        onChange={updateDraft}
        reasoningDisabled={draft.apiFormat === 'anthropic'}
      />
      {profile && (
        <ProviderModelsPanel
          key={profile.id}
          profile={profile}
          onSaved={onSaved}
        />
      )}

      <ProviderConnectionTest
        key={profile?.id ?? 'new'}
        draft={draft}
        busy={busy}
      />
    </div>
  )
}
