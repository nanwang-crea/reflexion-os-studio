import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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

const PERMISSION_STORAGE_KEY = 'reflexion.permission-mode'

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
  const [permissionMode, setPermissionMode] = useState<string>(() => {
    const stored = localStorage.getItem(PERMISSION_STORAGE_KEY)
    return stored === 'read-only' || stored === 'workspace'
      ? stored
      : 'workspace'
  })
  const [selectedModelKey, setSelectedModelKey] = useState<string | null>(null)
  const activeProjectRef = useRef<string | null>(null)
  const activeSessionRef = useRef<string | null>(null)
  const streamingRef = useRef<Record<string, string>>({})

  const changePermissionMode = useCallback((value: string): void => {
    setPermissionMode(value)
    localStorage.setItem(PERMISSION_STORAGE_KEY, value)
  }, [])

  // 启用供应商的可用模型（按供应商分组），供 Composer 底部模型选择器使用。
  const modelOptions = useMemo(
    () =>
      profiles
        .filter((profile) => profile.enabled)
        .flatMap((profile) =>
          profile.models.map((model) => ({
            key: `${profile.id}::${model}`,
            label: model,
            group: profile.name,
          })),
        ),
    [profiles],
  )

  useEffect(() => {
    if (modelOptions.length === 0) {
      if (selectedModelKey !== null) setSelectedModelKey(null)
      return
    }
    if (
      selectedModelKey === null ||
      !modelOptions.some((option) => option.key === selectedModelKey)
    ) {
      setSelectedModelKey(modelOptions[0].key)
    }
  }, [modelOptions, selectedModelKey])

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

  /** 启动期初始数据：并行拉取，失败自动重试一次后降级为通知（非致命）。 */
  const loadInitialData = useCallback(
    async (retry = true): Promise<void> => {
      const fetchAll = () =>
        Promise.allSettled([
          refreshProfiles(),
          refreshProjects(),
          refreshStandaloneSessions(),
        ])
      const findFailure = (
        results: PromiseSettledResult<void>[],
      ): PromiseRejectedResult | undefined =>
        results.find(
          (result): result is PromiseRejectedResult =>
            result.status === 'rejected',
        )
      let failure = findFailure(await fetchAll())
      if (failure && retry) {
        // sidecar 就绪竞态等瞬时错误：稍等后自动重试一次
        await new Promise((resolve) => setTimeout(resolve, 2000))
        failure = findFailure(await fetchAll())
      }
      if (failure) fail(failure.reason)
    },
    [fail, refreshProfiles, refreshProjects, refreshStandaloneSessions],
  )

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
          // Provider/网络等失败原因必须可见：直接进顶部通知条。
          if (event.type === 'run.failed') {
            fail(new Error(event.error.message))
          }
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
      // 启动期数据拉取不属于引导本身：失败只降级为通知并自动重试一次，
      // 不把整个应用打成启动失败（sidecar 就绪竞态、瞬时错误都能自愈）。
      void loadInitialData()
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
    fail,
    loadInitialData,
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
    // 模型选择形如 `${providerId}::${model}`；未选择时由 Runtime 回退默认。
    const modelKey = selectedModelKey
    const separator = modelKey ? modelKey.indexOf('::') : -1
    const providerId =
      modelKey && separator > 0 ? modelKey.slice(0, separator) : undefined
    const model =
      modelKey && separator > 0 ? modelKey.slice(separator + 2) : undefined
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
          providerId,
          model,
        })
        sessionId = created.session.id
        setActiveSessionId(sessionId)
      } else {
        await transport.request('message.send', {
          requestId: newRequestId(),
          sessionId,
          content,
          providerId,
          model,
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
        onNewSessionInProject={selectProject}
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
            permissionValue={permissionMode}
            onPermissionChange={changePermissionMode}
            modelOptions={modelOptions}
            selectedModelKey={selectedModelKey}
            onModelChange={setSelectedModelKey}
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
            permissionValue={permissionMode}
            onPermissionChange={changePermissionMode}
            modelOptions={modelOptions}
            selectedModelKey={selectedModelKey}
            onModelChange={setSelectedModelKey}
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
