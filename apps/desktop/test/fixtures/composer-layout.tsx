import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { AppMain } from '../../frontend/AppMain'
import { approval, interaction, plan } from './chat-layout-data'
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
  const [terminalOpen, setTerminalOpen] = useState(!query.has('no-terminal'))
  const [sent, setSent] = useState('')
  const [resolved, setResolved] = useState('')
  const crowded = query.has('crowded')
  const awaitingApproval = query.has('approval')
  const awaitingInteraction = query.has('interaction')
  const [pendingVisible, setPendingVisible] = useState(!query.has('delayed'))
  const [snapshotLoaded, setSnapshotLoaded] = useState(!query.has('stale-run'))
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
          sessionData:
            crowded ||
            awaitingApproval ||
            awaitingInteraction ||
            query.has('plan')
              ? ({
                  session: { ...sessions[0], id: 's' },
                  messages: [],
                  runs: [
                    {
                      id: snapshotLoaded ? 'r' : 'previous-run',
                      status: snapshotLoaded ? 'running' : 'completed',
                      supersededByRunId: null,
                    },
                  ],
                  toolCalls: [],
                  runEvents: [],
                  plans: pendingVisible && query.has('plan') ? [plan] : [],
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
          pendingApprovals: !pendingVisible
            ? []
            : crowded
              ? [approval]
              : awaitingApproval
                ? [
                    {
                      ...approval,
                      sessionId: query.has('legacy-approval')
                        ? undefined
                        : query.has('other-session')
                          ? 'other-session'
                          : 's',
                    },
                  ]
                : [],
          onResolveApproval: (_id, choice) => setResolved(choice),
          pendingInteractions: !pendingVisible
            ? []
            : crowded
              ? [interaction]
              : awaitingInteraction
                ? [
                    {
                      ...interaction,
                      sessionId: query.has('other-session')
                        ? 'other-session'
                        : 's',
                    },
                  ]
                : [],
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
          sessions: query.has('short-history')
            ? sessions.slice(0, 2)
            : sessions,
          onSelectSession: noop,
          onRenameSession: done,
          onDeleteSession: done,
        }}
        settings={{
          developer: { projects: [], profiles: [], onConversation: noop },
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
      <button hidden id="load-snapshot" onClick={() => setSnapshotLoaded(true)}>
        更新会话快照
      </button>
      <button hidden id="show-pending" onClick={() => setPendingVisible(true)}>
        收到待处理请求
      </button>
      <button hidden id="hide-pending" onClick={() => setPendingVisible(false)}>
        待处理请求已解决
      </button>
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
