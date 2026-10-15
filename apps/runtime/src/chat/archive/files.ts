import { basename, dirname, isAbsolute } from 'node:path'
import {
  ChatArchiveFileRequestSchema,
  ChatArchiveFileResultSchema,
} from '@reflexion-os-studio/contracts'
import type { ChatArchiveFileRequest } from '@reflexion-os-studio/contracts'
import type { SystemRuntimeClient } from '../../system.js'
import { CommandError } from '../../agent/errors.js'
import { touchesSensitive } from '../../agent/permissions/escalation.js'
import { requestSystem } from '../../workspace/shared.js'

export async function archiveFile(
  system: SystemRuntimeClient,
  params: ChatArchiveFileRequest,
) {
  const request = ChatArchiveFileRequestSchema.parse(params)
  if (
    !isAbsolute(request.workspaceRoot) ||
    touchesSensitive(request.workspaceRoot)
  )
    throw new CommandError(
      'invalid_request',
      '请选择普通目录，不能使用凭据目录或系统目录',
    )
  return ChatArchiveFileResultSchema.parse(
    await requestSystem(system, 'chat.archive', request),
  )
}
export async function readArchiveFile(
  system: SystemRuntimeClient,
  path: string,
) {
  if (
    !isAbsolute(path) ||
    touchesSensitive(path) ||
    !path.endsWith('.reflexion-chat.json')
  )
    throw new CommandError(
      'invalid_request',
      '请选择 .reflexion-chat.json 聊天备份文件',
    )
  return archiveFile(system, {
    action: 'read',
    workspaceRoot: dirname(path),
    path: basename(path),
  })
}
