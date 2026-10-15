import {
  ChatArchiveSchema,
  MAX_CHAT_ARCHIVE_BYTES,
  type ChatArchive,
} from '@reflexion-os-studio/contracts'
import type { CommandContext } from '../../command-utils.js'
import { CommandError } from '../../agent/errors.js'

export async function createChatArchive(
  ctx: Pick<CommandContext, 'store' | 'assets'>,
  sessionId: string,
): Promise<ChatArchive> {
  const { store, assets } = ctx
  const session = store.sessions.get(sessionId)
  if (!session) throw new CommandError('not_found', '会话不存在')
  const runs = store.runs.listBySession(sessionId)
  if (
    runs.some((run) =>
      [
        'created',
        'running',
        'awaiting_approval',
        'awaiting_user_input',
      ].includes(run.status),
    )
  )
    throw new CommandError(
      'invalid_request',
      '请等待当前回复完成或停止回复后再导出',
    )
  const images = new Map<string, ChatArchive['images'][number]>()
  const calls = store.toolCalls.listBySession(sessionId)
  const models = new Map(runs.map((run) => [run.id, run.model]))
  const callsByMessage = new Map<string, typeof calls>()
  for (const call of calls) {
    if (call.messageId) {
      const group = callsByMessage.get(call.messageId) ?? []
      group.push(call)
      callsByMessage.set(call.messageId, group)
    }
  }
  const messages: ChatArchive['messages'] = []
  for (const message of store.messages.listBySession(sessionId)) {
    if (message.role === 'system') continue
    const imageIds: string[] = []
    for (const part of message.parts) {
      if (part.type !== 'image') continue
      imageIds.push(part.assetId)
      if (images.has(part.assetId)) continue
      const asset = store.assetStore.get(part.assetId)
      if (
        !asset ||
        !(
          asset.sessionId === sessionId ||
          (session.projectId !== null && asset.projectId === session.projectId)
        )
      )
        throw new CommandError(
          'invalid_request',
          '会话图片缺失或不属于当前会话/项目，无法完整导出',
        )
      const result = await assets.read(part.assetId)
      if (!result.base64)
        throw new CommandError(
          'invalid_request',
          '会话图片不可读取，无法完整导出',
        )
      images.set(part.assetId, {
        id: part.assetId,
        fileName: asset.fileName,
        mimeType: asset.mimeType as ChatArchive['images'][number]['mimeType'],
        base64: result.base64,
      })
    }
    const links = message.parts.flatMap((part) =>
      part.type === 'resource_link'
        ? [`[${part.label}](${part.link.uri})`]
        : [],
    )
    messages.push({
      role: message.role,
      runKey: message.runId,
      content: [message.content, ...links].filter(Boolean).join('\n\n'),
      reasoning: message.reasoning,
      createdAt: message.createdAt,
      status:
        message.status === 'completed'
          ? 'completed'
          : message.status === 'failed'
            ? 'failed'
            : 'interrupted',
      model: (message.runId ? models.get(message.runId) : null) ?? null,
      images: imageIds,
      tools: (callsByMessage.get(message.id) ?? []).map((call) => ({
        name: call.toolName,
        args: call.args ?? {},
        content: call.output?.content ?? '',
        status:
          call.status === 'completed'
            ? 'completed'
            : call.status === 'cancelled'
              ? 'cancelled'
              : 'failed',
        errorCode: call.errorCode,
      })),
    })
  }
  const archive = ChatArchiveSchema.parse({
    format: 'reflexion-chat',
    version: 1,
    exportedAt: new Date().toISOString(),
    title: session.title,
    messages,
    images: [...images.values()],
  })
  if (
    Buffer.byteLength(JSON.stringify(archive), 'utf8') > MAX_CHAT_ARCHIVE_BYTES
  )
    throw new CommandError(
      'invalid_request',
      '聊天备份超过 16MiB 上限，请减少消息图片后重试',
    )
  return archive
}
