import {
  FileWriteCheckpointSchema,
  type FileWriteCheckpoint,
} from '@reflexion-os-studio/contracts'
import type { Store } from '../../../store/index.js'
import { normalizedPathKey } from '../read-state.js'

/** Only canonical successful outputs can restore this Session's uploads. */
export function restoreFileWrites(
  store: Store,
  sessionId: string,
  workspaceRoot?: string,
): Map<string, FileWriteCheckpoint> {
  const states = new Map<string, FileWriteCheckpoint>()
  for (const call of store.toolCalls.listBySession(sessionId)) {
    if (call.toolName !== 'file.write_stream' || call.status !== 'completed')
      continue
    const data = call.output?.data
    if (typeof data !== 'object' || data === null || Array.isArray(data))
      continue
    const parsed = FileWriteCheckpointSchema.safeParse(data.fileWriteCheckpoint)
    if (!parsed.success) continue
    const state = parsed.data
    if (workspaceRoot !== undefined && state.workspaceRoot !== workspaceRoot)
      continue
    states.set(normalizedPathKey(state.path), state)
  }
  return states
}

export function fileWriteProgress(state: FileWriteCheckpoint) {
  return {
    path: state.path,
    phase: state.phase,
    nextChunkIndex: state.chunks.length,
    acceptedBytes: state.nextOffset,
    chunks: state.chunks
      .slice(-4)
      .map(({ index, title }) => ({ index, title })),
  }
}
