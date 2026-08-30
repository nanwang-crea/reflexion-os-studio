import type {
  Message,
  Run,
  Session,
  ToolCall,
} from '@reflexion-os-studio/runtime-client'
import { request, requestList } from './client'

/** 当前打开会话的完整视图数据（会话 + 消息 + Run + 工具调用轨迹）。 */
export interface SessionData {
  session: Session | null
  messages: Message[]
  runs: Run[]
  toolCalls: ToolCall[]
}

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

export function getSessionData(sessionId: string): Promise<SessionData> {
  return request<SessionData>('session.get', { sessionId })
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

export function deleteSession(sessionId: string): Promise<{
  removed: boolean
}> {
  return request<{ removed: boolean }>('session.delete', { sessionId })
}
