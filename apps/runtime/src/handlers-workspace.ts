import { CommandError } from './agent/errors.js'
import { requireString, type CommandHandler } from './command-utils.js'
import type { SystemRuntimeClient } from './system.js'

/**
 * Phase 1B Workspace 命令：索引生命周期 + 文件树/查看器（只读）。
 * 文件访问全部透传 Rust System Runtime（workspace 边界在 Rust 侧强制），
 * Runtime 这里只做前置校验：路径必须相对、命令目标必须是已关联文件夹的项目。
 */
export const workspaceCommandHandlers: Record<string, CommandHandler> = {
  'workspace.index.start': (p, { store, workspace }) => {
    const projectId = requireString(p, 'projectId')
    const project = store.projects.get(projectId)
    if (!project) {
      throw new CommandError(
        'invalid_request',
        `project not found: ${projectId}`,
      )
    }
    if (project.folderPath === '') {
      throw new CommandError(
        'invalid_request',
        '项目未关联本地文件夹，无法索引',
      )
    }
    // start 内部自吞扫描异常；命令只确认"已接受"。
    void workspace.start(projectId, project.folderPath)
    return { accepted: true }
  },
  'workspace.index.cancel': (p, { workspace }) => ({
    accepted: workspace.cancel(requireString(p, 'projectId')),
  }),
  'workspace.index.status': async (p, { workspace }) => ({
    snapshot: await workspace.snapshotFor(requireString(p, 'projectId')),
  }),
  'workspace.list_dir': async (p, { store, system }) => {
    const project = requireWorkspaceProject(
      store,
      requireString(p, 'projectId'),
    )
    const path = assertRelativePath(
      typeof p.path === 'string' && p.path.trim() !== '' ? p.path.trim() : '.',
    )
    const result = (await requestSystem(system, 'file.list', {
      workspaceRoot: project.folderPath,
      path,
    })) as { entries?: unknown[] }
    return { entries: result.entries ?? [] }
  },
  'workspace.read_file': async (p, { store, system }) => {
    const project = requireWorkspaceProject(
      store,
      requireString(p, 'projectId'),
    )
    const path = assertRelativePath(requireString(p, 'path'))
    const params: Record<string, unknown> = {
      workspaceRoot: project.folderPath,
      path,
    }
    if (typeof p.offset === 'number')
      params.offset = Math.max(0, Math.trunc(p.offset))
    if (typeof p.limit === 'number')
      params.limit = Math.max(1, Math.trunc(p.limit))
    return (await requestSystem(system, 'file.read', params)) as Record<
      string,
      unknown
    >
  },
  'workspace.git_status': async (p, { store, system }) => {
    const project = requireWorkspaceProject(
      store,
      requireString(p, 'projectId'),
    )
    const result = (await requestSystem(system, 'git.status', {
      workspaceRoot: project.folderPath,
    })) as { repo: boolean; entries?: unknown[]; truncated?: boolean }
    return {
      repo: result.repo,
      entries: result.entries ?? [],
      truncated: result.truncated ?? false,
    }
  },
  'workspace.git_diff': async (p, { store, system }) => {
    const project = requireWorkspaceProject(
      store,
      requireString(p, 'projectId'),
    )
    const path = assertRelativePath(requireString(p, 'path'))
    const params: Record<string, unknown> = {
      workspaceRoot: project.folderPath,
      path,
    }
    if (typeof p.staged === 'boolean') params.staged = p.staged
    const result = (await requestSystem(system, 'git.diff', params)) as {
      repo: boolean
      diff?: string
      truncated?: boolean
    }
    return {
      repo: result.repo,
      diff: result.diff ?? '',
      truncated: result.truncated ?? false,
    }
  },
}

function requireWorkspaceProject(
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
function assertRelativePath(path: string): string {
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

async function requestSystem(
  system: SystemRuntimeClient,
  method: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  if (!system.available) {
    throw new CommandError(
      'system_unavailable',
      '系统工具 Runtime 不可用，文件树与查看器暂不可用',
    )
  }
  try {
    return await system.request(method, params, { timeoutMs: 30_000 })
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error
    throw new CommandError(
      'internal',
      error instanceof Error ? error.message : String(error),
    )
  }
}
