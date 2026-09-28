import type { ProviderHeader } from '@reflexion-os-studio/runtime-client'
import { PlusIcon } from '../../ui/icons'

interface ProviderHeadersEditorProps {
  headers: ProviderHeader[]
  onChange: (headers: ProviderHeader[]) => void
}

export function ProviderHeadersEditor({
  headers,
  onChange,
}: ProviderHeadersEditorProps): React.JSX.Element {
  const update = (index: number, patch: Partial<ProviderHeader>): void => {
    onChange(
      headers.map((header, inner) =>
        inner === index ? { ...header, ...patch } : header,
      ),
    )
  }

  return (
    <div className="provider-headers">
      <div className="field-label">附加请求头</div>
      {headers.map((header, index) => (
        <div className="provider-header-row" key={index}>
          <input
            aria-label={`请求头 ${index + 1} 名称`}
            value={header.name}
            placeholder="例如 anthropic-beta"
            onChange={(event) => update(index, { name: event.target.value })}
          />
          <input
            aria-label={`请求头 ${index + 1} 值`}
            value={header.value}
            placeholder="请求头值"
            onChange={(event) => update(index, { value: event.target.value })}
          />
          <button
            className="icon-btn"
            title="移除请求头"
            onClick={() =>
              onChange(headers.filter((_, inner) => inner !== index))
            }
          >
            ×
          </button>
        </div>
      ))}
      <button
        className="ghost add-model"
        onClick={() => onChange([...headers, { name: '', value: '' }])}
      >
        <PlusIcon />
        添加请求头
      </button>
      <p className="field-hint">
        用于兼容网关或模型服务的特殊标识。Authorization、x-api-key 和
        Content-Type 由 ReflexionOS 根据 API
        格式自动设置，不能在这里覆盖；请勿填写 token、Cookie 等机密。
      </p>
    </div>
  )
}
