import { useCallback, useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import type {
  Message,
  ProviderProfile,
  Project,
  Run,
  RuntimeEvent,
  Session,
} from '@reflexion-os-studio/runtime-client'
import { ChatView } from './ChatView'
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
  const [sessions, setSessions] = useState<Session[]>([])
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null)
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const [sessionData, setSessionData] = useState<SessionData | null>(null)
  const [streaming, setStreaming] = useState<Record<string, string>>({})
  const activeSessionRef = useRef<string | null>(null)
  const streamingRef = useRef<Record<string, string>>({})

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

  const refreshSessions = useCallback(async (projectId: string) => {
    const result = await transport.request<{ sessions: Session[] }>(
      'session.list',
      { requestId: newRequestId(), projectId },
    )
    setSessions(result.sessions)
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
          const sessionId = activeSessionRef.current
          if (sessionId) void refreshSessionData(sessionId)
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
  }, [refreshProfiles, refreshProjects, refreshSessionData])

  useEffect(() => {
    activeSessionRef.current = activeSessionId
  }, [activeSessionId])

  const selectProject = (projectId: string): void => {
    setActiveProjectId(projectId)
    setActiveSessionId(null)
    setSessionData(null)
    void refreshSessions(projectId)
  }

  const selectSession = (sessionId: string): void => {
    setActiveSessionId(sessionId)
    streamingRef.current = {}
    setStreaming({})
    void refreshSessionData(sessionId)
  }

  const createProject = async (name: string): Promise<void> => {
    const result = await transport.request<{ project: Project }>(
      'project.create',
      {
        requestId: newRequestId(),
        name,
      },
    )
    await refreshProjects()
    selectProject(result.project.id)
  }

  const createSession = async (title?: string): Promise<void> => {
    if (!activeProjectId) return
    const result = await transport.request<{ session: Session }>(
      'session.create',
      {
        requestId: newRequestId(),
        projectId: activeProjectId,
        title,
      },
    )
    await refreshSessions(activeProjectId)
    selectSession(result.session.id)
  }

  const sendMessage = async (content: string): Promise<void> => {
    if (!activeSessionId) return
    await transport.request('message.send', {
      requestId: newRequestId(),
      sessionId: activeSessionId,
      content,
    })
    await refreshSessionData(activeSessionId)
  }

  const stopRun = async (): Promise<void> => {
    const activeRun = sessionData?.runs.find(
      (run) => run.status === 'created' || run.status === 'running',
    )
    if (!activeRun) return
    await transport.request('run.cancel', {
      requestId: newRequestId(),
      runId: activeRun.id,
    })
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
    await transport.request('run.retry', {
      requestId: newRequestId(),
      runId: lastFinishedBadly.id,
    })
    await refreshSessionData(activeSessionId)
  }

  const hasEnabledProvider = profiles.some((profile) => profile.enabled)
  const statusLabel = bootstrap
    ? (STATUS_LABELS[bootstrap.state] ?? bootstrap.state)
    : '正在启动…'
  const runtimeReady = bootstrap?.runtimeReady ?? false

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
      <header className="topbar">
        <span className="brand">ReflexionOS Studio</span>
        <span className={`badge badge-${bootstrap?.state ?? ''}`}>
          {statusLabel}
        </span>
        <span className="spacer" />
        <button
          className={view === 'settings' ? 'active' : ''}
          onClick={() => {
            setView(view === 'settings' ? 'chat' : 'settings')
          }}
        >
          设置
        </button>
      </header>
      <div className="app-body">
        <Sidebar
          projects={projects}
          sessions={sessions}
          activeProjectId={activeProjectId}
          activeSessionId={activeSessionId}
          onSelectProject={selectProject}
          onSelectSession={selectSession}
          onCreateProject={createProject}
          onCreateSession={createSession}
        />
        <main className="main-pane">
          {view === 'settings' ? (
            <SettingsView
              profiles={profiles}
              onSaved={() => refreshProfiles()}
            />
          ) : (
            <ChatView
              sessionData={sessionData}
              streaming={streaming}
              hasEnabledProvider={hasEnabledProvider}
              hasSession={activeSessionId !== null}
              onSend={sendMessage}
              onStop={stopRun}
              onRetry={retryRun}
              onGoSettings={() => {
                setView('settings')
              }}
            />
          )}
        </main>
      </div>
    </div>
  )
}
