import type {
  ProviderModel,
  ProviderProfile,
} from '@reflexion-os-studio/runtime-client'
import { Select } from '../../../components/forms/Select'
import type { ModelDraft } from './ProviderModelsPanel'

export function ModelCapabilitiesFields({
  profile,
  config,
  draft,
  disabled,
  warning,
  onRefresh,
  onChange,
}: {
  profile: ProviderProfile
  config?: ProviderModel
  draft: ModelDraft
  disabled: boolean
  warning: string | null
  onRefresh: () => void
  onChange: (patch: Partial<ModelDraft>) => void
}): React.JSX.Element {
  const capability = config?.reasoningCapabilities
  const status = (value: boolean | null | undefined) =>
    value == null ? '未知' : value ? '支持' : '不支持'
  const source = {
    provider: '供应商元数据',
    catalog: '已知模型表',
    manual: '手动覆盖',
    unknown: '未知',
  }
  const automatic = draft.reasoningMode === 'auto'
  return (
    <>
      <p className="field-hint">
        思考：{status(capability?.thinking)}；强度调节：
        {status(capability?.effort)}；来源：
        {source[capability?.source ?? 'unknown']}。
        {capability?.checkedAt &&
          ` 获取于 ${new Date(capability.checkedAt).toLocaleString()}`}
        {profile.apiFormat === 'anthropic' &&
          ' 当前适配器暂不发送思考强度参数。'}
        {capability?.effort &&
          !capability.options &&
          ' 接口未声明具体等级，可手动填写。'}
      </p>
      <button className="ghost" disabled={disabled} onClick={onRefresh}>
        刷新模型能力
      </button>
      {warning && (
        <p className="field-hint" role="status">
          {warning}
        </p>
      )}
      <label className="field">
        能力配置方式
        <Select
          aria-label="能力配置方式"
          value={draft.reasoningMode}
          disabled={disabled}
          onValueChange={(value) => {
            onChange({ reasoningMode: value as ModelDraft['reasoningMode'] })
          }}
        >
          <option value="auto">自动识别</option>
          <option value="manual">手动覆盖</option>
        </Select>
      </label>
      <label className="field">
        模型支持思考
        <Select
          aria-label="模型支持思考"
          value={
            draft.thinkingSupported == null
              ? 'unknown'
              : String(draft.thinkingSupported)
          }
          disabled={disabled || automatic}
          onValueChange={(value) => {
            onChange({
              thinkingSupported: value === 'unknown' ? null : value === 'true',
              ...(value === 'false' ? { reasoningEffortSupported: false } : {}),
            })
          }}
        >
          <option value="unknown">未知</option>
          <option value="true">支持</option>
          <option value="false">不支持</option>
        </Select>
      </label>
      <label className="field">
        <span>
          <input
            type="checkbox"
            checked={draft.reasoningEffortSupported}
            disabled={
              disabled || automatic || profile.apiFormat === 'anthropic'
            }
            onChange={(event) => {
              onChange({ reasoningEffortSupported: event.target.checked })
            }}
          />
          模型支持思考强度
        </span>
      </label>
      <label className="field">
        支持的思考等级
        <textarea
          aria-label="支持的思考等级"
          rows={5}
          value={
            automatic && !capability?.options ? '' : draft.reasoningOptionsText
          }
          placeholder={automatic ? '支持的等级未知' : undefined}
          disabled={disabled || automatic || profile.apiFormat === 'anthropic'}
          onChange={(event) => {
            onChange({
              reasoningOptionsText: event.target.value,
              reasoningEffort: '',
            })
          }}
        />
        <span className="field-hint">
          每行填写“显示名称=实际发送值”，例如“极高=xhigh”。默认不发送参数；关闭思考需填写服务端明确支持的值。
        </span>
      </label>
    </>
  )
}
