import { useState } from 'react'
import type { ReasoningEffort } from '@reflexion-os-studio/runtime-client'
import { createRoot } from 'react-dom/client'
import { Sidebar } from '../../frontend/components/Sidebar'
import { TopBar } from '../../frontend/components/TopBar'
import { LandingView } from '../../frontend/features/landing/LandingView'
import { SurfacePanelTabs } from '../../frontend/components/surfaces/SurfacePanelTabs'
import { EmptyState } from '../../frontend/components/feedback/EmptyState'
import { SettingsNavigation } from '../../frontend/features/settings/SettingsNavigation'
import { AppearancePanel } from '../../frontend/features/settings/appearance/AppearancePanel'
import { initializeTheme, setThemePreference } from '../../frontend/lib/theme'
import '../../frontend/styles/style.css'
import '../../frontend/styles/sidebar.css'
import '../../frontend/features/chat/chat.css'
import '../../frontend/features/workspace/workspace.css'
import '../../frontend/features/settings/settings.css'
import '../../frontend/components/feedback/empty-state.css'
import '../../frontend/styles/product-surfaces.css'
import '../../frontend/styles/themes.css'

const noop = () => {}
const done = async () => {}
const query = new URLSearchParams(location.search)
initializeTheme()
setThemePreference(query.get('theme') === 'light' ? 'light' : 'dark')

function Fixture() {
  const [modelKey, setModelKey] = useState('demo')
  const [effort, setEffort] = useState<ReasoningEffort | null>('high')
  const reasoning = query.get('reasoning')
  const [settings, setSettings] = useState(false)
  const [panel, setPanel] = useState(true)
  return (
    <div className="app-shell">
      <Sidebar
        open
        width={224}
        mode="chat"
        projects={[]}
        projectSessions={[]}
        standaloneSessions={[]}
        activeProjectId={null}
        activeSessionId={null}
        creatingProject={false}
        view={settings ? 'settings' : 'chat'}
        systemReady
        activeFilePath={null}
        onOpenFile={noop}
        guardDirtyBuffersThen={async () => true}
        onSelectView={() => setSettings(true)}
        onSelectProject={noop}
        onSelectSession={noop}
        onSelectStandaloneSession={noop}
        onNewSessionInProject={noop}
        onEnterProjectFiles={noop}
        onBackToChat={noop}
        onNewChat={() => setSettings(false)}
        onCreateProject={done}
        onDeleteProject={done}
        onRenameSession={done}
        onDeleteSession={done}
      />
      <main className="main-pane">
        <TopBar
          contextTitle={settings ? '设置' : '新对话'}
          sidebarOpen
          onToggleSidebar={noop}
          browserOpen={false}
          onToggleBrowser={() => setPanel(!panel)}
          showWorkspaceToggle={false}
          workspaceOpen={false}
          onToggleWorkspace={noop}
          showTerminalToggle={false}
          terminalOpen={false}
          onToggleTerminal={noop}
          runtimeState="system-ready"
          statusLabel="已就绪"
        />
        {settings ? (
          <div className="settings-view">
            <div className="settings-layout">
              <SettingsNavigation
                section="appearance"
                onSelect={noop}
                onBack={() => setSettings(false)}
              />
              <div className="settings-content">
                <div className="settings-content-inner">
                  <AppearancePanel />
                </div>
              </div>
            </div>
          </div>
        ) : (
          <div className="content-area">
            <div className="content-main">
              <LandingView
                project={null}
                projects={[]}
                selectedProjectId={null}
                onProjectChange={noop}
                sessions={[]}
                hasEnabledProvider
                permissionValue="workspace-write"
                onPermissionChange={noop}
                modelOptions={[
                  {
                    key: 'demo',
                    label: '示例模型 · 标准',
                    group: '示例供应商',
                  },
                  ...(query.has('many-models')
                    ? Array.from({ length: 50 }, (_, index) => ({
                        key: `backup-${index}`,
                        label: `长模型名称-${index}-${'上下文与推理版本'.repeat(8)}`,
                        group: '备用供应商',
                      }))
                    : [
                        {
                          key: 'backup',
                          label: '备用模型',
                          group: '备用供应商',
                        },
                      ]),
                ]}
                selectedModelKey={modelKey}
                onModelChange={setModelKey}
                reasoningSelection={{
                  value: reasoning === 'supported' ? effort : null,
                  options: [
                    { value: 'low', label: '低' },
                    { value: 'high', label: '高' },
                  ],
                  supported: reasoning === 'supported',
                  loading: reasoning === 'loading',
                  error: reasoning === 'error' ? '能力加载失败' : null,
                  onChange: setEffort,
                }}
                skills={[]}
                agentTemplates={[]}
                onSend={done}
                onSelectSession={noop}
                onRenameSession={done}
                onDeleteSession={done}
                onGoSettings={() => setSettings(true)}
              />
            </div>
            {panel && (
              <aside className="workspace-panel" style={{ width: 300 }}>
                <SurfacePanelTabs
                  active="workspace"
                  showWorkspace
                  showCollaboration
                  expanded={false}
                  onSelect={noop}
                  onToggleExpanded={noop}
                  onCollapse={() => setPanel(false)}
                />
                <div className="workspace-panel-empty">
                  <EmptyState
                    title="选择一个项目"
                    description="在这里查看文件、变更与任务成果。"
                  />
                </div>
              </aside>
            )}
          </div>
        )}
      </main>
    </div>
  )
}
createRoot(document.getElementById('root')!).render(<Fixture />)
