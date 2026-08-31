import { useEffect, useState } from 'react'
import type { ProviderProfile } from '@reflexion-os-studio/runtime-client'
import { RefreshIcon } from '../../ui/icons'
import { ProviderEditor } from './ProviderEditor'
import { ProviderList } from './ProviderList'

interface SettingsViewProps {
  profiles: ProviderProfile[]
  onSaved: () => Promise<void>
}

/** 模型设置页：左栏供应商列表 + 右侧编辑器（拆分后的壳层）。 */
export function SettingsView(props: SettingsViewProps): React.JSX.Element {
  const [selectedKey, setSelectedKey] = useState<string | null>(
    props.profiles[0]?.id ?? null,
  )

  const selected = selectedKey
    ? (props.profiles.find((profile) => profile.id === selectedKey) ?? null)
    : null

  // 选中项失效（外部删除/列表刷新）时回退到第一个供应商。
  useEffect(() => {
    if (selectedKey === null || selectedKey === 'new') return
    if (!props.profiles.some((profile) => profile.id === selectedKey)) {
      setSelectedKey(props.profiles[0]?.id ?? null)
    }
  }, [props.profiles, selectedKey])

  return (
    <div className="settings-view">
      <div className="settings-head">
        <div>
          <h2>模型设置</h2>
          <p className="hint">
            管理自定义模型供应商，配置后可在聊天时选择使用。
          </p>
        </div>
        <button
          className="ghost"
          title="刷新列表"
          onClick={() => void props.onSaved()}
        >
          <RefreshIcon />
        </button>
      </div>

      <div className="provider-manager">
        <ProviderList
          profiles={props.profiles}
          selectedKey={selectedKey}
          onSelect={setSelectedKey}
          creating={false}
          onCreate={() => setSelectedKey('new')}
        />

        <section className="provider-detail">
          <ProviderEditor
            profile={selected}
            isNew={selectedKey === 'new'}
            profiles={props.profiles}
            onSaved={props.onSaved}
            onCreated={(id) => setSelectedKey(id)}
            onDeleted={() => setSelectedKey(null)}
          />
        </section>
      </div>
    </div>
  )
}
