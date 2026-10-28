import { useCallback, useEffect, useRef, useState } from 'react'
import type { RemoteCatalog } from '@reflexion-os-studio/contracts'
import { useRemotePairing } from './useRemotePairing'
import { RemoteChat } from './RemoteChat'
import { RemoteFiles } from './RemoteFiles'
import { listSessions, createSession } from '../../api/sessions'
import { request } from '../../api/client'
import { Select } from '../../components/forms/Select'
import type { Session } from '@reflexion-os-studio/runtime-client'

type RemoteProject = RemoteCatalog['projects'][number]
type RemoteView = 'sessions' | 'files'
const ALL_PROJECTS = 'all'
const STANDALONE = 'standalone'

export function RemoteApp(): React.JSX.Element {
  const pairing = useRemotePairing()
  const [name, setName] = useState('我的手机')
  const sessionStorageKey = `reflexion.remote.session:${location.origin}${location.pathname}`
  const filterStorageKey = `reflexion.remote.project:${location.origin}${location.pathname}`
  const [projects, setProjects] = useState<RemoteProject[]>([])
  const [view, setView] = useState<RemoteView>('sessions')
  const [fileTarget, setFileTarget] = useState<{
    projectId: string
    path: string
  } | null>(null)
  const [filter, setFilter] = useState(
    () => sessionStorage.getItem(filterStorageKey) ?? ALL_PROJECTS,
  )
  const [sessions, setSessions] = useState<Session[]>([])
  const [sessionsLoaded, setSessionsLoaded] = useState(false)
  const [sessionError, setSessionError] = useState<string | null>(null)
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(
    () => sessionStorage.getItem(sessionStorageKey),
  )
  const sessionLoadId = useRef(0)
  const projectFilter =
    filter === ALL_PROJECTS ? undefined : filter === STANDALONE ? null : filter

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
      const result = await listSessions(projectFilter)
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
  }, [projectFilter, sessionStorageKey])

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
          if (
            filter !== ALL_PROJECTS &&
            filter !== STANDALONE &&
            !catalog.projects.some((project) => project.id === filter)
          ) {
            setFilter(ALL_PROJECTS)
            sessionStorage.setItem(filterStorageKey, ALL_PROJECTS)
          }
        }
      })
      .catch(() => {
        if (!disposed) setSessionError('读取项目列表失败，请检查电脑连接')
      })
    return () => {
      disposed = true
    }
  }, [filter, filterStorageKey, pairing.device?.approved, refreshSessions])

  const changeFilter = (next: string): void => {
    setFilter(next)
    sessionStorage.setItem(filterStorageKey, next)
    selectSession(null)
  }
  const addSession = async (): Promise<void> => {
    try {
      const projectId =
        filter !== ALL_PROJECTS && filter !== STANDALONE ? filter : null
      const result = await createSession(projectId)
      setSessions((current) => [result.session, ...current])
      selectSession(result.session.id)
      setSessionError(null)
    } catch {
      setSessionError('创建会话失败，请检查电脑连接')
    }
  }
  const openFile = (projectId: string, path: string): void => {
    if (!projects.some((project) => project.id === projectId)) {
      setSessionError('文件引用的项目不可用')
      return
    }
    setFileTarget({ projectId, path })
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
      <main className="remote-pairing remote-home">
        <h1>电脑会话</h1>
        <p>选择项目查看会话，或浏览项目文件。模型和工具继续在电脑执行。</p>
        <div className="remote-home-toolbar">
          <Select
            value={filter}
            onValueChange={changeFilter}
            aria-label="按项目筛选会话"
          >
            <option value={ALL_PROJECTS}>所有项目与独立会话</option>
            <option value={STANDALONE}>独立会话</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </Select>
          <button className="primary" onClick={() => void addSession()}>
            {filter !== ALL_PROJECTS && filter !== STANDALONE
              ? '在此项目中新建会话'
              : '新建独立会话'}
          </button>
          <button
            className="ghost"
            disabled={projects.length === 0}
            onClick={() => setView('files')}
          >
            浏览文件
          </button>
          <button className="ghost" onClick={() => void refreshSessions()}>
            刷新
          </button>
        </div>
        {sessionError && <p role="alert">{sessionError}</p>}
        {!sessionsLoaded && !sessionError && <p>正在读取会话…</p>}
        <ul className="remote-session-list">
          {sessions.map((session) => (
            <li key={session.id}>
              <button type="button" onClick={() => selectSession(session.id)}>
                <strong>{session.title || '新会话'}</strong>
                <span>
                  {projects.find((project) => project.id === session.projectId)
                    ?.name ?? (session.projectId ? '项目会话' : '独立会话')}
                </span>
              </button>
            </li>
          ))}
        </ul>
        {sessionsLoaded && sessions.length === 0 && <p>暂无会话</p>}
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
