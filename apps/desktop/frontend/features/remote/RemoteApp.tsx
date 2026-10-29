import { useCallback, useEffect, useRef, useState } from 'react'
import type { RemoteCatalog } from '@reflexion-os-studio/contracts'
import { useRemotePairing } from './useRemotePairing'
import { RemoteChat } from './RemoteChat'
import { RemoteFiles } from './RemoteFiles'
import { RemoteNavigation } from './RemoteNavigation'
import { listSessions, createSession } from '../../api/sessions'
import { request } from '../../api/client'
import type { Session } from '@reflexion-os-studio/runtime-client'

type RemoteProject = RemoteCatalog['projects'][number]
type RemoteView = 'sessions' | 'files'

export function RemoteApp(): React.JSX.Element {
  const pairing = useRemotePairing()
  const [name, setName] = useState('我的手机')
  const sessionStorageKey = `reflexion.remote.session:${location.origin}${location.pathname}`
  const [projects, setProjects] = useState<RemoteProject[]>([])
  const [view, setView] = useState<RemoteView>('sessions')
  const [navigationOpen, setNavigationOpen] = useState(false)
  const [fileTarget, setFileTarget] = useState<{
    projectId: string
    path: string
  } | null>(null)
  const [sessions, setSessions] = useState<Session[]>([])
  const [sessionsLoaded, setSessionsLoaded] = useState(false)
  const [sessionError, setSessionError] = useState<string | null>(null)
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(
    () => sessionStorage.getItem(sessionStorageKey),
  )
  const sessionLoadId = useRef(0)

  const selectSession = useCallback(
    (sessionId: string | null): void => {
      setSelectedSessionId(sessionId)
      if (sessionId) sessionStorage.setItem(sessionStorageKey, sessionId)
      else sessionStorage.removeItem(sessionStorageKey)
    },
    [sessionStorageKey],
  )
  const refreshSessions = useCallback(async (): Promise<void> => {
    const loadId = ++sessionLoadId.current
    try {
      const result = await listSessions()
      if (loadId !== sessionLoadId.current) return
      setSessions(result.sessions)
      setSessionsLoaded(true)
      setSelectedSessionId((current) => {
        if (
          current &&
          !result.sessions.some((session) => session.id === current)
        ) {
          sessionStorage.removeItem(sessionStorageKey)
          return null
        }
        return current
      })
      setSessionError(null)
    } catch {
      if (loadId !== sessionLoadId.current) return
      setSessionError('读取会话失败，请检查电脑连接')
    }
  }, [sessionStorageKey])

  useEffect(() => {
    if (!pairing.device?.approved) return
    let disposed = false
    void Promise.all([
      request<RemoteCatalog>('remote.catalog'),
      refreshSessions(),
    ])
      .then(([catalog]) => {
        if (!disposed) {
          setProjects(catalog.projects)
        }
      })
      .catch(() => {
        if (!disposed) setSessionError('读取项目列表失败，请检查电脑连接')
      })
    return () => {
      disposed = true
    }
  }, [pairing.device?.approved, refreshSessions])
  const createScopedSession = (projectId: string | null): void => {
    void createSession(projectId)
      .then(({ session }) => {
        setSessions((current) => [session, ...current])
        selectSession(session.id)
        setNavigationOpen(false)
        setView('sessions')
      })
      .catch(() => setSessionError('创建会话失败，请检查电脑连接'))
  }
  const openFile = (projectId: string, path: string): void => {
    if (!projects.some((project) => project.id === projectId)) {
      setSessionError('文件引用的项目不可用')
      return
    }
    setFileTarget({ projectId, path })
    setView('files')
  }
  const browseProject = (projectId: string): void => {
    setFileTarget({ projectId, path: '' })
    setView('files')
  }

  if (
    view === 'sessions' &&
    pairing.device?.approved &&
    selectedSessionId &&
    sessionsLoaded &&
    sessions.some((session) => session.id === selectedSessionId)
  )
    return (
      <RemoteChat
        sessionId={selectedSessionId}
        projects={projects}
        sessions={sessions}
        navigationOpen={navigationOpen}
        onToggleNavigation={() => setNavigationOpen((open) => !open)}
        onSelectSession={selectSession}
        onCreateSession={createScopedSession}
        onBrowseFiles={browseProject}
        onRefresh={() => void refreshSessions()}
        onCloseNavigation={() => setNavigationOpen(false)}
        onOpenFile={openFile}
        onBack={() => {
          selectSession(null)
          void refreshSessions()
        }}
      />
    )
  if (pairing.device?.approved && view === 'files')
    return (
      <RemoteFiles
        projects={projects}
        initialProjectId={fileTarget?.projectId}
        initialPath={fileTarget?.path}
        onBack={() => {
          setFileTarget(null)
          selectSession(null)
          setView('sessions')
        }}
      />
    )
  if (pairing.device?.approved)
    return (
      <main className="remote-home-shell">
        <RemoteNavigation
          projects={projects}
          sessions={sessions}
          activeSessionId={null}
          onSelectSession={selectSession}
          onCreateSession={createScopedSession}
          onBrowseFiles={browseProject}
          onRefresh={() => void refreshSessions()}
        />
        <section className="remote-home-content">
          <h1>所有会话</h1>
          <p>选择项目或会话继续工作。模型和工具继续在电脑执行。</p>
          {sessionError && <p role="alert">{sessionError}</p>}
          {!sessionsLoaded && !sessionError && <p>正在读取会话…</p>}
          {sessionsLoaded && sessions.length === 0 && <p>暂无会话</p>}
        </section>
      </main>
    )
  return (
    <main className="remote-pairing">
      <h1>连接电脑会话</h1>
      <p>模型、文件和工具继续在电脑执行。电脑需要保持运行。</p>
      {pairing.error && <p role="alert">{pairing.error}</p>}
      {pairing.device ? (
        <>
          <p>请在电脑核对以下配对码，并批准这台设备：</p>
          <strong className="remote-code">
            {pairing.device.verificationCode}
          </strong>
          <p>等待电脑确认。批准后可查看项目、文件和电脑上的会话。</p>
        </>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault()
            void pairing.pair(name)
          }}
        >
          <label htmlFor="device-name">设备名称</label>
          <input
            id="device-name"
            value={name}
            maxLength={80}
            onChange={(event) => setName(event.target.value)}
            required
          />
          <button className="primary" disabled={pairing.busy || !name.trim()}>
            请求连接
          </button>
        </form>
      )}
    </main>
  )
}
