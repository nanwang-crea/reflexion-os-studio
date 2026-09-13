/**
 * Workspace 域命令 handler 的共享前置校验与系统请求封装：
 * 文件/索引 handler（handlers.ts）与 Git handler（handlers-git.ts）共用，
 * 单一实现避免两处漂移。
 */
import { CommandError } from '../agent/errors.js'
import type { SystemRuntimeClient } from '../system.js'

export function requireWorkspaceProject(
  store: { projects: { get(id: string): { folderPath: string } | null } },
  projectId: string,
): { folderPath: string } {
  const project = store.projects.get(projectId)
  if (!project) {
    throw new CommandError('invalid_request', `project not found: ${projectId}`)
  }
  if (project.folderPath === '') {
    throw new CommandError('invalid_request', '项目未关联本地文件夹')
  }
  return project
}

/** 只允许相对路径；拒绝绝对路径与任何 `..`（Rust 侧还有第二道 enforce）。 */
export function assertRelativePath(path: string): string {
  if (path.trim() === '') {
    throw new CommandError('invalid_request', '路径不能为空')
  }
  if (path.includes('..')) {
    throw new CommandError('invalid_request', '路径不允许包含 ..')
  }
  if (/^[\\/]/.test(path)) {
    throw new CommandError('invalid_request', '路径必须是工作区相对路径')
  }
  return path.replace(/\\/g, '/')
}

export async function requestSystem(
  system: SystemRuntimeClient,
  method: string,
  params: Record<string, unknown>,
  timeoutMs = 30_000,
): Promise<unknown> {
  if (!system.available) {
    throw new CommandError(
      'system_unavailable',
      '系统工具 Runtime 不可用，文件树与查看器暂不可用',
    )
  }
  try {
    return await system.request(method, params, { timeoutMs })
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error
    throw new CommandError(
      'internal',
      error instanceof Error ? error.message : String(error),
    )
  }
}
