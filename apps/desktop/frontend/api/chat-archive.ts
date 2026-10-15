import type {
  ChatArchiveImportParams,
  Session,
} from '@reflexion-os-studio/contracts'
import { request } from './client'
export function exportChatArchive(sessionId: string, directory: string) {
  return request<{ path: string; messageCount: number }>(
    'session.archive.export',
    { sessionId, directory },
    120_000,
  )
}
export function importChatArchive(
  input: Omit<ChatArchiveImportParams, 'requestId'>,
) {
  return request<{ session: Session; messageCount: number }>(
    'session.archive.import',
    input,
    120_000,
  )
}
