import { randomUUID } from 'node:crypto'
import { CommandSchemaRegistry } from '@reflexion-os-studio/contracts'
import type { CommandHandler } from '../../command-utils.js'
import { createChatArchive } from './export.js'
import { importChatArchive } from './import.js'
import { archiveFile } from './files.js'

export const chatArchiveCommandHandlers: Record<string, CommandHandler> = {
  'session.archive.export': async (params, ctx) => {
    const input =
      CommandSchemaRegistry['session.archive.export'].params.parse(params)
    const archive = await createChatArchive(ctx, input.sessionId)
    const title = archive.title
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
      .slice(0, 48)
      .replace(/[. ]+$/, '')
    const file = await archiveFile(ctx.system, {
      action: 'write',
      workspaceRoot: input.directory,
      path: `chat-${title || 'history'}-${randomUUID()}.reflexion-chat.json`,
      content: JSON.stringify(archive, null, 2),
    })
    return { path: file.path, messageCount: archive.messages.length }
  },
  'session.archive.import': (params, ctx) =>
    importChatArchive(
      ctx,
      CommandSchemaRegistry['session.archive.import'].params.parse(params),
    ),
}
