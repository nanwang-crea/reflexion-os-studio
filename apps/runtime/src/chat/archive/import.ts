import { basename } from 'node:path'
import {
  ChatArchiveSchema,
  MAX_CHAT_ARCHIVE_BYTES,
  type ChatArchive,
  type FilePart,
  type ChatArchiveImportParams,
} from '@reflexion-os-studio/contracts'
import type { CommandContext } from '../../command-utils.js'
import { CommandError } from '../../agent/errors.js'
import { detectImageMime } from '../../assets/images/upload.js'
import { userContentParts } from '../../agent/context/image-parts.js'
import { readArchiveFile } from './files.js'
import { resolveImportTarget } from './target.js'

function parseArchive(content: string): ChatArchive {
  if (Buffer.byteLength(content, 'utf8') > MAX_CHAT_ARCHIVE_BYTES)
    throw new CommandError('invalid_request', '聊天备份超过 16MiB 上限')
  let archive: ChatArchive
  try {
    archive = ChatArchiveSchema.parse(
      JSON.parse(content.replace(/^\uFEFF/, '')),
    )
  } catch {
    throw new CommandError(
      'invalid_request',
      '聊天备份格式无效或版本不支持，尚未创建会话',
    )
  }
  const files = new Set(archive.files.map((file) => file.id))
  const usedFiles = new Set(
    archive.messages.flatMap((message) => message.files),
  )
  if (
    files.size !== archive.files.length ||
    archive.files.some((file) => !usedFiles.has(file.id))
  )
    throw new CommandError('invalid_request', '备份附件标识重复或没有消息引用')
  const images = new Set(archive.images.map((image) => image.id))
  if (images.size !== archive.images.length)
    throw new CommandError('invalid_request', '备份包含重复图片标识')
  const usedImages = new Set(
    archive.messages.flatMap((message) => message.images),
  )
  if (archive.images.some((image) => !usedImages.has(image.id)))
    throw new CommandError('invalid_request', '备份包含没有消息引用的图片')
  let previous = ''
  for (const message of archive.messages) {
    if (
      message.createdAt < previous ||
      message.files.some((id) => !files.has(id)) ||
      message.files.length + message.images.length > 4 ||
      new Set([...message.files, ...message.images]).size !==
        message.files.length + message.images.length ||
      (message.role !== 'user' && message.files.length > 0) ||
      (message.role !== 'assistant' && message.tools.length) ||
      message.images.some((id) => !images.has(id))
    )
      throw new CommandError(
        'invalid_request',
        '备份的消息顺序、工具归属或图片引用无效',
      )
    previous = message.createdAt
  }
  for (const image of archive.images) {
    const bytes = Buffer.from(image.base64, 'base64')
    if (
      bytes.toString('base64') !== image.base64 ||
      detectImageMime(bytes) !== image.mimeType
    )
      throw new CommandError('invalid_request', '备份图片编码或内容与格式不符')
  }
  return archive
}
export async function importChatArchive(
  ctx: Pick<CommandContext, 'store' | 'assets' | 'system'>,
  input: Omit<ChatArchiveImportParams, 'requestId'>,
) {
  const file = await readArchiveFile(ctx.system, input.path)
  const archive = parseArchive(file.content ?? '')
  const target = await resolveImportTarget(ctx, input)
  const folderPath = target.folderPath
  let projectId = target.projectId
  let createdProjectId: string | null = null
  const session = ctx.store.transaction(() => {
    if (folderPath) {
      const existing = ctx.store.projects.findByFolderPath(folderPath)
      if (existing) projectId = existing.id
      else {
        const project = ctx.store.projects.create({
          name: basename(folderPath) || folderPath,
          folderPath,
        })
        projectId = project.id
        createdProjectId = project.id
      }
    }
    return ctx.store.sessions.create(projectId, archive.title)
  })
  try {
    const images = new Map<string, string>()
    for (const image of archive.images) {
      const saved = await ctx.assets.uploadImage({
        sessionId: session.id,
        fileName: image.fileName,
        mimeType: image.mimeType,
        base64: image.base64,
      })
      images.set(image.id, saved.assetId)
    }
    const fileParts = new Map<string, FilePart>()
    for (const file of archive.files) {
      const asset = await ctx.assets.uploadDocument({
        sessionId: session.id,
        fileName: file.fileName,
        base64: file.base64,
      })
      const part = userContentParts(ctx.store, session.id, '', [
        asset.assetId,
      ])[0]
      if (part.type !== 'file')
        throw new CommandError('invalid_request', '附件类型无效')
      fileParts.set(file.id, part)
    }
    for (const message of archive.messages) {
      userContentParts(ctx.store, session.id, '', [
        ...message.images.map((id) => images.get(id)!),
        ...message.files.map((id) => fileParts.get(id)!.assetId),
      ])
    }
    ctx.store.transaction(() => {
      if (!ctx.store.sessions.get(session.id))
        throw new CommandError('not_found', '导入会话已被删除')
      ctx.store.chatArchives.restore(session.id, archive, images, fileParts)
    })
    return {
      session: ctx.store.sessions.get(session.id)!,
      messageCount: archive.messages.length,
    }
  } catch (error) {
    ctx.store.sessions.delete(session.id)
    await ctx.assets.deleteSessionDir(session.id).catch(() => {})
    if (createdProjectId && !ctx.store.sessions.list(createdProjectId).length)
      ctx.store.projects.delete(createdProjectId)
    throw error
  }
}
