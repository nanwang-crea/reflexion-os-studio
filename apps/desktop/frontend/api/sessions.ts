import type {
  Session,
  SessionHistory,
  HistoryCursor,
} from '@reflexion-os-studio/runtime-client'
import { request, requestList } from './client'

export type SessionData = SessionHistory

/**
 * projectId 语义：string → 该项目下的会话；null → 独立会话；undefined → 全部。
 */
export function listSessions(
  projectId?: string | null,
): Promise<{ sessions: Session[] }> {
  return requestList<{ sessions: Session[] }>('session.list', { projectId })
}

export function createSession(projectId: string | null): Promise<{
  session: Session
}> {
  return request<{ session: Session }>('session.create', { projectId })
}

export function getSessionData(
  sessionId: string,
  before?: HistoryCursor,
): Promise<SessionData> {
  return request<SessionData>('session.get', { sessionId, before })
}

export function renameSession(
  sessionId: string,
  title: string,
): Promise<{ session: Session }> {
  return request<{ session: Session }>('session.rename', {
    sessionId,
    title,
  })
}

export function setSessionExecutionMode(
  sessionId: string,
  mode: Session['executionMode'],
): Promise<{ session: Session }> {
  return request<{ session: Session }>('session.execution_mode.set', {
    sessionId,
    mode,
  })
}

export function deleteSession(sessionId: string): Promise<{
  removed: boolean
}> {
  return request<{ removed: boolean }>('session.delete', { sessionId })
}
