import { useEffect, useState } from 'react'
import type { ProviderProfile } from '@reflexion-os-studio/runtime-client'
import type { ConfirmDialogState } from '../../components/ConfirmDialog'
import { BoxIcon, GearIcon, RefreshIcon, SparkIcon } from '../../ui/icons'
import { AgentRuntimePanel } from './AgentRuntimePanel'
import { McpPanel } from './McpPanel'
import { ProviderEditor } from './ProviderEditor'
import { ProviderList } from './ProviderList'

type SettingsSection = 'models' | 'runtime' | 'mcp'

const SECTIONS: {
  id: SettingsSection
  label: string
  hint: string
  icon: React.ReactNode
}[] = [
  {
    id: 'models',
    label: '模型供应商',
    hint: '管理自定义模型供应商',
    icon: <GearIcon size={15} />,
  },
  {
    id: 'runtime',
    label: 'Agent 运行时',
    hint: '轮次、反思与重试等全局参数',
    icon: <SparkIcon size={15} />,
  },
  {
    id: 'mcp',
    label: 'MCP 服务器',
    hint: '接入外部工具服务',
    icon: <BoxIcon size={15} />,
  },
]

interface SettingsViewProps {
  profiles: ProviderProfile[]
  onSaved: () => Promise<void>
  /** 顶部“返回对话”入口：点击回到聊天主视图。 */
  onBackToChat: () => void
  confirm: (state: ConfirmDialogState) => Promise<boolean>
}

/** 设置页：左侧分类导航 + 右侧对应面板；顶部提供返回对话入口。 */
export function SettingsView(props: SettingsViewProps): React.JSX.Element {
  const [section, setSection] = useState<SettingsSection>('models')
  const [selectedKey, setSelectedKey] = useState<string | null>(
    props.profiles[0]?.id ?? null,
  )

  const selected = selectedKey
    ? (props.profiles.find((profile) => profile.id === selectedKey) ?? null)
    : null

  // 列表异步到达后自动选中第一个；选中项失效（外部删除/列表刷新）时回退。
  useEffect(() => {
    if (selectedKey === 'new') return
    if (selectedKey === null) {
      if (props.profiles.length > 0) setSelectedKey(props.profiles[0].id)
      return
    }
    if (!props.profiles.some((profile) => profile.id === selectedKey)) {
      setSelectedKey(props.profiles[0]?.id ?? null)
    }
  }, [props.profiles, selectedKey])

  return (
    <div className="settings-view">
      <div className="settings-head">
        <button
          type="button"
          className="ghost back-to-chat"
          onClick={props.onBackToChat}
        >
          <span className="back-arrow" aria-hidden>
            ←
          </span>
          返回对话
        </button>
        <div>
          <h2>设置</h2>
          <p className="hint">配置模型、Agent 运行时与外部工具</p>
        </div>
        <button
          type="button"
          className="ghost"
          title="刷新列表"
          aria-label="刷新模型供应商列表"
          onClick={() => void props.onSaved()}
        >
          <RefreshIcon />
        </button>
      </div>

      <div className="settings-layout">
        <nav className="settings-nav" aria-label="设置分类">
          {SECTIONS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              className={`settings-nav-item${
                section === entry.id ? ' active' : ''
              }`}
              onClick={() => setSection(entry.id)}
            >
              {entry.icon}
              <span className="settings-nav-label">{entry.label}</span>
            </button>
          ))}
        </nav>

        <div className="settings-content">
          {section === 'models' && (
            <>
              <h3 className="settings-panel-title">模型供应商</h3>
              <p className="hint">
                管理自定义模型供应商，配置后可在聊天时选择使用。
              </p>
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
            </>
          )}
          {section === 'runtime' && <AgentRuntimePanel />}
          {section === 'mcp' && <McpPanel confirm={props.confirm} />}
        </div>
      </div>
    </div>
  )
}
