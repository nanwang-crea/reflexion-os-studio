import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type {
  ChatArchive,
  ContentPart,
  ToolOutput,
} from '@reflexion-os-studio/contracts'

/** Import only inert history. Never restore grants, checkpoints, queues or continuations. */
export class ChatArchiveStore {
  constructor(private readonly db: DatabaseSync) {}
  restore(
    sessionId: string,
    archive: ChatArchive,
    imageIds: Map<string, string>,
  ): void {
    const imagesById = new Map(archive.images.map((image) => [image.id, image]))
    const keys = archive.messages.map((message, index) =>
      message.runKey
        ? `record:${message.runKey}`
        : message.role === 'assistant'
          ? `orphan:${index}`
          : null,
    )
    const runs = new Map<string, string>()
    const groups = new Map<string, ChatArchive['messages']>()
    for (const [index, message] of archive.messages.entries()) {
      const key = keys[index]
      if (key) {
        const group = groups.get(key) ?? []
        group.push(message)
        groups.set(key, group)
      }
    }
    for (const [key, messages] of groups) {
      const id = randomUUID()
      const last = messages
        .filter((message) => message.role === 'assistant')
        .at(-1)
      this.db
        .prepare(
          'INSERT INTO runs (id, session_id, status, model, started_at, completed_at) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run(
          id,
          sessionId,
          last?.status ?? 'interrupted',
          last?.model ?? null,
          messages[0].createdAt,
          messages.at(-1)!.createdAt,
        )
      runs.set(key, id)
    }
    for (const [index, message] of archive.messages.entries()) {
      const id = randomUUID()
      const key = keys[index]
      const runId = key ? runs.get(key)! : null
      const parts: ContentPart[] = message.content
        ? [{ type: 'text', text: message.content }]
        : []
      for (const sourceId of message.images) {
        const image = imagesById.get(sourceId)!
        parts.push({
          type: 'image',
          assetId: imageIds.get(sourceId)!,
          mimeType: image.mimeType,
        })
      }
      this.db
        .prepare(
          'INSERT INTO messages (id, session_id, run_id, role, content, parts_json, reasoning, status, created_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          id,
          sessionId,
          runId,
          message.role,
          message.content,
          JSON.stringify(parts),
          message.reasoning,
          message.status,
          message.createdAt,
          message.createdAt,
        )
      for (const tool of message.tools) {
        const output: ToolOutput = {
          type: 'tool_output',
          version: 1,
          content: tool.content,
          data: null,
          changedFiles: [],
          resourceLinks: [],
          provenance: null,
        }
        this.db
          .prepare(
            'INSERT INTO tool_calls (id, run_id, message_id, tool_name, args_json, result_json, status, error_code, created_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          )
          .run(
            randomUUID(),
            runId,
            id,
            tool.name,
            JSON.stringify(tool.args),
            JSON.stringify(output),
            tool.status,
            tool.errorCode,
            message.createdAt,
            message.createdAt,
          )
      }
    }
  }
}
