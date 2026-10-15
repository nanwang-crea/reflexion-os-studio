import type { ChatArchiveImportParams } from '@reflexion-os-studio/contracts'
import type { CommandContext } from '../../command-utils.js'
import { CommandError } from '../../agent/errors.js'
import { normalizeProjectFolderPath } from '../../store/chat/project-path.js'
import { archiveFile } from './files.js'

/** Resolve physical directory aliases before deciding whether to create a project. */
export async function resolveImportTarget(
  ctx: Pick<CommandContext, 'store' | 'system'>,
  input: Pick<ChatArchiveImportParams, 'projectId' | 'folderPath'>,
): Promise<{ projectId: string | null; folderPath?: string }> {
  if (input.projectId && input.folderPath)
    throw new CommandError('invalid_request', '请选择项目或目录，不能同时指定')
  if (!input.folderPath) {
    const projectId = input.projectId ?? null
    if (projectId && !ctx.store.projects.get(projectId))
      throw new CommandError('not_found', '目标项目不存在')
    return { projectId }
  }
  const folder = await archiveFile(ctx.system, {
    action: 'directory',
    workspaceRoot: input.folderPath,
  })
  const folderPath = normalizeProjectFolderPath(folder.path)
  const exact =
    ctx.store.projects.findByFolderPath(input.folderPath) ??
    ctx.store.projects.findByFolderPath(folderPath)
  if (exact) return { projectId: exact.id }
  const key = (path: string) =>
    process.platform === 'win32' ? path.toLowerCase() : path
  for (const project of ctx.store.projects.list()) {
    try {
      const candidate = await archiveFile(ctx.system, {
        action: 'directory',
        workspaceRoot: project.folderPath,
      })
      if (key(candidate.path) === key(folderPath))
        return { projectId: project.id }
    } catch {
      /* Missing or inaccessible unrelated projects do not prevent importing. */
    }
  }
  return { projectId: null, folderPath }
}
