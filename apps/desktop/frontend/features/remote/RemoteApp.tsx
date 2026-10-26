import { useCallback, useEffect, useState } from 'react'
import { useRemotePairing } from './useRemotePairing'
import { RemoteChat } from './RemoteChat'
import { listSessions } from '../../api/sessions'
import type { Session } from '@reflexion-os-studio/runtime-client'

export function RemoteApp(): React.JSX.Element {
  const pairing = useRemotePairing()
  const [name, setName] = useState('我的手机')
  const sessionStorageKey = `reflexion.remote.session:${location.origin}${location.pathname}`
  const [sessions, setSessions] = useState<Session[]>([])
  const [sessionsLoaded, setSessionsLoaded] = useState(false)
  const [sessionError, setSessionError] = useState<string | null>(null)
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(
    () => sessionStorage.getItem(sessionStorageKey),
  )
  const selectSession = useCallback(
    (sessionId: string | null): void => {
      setSelectedSessionId(sessionId)
      if (sessionId) sessionStorage.setItem(sessionStorageKey, sessionId)
      else sessionStorage.removeItem(sessionStorageKey)
    },
    [sessionStorageKey],
  )
  const refreshSessions = useCallback(async (): Promise<void> => {
    try {
      const result = await listSessions()
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
      setSessionError('读取会话失败，请检查电脑连接')
    }
  }, [sessionStorageKey])
  useEffect(() => {
    if (!pairing.device?.approved) return
    void refreshSessions()
  }, [pairing.device?.approved, refreshSessions])
  if (
    pairing.device?.approved &&
    selectedSessionId &&
    sessionsLoaded &&
    sessions.some((session) => session.id === selectedSessionId)
  )
    return (
      <RemoteChat
        sessionId={selectedSessionId}
        onBack={() => {
          selectSession(null)
          void refreshSessions()
        }}
      />
    )
  if (pairing.device?.approved)
    return (
      <main className="remote-pairing">
        <h1>所有会话</h1>
        <p>选择要继续的电脑会话。手机连接可访问此电脑上的所有会话。</p>
        <button className="ghost" onClick={() => void refreshSessions()}>
          刷新会话
        </button>
        {sessionError && <p role="alert">{sessionError}</p>}
        {!sessionsLoaded && !sessionError && <p>正在读取会话…</p>}
        <ul className="remote-session-list">
          {sessions.map((session) => (
            <li key={session.id}>
              <button type="button" onClick={() => selectSession(session.id)}>
                <strong>{session.title || '新会话'}</strong>
                <span>{session.projectId ? '项目会话' : '独立会话'}</span>
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
          <p>
            等待电脑确认。批准后可查看电脑上的所有会话、发送消息并处理审批。
          </p>
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
