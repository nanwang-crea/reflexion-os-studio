import { useCallback, useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { open } from '@tauri-apps/plugin-dialog'
import type {
  Message,
  ProviderProfile,
  Project,
  Run,
  RuntimeEvent,
  Session,
} from '@reflexion-os-studio/runtime-client'
import { ChatView } from './ChatView'
import { LandingView } from './LandingView'
import { Sidebar } from './Sidebar'
import { SettingsView } from './SettingsView'
import { newRequestId, transport } from './transport'

export interface BootstrapSnapshot {
  state: string
  runtimeReady: boolean
  systemReady: boolean
  detail?: string
}

export interface SessionData {
  session: Session | null
  messages: Message[]
  runs: Run[]
}

const STATUS_LABELS: Record<string, string> = {
  starting: '正在启动本地 Runtime…',
  'runtime-ready': 'Chat Runtime 已就绪',
  'system-ready': '系统 Runtime 已就绪',
  'system-degraded': 'Chat 可用，工具 Runtime 不可用',
  error: '启动失败',
  stopping: '正在关闭…',
}

const EVENT_TYPES_TRIGGERING_REFRESH = new Set([
  'message.completed',
  'run.completed',
  'run.failed',
  'run.cancelled',
])

export default function App() {
  const [bootstrap, setBootstrap] = useState<BootstrapSnapshot | null>(null)
  const [view, setView] = useState<'chat' | 'settings'>('chat')
  const [profiles, setProfiles] = useState<ProviderProfile[]>([])
  const [projects, setProjects] = useState<Project[]>([])
  const [projectSessions, setProjectSessions] = useState<Session[]>([])
  const [standaloneSessions, setStandaloneSessions] = useState<Session[]>([])
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null)
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const [sessionData, setSessionData] = useState<SessionData | null>(null)
  const [streaming, setStreaming] = useState<Record<string, string>>({})
  const [creatingProject, setCreatingProject] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const activeProjectRef = useRef<string | null>(null)
  const activeSessionRef = useRef<string | null>(null)
  const streamingRef = useRef<Record<string, string>>({})

  const fail = useCallback((error: unknown): void => {
    setNotice(error instanceof Error ? error.message : String(error))
  }, [])

  const refreshSessionData = useCallback(async (sessionId: string) => {
    const result = await transport.request<SessionData>('session.get', {
      requestId: newRequestId(),
      sessionId,
    })
    setSessionData(result)
  }, [])

  const refreshProfiles = useCallback(async () => {
    const result = await transport.request<{ profiles: ProviderProfile[] }>(
      'provider.list',
      { requestId: newRequestId() },
    )
    setProfiles(result.profiles)
  }, [])

  const refreshProjects = useCallback(async () => {
    const result = await transport.request<{ projects: Project[] }>(
      'project.list',
      { requestId: newRequestId() },
    )
    setProjects(result.projects)
  }, [])

  const refreshProjectSessions = useCallback(async (projectId: string) => {
    const result = await transport.request<{ sessions: Session[] }>(
      'session.list',
      { requestId: newRequestId(), projectId },
    )
    setProjectSessions(result.sessions)
  }, [])

  const refreshStandaloneSessions = useCallback(async () => {
    const result = await transport.request<{ sessions: Session[] }>(
      'session.list',
      { requestId: newRequestId(), projectId: null },
    )
    setStandaloneSessions(result.sessions)
  }, [])

  useEffect(() => {
    let unlistenState: (() => void) | undefined
    let unlistenEvents: (() => void) | undefined
    let disposed = false

    const start = async (): Promise<void> => {
      await transport.attach()
      unlistenEvents = transport.onEvent((event: RuntimeEvent) => {
        if (event.type === 'message.delta') {
          const next = {
            ...streamingRef.current,
            [event.messageId]:
              (streamingRef.current[event.messageId] ?? '') + event.delta,
          }
          streamingRef.current = next
          setStreaming(next)
          return
        }
        if (EVENT_TYPES_TRIGGERING_REFRESH.has(event.type)) {
          streamingRef.current = {}
          setStreaming({})
          // Run 结束后标题可能已被自动命名，会话列表一并刷新。
          const sessionId = activeSessionRef.current
          if (sessionId) void refreshSessionData(sessionId)
          void refreshStandaloneSessions()
          const projectId = activeProjectRef.current
          if (projectId) void refreshProjectSessions(projectId)
        }
      })
      unlistenState = await listen<BootstrapSnapshot>(
        'bootstrap:state',
        (event) => {
          if (!disposed) setBootstrap(event.payload)
        },
      )
      if (disposed) return
      setBootstrap(await invoke<BootstrapSnapshot>('bootstrap_get_state'))
      await refreshProfiles()
      await refreshProjects()
      await refreshStandaloneSessions()
    }

    void start().catch((error: unknown) => {
      setBootstrap({
        state: 'error',
        runtimeReady: false,
        systemReady: false,
        detail: String(error),
      })
    })

    return () => {
      disposed = true
      unlistenState?.()
      unlistenEvents?.()
    }
  }, [
    refreshProfiles,
    refreshProjects,
    refreshProjectSessions,
    refreshSessionData,
    refreshStandaloneSessions,
  ])

  useEffect(() => {
    activeSessionRef.current = activeSessionId
  }, [activeSessionId])

  useEffect(() => {
    activeProjectRef.current = activeProjectId
  }, [activeProjectId])

  const openSession = (sessionId: string): void => {
    setActiveSessionId(sessionId)
    streamingRef.current = {}
    setStreaming({})
    void refreshSessionData(sessionId)
  }

  const selectProject = (projectId: string): void => {
    setActiveProjectId(projectId)
    setActiveSessionId(null)
    setSessionData(null)
    setView('chat')
    void refreshProjectSessions(projectId)
  }

  const selectStandaloneSession = (sessionId: string): void => {
    setActiveProjectId(null)
    openSession(sessionId)
  }

  /** 回到“新对话”落地页；未选项目即独立对话模式。 */
  const newStandaloneChat = (): void => {
    setActiveProjectId(null)
    setActiveSessionId(null)
    setSessionData(null)
    setView('chat')
  }

  const createProject = async (): Promise<void> => {
    setCreatingProject(true)
    setNotice(null)
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: '选择项目文件夹',
      })
      if (typeof selected !== 'string' || selected === '') return
      const result = await transport.request<{ project: Project }>(
        'project.create',
        { requestId: newRequestId(), folderPath: selected },
      )
      await refreshProjects()
      selectProject(result.project.id)
    } catch (error) {
      fail(error)
    } finally {
      setCreatingProject(false)
    }
  }

  const sendMessage = async (content: string): Promise<void> => {
    setNotice(null)
    try {
      let sessionId = activeSessionId
      if (!sessionId) {
        // 落地页直接发言：选中项目则在项目内建会话，否则建独立会话。
        const created = await transport.request<{ session: Session }>(
          'session.create',
          { requestId: newRequestId(), projectId: activeProjectId },
        )
        await transport.request('message.send', {
          requestId: newRequestId(),
          sessionId: created.session.id,
          content,
        })
        sessionId = created.session.id
        setActiveSessionId(sessionId)
      } else {
        await transport.request('message.send', {
          requestId: newRequestId(),
          sessionId,
          content,
        })
      }
      await refreshSessionData(sessionId)
      await refreshStandaloneSessions()
      if (activeProjectId) await refreshProjectSessions(activeProjectId)
    } catch (error) {
      fail(error)
    }
  }

  const stopRun = async (): Promise<void> => {
    const activeRun = sessionData?.runs.find(
      (run) => run.status === 'created' || run.status === 'running',
    )
    if (!activeRun) return
    try {
      await transport.request('run.cancel', {
        requestId: newRequestId(),
        runId: activeRun.id,
      })
    } catch (error) {
      fail(error)
    }
  }

  const retryRun = async (): Promise<void> => {
    if (!activeSessionId || !sessionData) return
    const lastFinishedBadly = [...sessionData.runs]
      .reverse()
      .find(
        (run) =>
          run.status === 'failed' ||
          run.status === 'interrupted' ||
          run.status === 'cancelled',
      )
    if (!lastFinishedBadly) return
    try {
      await transport.request('run.retry', {
        requestId: newRequestId(),
        runId: lastFinishedBadly.id,
      })
      await refreshSessionData(activeSessionId)
    } catch (error) {
      fail(error)
    }
  }

  const hasEnabledProvider = profiles.some((profile) => profile.enabled)
  const statusLabel = bootstrap
    ? (STATUS_LABELS[bootstrap.state] ?? bootstrap.state)
    : '正在启动…'
  const runtimeReady = bootstrap?.runtimeReady ?? false

  const activeProject =
    projects.find((project) => project.id === activeProjectId) ?? null
  const contextTitle =
    view === 'settings'
      ? '设置'
      : activeSessionId
        ? (sessionData?.session?.title ?? '对话')
        : activeProject
          ? activeProject.name
          : '新对话'

  if (!runtimeReady) {
    return (
      <div className="boot-screen">
        <h1>ReflexionOS Studio</h1>
        <p className="boot-status">{statusLabel}</p>
        <p className="boot-detail">{bootstrap?.detail ?? 'M0 Bootstrap'}</p>
      </div>
    )
  }

  return (
    <div className="app-shell">
      <Sidebar
        projects={projects}
        projectSessions={projectSessions}
        standaloneSessions={standaloneSessions}
        activeProjectId={activeProjectId}
        activeSessionId={activeSessionId}
        creatingProject={creatingProject}
        onSelectProject={selectProject}
        onSelectProjectSession={openSession}
        onSelectStandaloneSession={selectStandaloneSession}
        onNewChat={newStandaloneChat}
        onCreateProject={createProject}
      />
      <div className="main-pane">
        <header className="topbar">
          <span className="topbar-title">{contextTitle}</span>
          <span className="spacer" />
          <span className={`badge badge-${bootstrap?.state ?? ''}`}>
            {statusLabel}
          </span>
          <button
            className="ghost"
            onClick={() => {
              setView(view === 'settings' ? 'chat' : 'settings')
            }}
          >
            设置
          </button>
        </header>

        {notice && (
          <div className="notice">
            <span>{notice}</span>
            <button className="ghost" onClick={() => setNotice(null)}>
              关闭
            </button>
          </div>
        )}

        {view === 'settings' ? (
          <SettingsView profiles={profiles} onSaved={() => refreshProfiles()} />
        ) : activeSessionId ? (
          <ChatView
            sessionData={sessionData}
            streaming={streaming}
            hasEnabledProvider={hasEnabledProvider}
            onSend={sendMessage}
            onStop={stopRun}
            onRetry={retryRun}
            onGoSettings={() => {
              setView('settings')
            }}
          />
        ) : (
          <LandingView
            project={activeProject}
            sessions={activeProject ? projectSessions : []}
            hasEnabledProvider={hasEnabledProvider}
            onSend={sendMessage}
            onSelectSession={openSession}
            onGoSettings={() => {
              setView('settings')
            }}
          />
        )}
      </div>
    </div>
  )
}
