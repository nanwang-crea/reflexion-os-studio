import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { AppMain } from '../../frontend/AppMain'
import { approval, interaction } from './chat-layout-data'
import { FloatingLayout } from './floating-layout'
import '../../frontend/styles/style.css'
import '../../frontend/features/chat/chat.css'
import '../../frontend/features/browser/browser.css'
import '../../frontend/features/terminal/terminal.css'
import '../../frontend/features/settings/settings.css'
import '../../frontend/styles/sidebar.css'
import '../../frontend/features/workspace/workspace.css'
import '../../frontend/styles/product-surfaces.css'

const noop = () => {}
const done = async () => {}
const timestamp = '2026-10-21T00:00:00.000Z'
const project = {
  id: 'p',
  name: 'reflexion-os-studio',
  folderPath: '/synthetic/project/reflexion-os-studio',
  createdAt: timestamp,
  updatedAt: timestamp,
}
const sessions = Array.from({ length: 20 }, (_, index) => ({
  id: `s${index}`,
  projectId: 'p',
  gitBranch: null,
  title: `历史会话 ${index} · 检查消息输入区与终端面板布局`,
  status: 'active' as const,
  executionMode: 'execute' as const,
  createdAt: timestamp,
  updatedAt: timestamp,
}))

function Fixture() {
  const query = new URLSearchParams(location.search)
  const [open, setOpen] = useState(false)
  const [width, setWidth] = useState(600)
  const [terminalOpen, setTerminalOpen] = useState(true)
  const [sent, setSent] = useState('')
  const [resolved, setResolved] = useState('')
  const crowded = query.has('crowded')
  const [danger, setDanger] = useState(query.has('danger'))
  const common = {
    hasEnabledProvider: !query.has('no-provider'),
    permissionValue: 'workspace-write' as const,
    onPermissionChange: noop,
    modelOptions: [{ key: 'demo', label: '示例模型', group: '示例供应商' }],
    selectedModelKey: 'demo',
    onModelChange: noop,
    skills: [],
    agentTemplates: [],
    onSend: async (content: string) => setSent(content),
    onGoSettings: noop,
  }
  return (
    <div className="app-shell">
      <aside style={{ width: 224, flexShrink: 0 }} aria-label="侧栏" />
      <AppMain
        view={query.has('settings') ? 'settings' : 'chat'}
        activeSessionId={query.has('chat') ? 's' : null}
        topBar={{
          sidebarOpen: true,
          onToggleSidebar: noop,
          runtimeState: 'system-ready',
          statusLabel: '已就绪',
        }}
        notice={null}
        onDismissNotice={noop}
        chat={{
          ...common,
          sessionData: crowded
            ? ({
                session: { ...sessions[0], id: 's' },
                messages: [],
                runs: [{ id: 'r', status: 'running', supersededByRunId: null }],
                toolCalls: [],
                runEvents: [],
                plans: [],
              } as never)
            : null,
          onLoadOlder: done,
          delegations: [],
          streaming: {},
          streamingReasoning: {},
          runActivities: {},
          advanced: {
            approvalOverride: 'default',
            onApprovalOverrideChange: noop,
            dangerActive: false,
            onOpenDanger: noop,
          },
          dangerLease: danger
            ? ({ provider: 'test', expiresAt: Date.now() + 600000 } as never)
            : null,
          onDisableDanger: () => setDanger(false),
          onStop: done,
          onRetry: done,
          onExecutionModeChange: done,
          pendingApprovals: crowded ? [approval] : [],
          onResolveApproval: (_id, choice) => setResolved(choice),
          pendingInteractions: crowded ? [interaction] : [],
          onInteractionSubmit: async () => {
            setResolved('answer')
            return true
          },
          onEditResend: done,
        }}
        landing={{
          ...common,
          project: query.has('standalone') ? null : project,
          projects: [project],
          selectedProjectId: query.has('standalone') ? null : 'p',
          onProjectChange: noop,
          sessions,
          onSelectSession: noop,
          onRenameSession: done,
          onDeleteSession: done,
        }}
        settings={{
          profiles: [],
          onSaved: done,
          onBackToChat: noop,
          confirm: async () => true,
        }}
        instructions={{} as never}
        onUseSkill={noop}
        workspace={{
          open,
          setOpen,
          width,
          setWidth,
          panel: { openTabs: [], activeTabId: null } as never,
        }}
        terminal={{
          open: terminalOpen,
          onToggle: () => setTerminalOpen((value) => !value),
          activeProjectId: 'p',
          confirm: async () => true,
        }}
      />
      <output hidden id="sent">
        {sent}
      </output>
      <output hidden id="resolved">
        {resolved}
      </output>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(
  new URLSearchParams(location.search).has('floating') ? (
    <FloatingLayout />
  ) : (
    <Fixture />
  ),
)
