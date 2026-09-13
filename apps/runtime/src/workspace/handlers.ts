import type { FileRevision } from '@reflexion-os-studio/contracts'
import { CommandError } from '../agent/errors.js'
import { extractRevision } from '../agent/tools/read-state.js'
import { requireString, type CommandHandler } from '../command-utils.js'
import type { SystemRuntimeClient } from '../system.js'
import { workspaceFileState } from './file-state.js'
import { withGitQueue } from './git-queue.js'

/** 外层必须大于 Rust 内层超时，避免 Rust 仍在等待时 TS 先断：本地写 35s（Rust 30s）、网络 130s（Rust 120s）。 */
const GIT_LOCAL_WRITE_TIMEOUT_MS = 35_000
const GIT_NETWORK_TIMEOUT_MS = 130_000

/**
 * Phase 1B Workspace 命令：索引生命周期 + 文件树/查看器 + 编辑器读写。
 * 文件访问全部透传 Rust System Runtime（workspace 边界与先读后写在 Rust 侧
 * 二次校验），Runtime 这里只做前置校验与凭据簿记：路径必须相对、命令目标
 * 必须是已关联文件夹的项目；read_file 登记 revision 凭据、write_file（UI
 * 保存）按登记注入并以 source:"ui" 声明免审批来源，前端不搬运凭据。
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
    const params: Record<string, unknown> = {
      workspaceRoot: project.folderPath,
      path,
    }
    if (typeof p.offset === 'number') {
      params.offset = Math.max(0, Math.trunc(p.offset))
    }
    if (typeof p.limit === 'number') {
      params.limit = Math.max(1, Math.trunc(p.limit))
    }
    const result = (await requestSystem(system, 'file.list', params)) as {
      entries?: unknown[]
      truncated?: boolean
      returnedCount?: number
      nextOffset?: number
    }
    return {
      entries: result.entries ?? [],
      truncated: result.truncated ?? false,
      returnedCount: result.returnedCount ?? 0,
      ...(result.nextOffset !== undefined
        ? { nextOffset: result.nextOffset }
        : {}),
    }
  },
  'workspace.search_files': async (p, { store, system }) => {
    const project = requireWorkspaceProject(
      store,
      requireString(p, 'projectId'),
    )
    const query = globSafe(requireString(p, 'query'))
    // 文件名子串搜索用 glob 全量递归：`**` 跨所有目录段，`*query*` 命中末段文件名。
    // query 已做白名单清洗（去掉 `/`、`..`、通配符等），避免影响分段与匹配语义。
    if (query === '') return { entries: [], truncated: false }
    const pattern = `**/*${query}*`
    const result = (await requestSystem(system, 'file.glob', {
      workspaceRoot: project.folderPath,
      pattern,
    })) as { matches?: unknown[]; truncated?: boolean }
    return {
      entries: result.matches ?? [],
      truncated: result.truncated ?? false,
    }
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
    const result = (await requestSystem(system, 'file.read', params)) as Record<
      string,
      unknown
    >
    // 登记覆盖写凭据：编辑器/预览据 readComplete 判定能否整文件保存。
    const revision = extractRevision(result)
    if (revision !== undefined) {
      workspaceFileState.record(project.folderPath, path, {
        revision,
        complete: result.readComplete === true,
      })
    }
    return result
  },
  'workspace.git_status': async (p, { store, system }) => {
    const project = requireWorkspaceProject(
      store,
      requireString(p, 'projectId'),
    )
    const result = (await requestSystem(system, 'git.status', {
      workspaceRoot: project.folderPath,
    })) as {
      repo: boolean
      entries?: unknown[]
      truncated?: boolean
      branch?: string | null
      upstream?: string | null
      ahead?: number | null
      behind?: number | null
    }
    return {
      repo: result.repo,
      entries: result.entries ?? [],
      truncated: result.truncated ?? false,
      branch: result.branch ?? null,
      upstream: result.upstream ?? null,
      ahead: result.ahead ?? null,
      behind: result.behind ?? null,
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
      original?: string
      modified?: string
      truncated?: boolean
      binary?: boolean
    }
    return {
      repo: result.repo,
      original: result.original ?? '',
      modified: result.modified ?? '',
      truncated: result.truncated ?? false,
      binary: result.binary ?? false,
    }
  },
  'workspace.git_branches': async (p, { store, system }) => {
    const project = requireWorkspaceProject(
      store,
      requireString(p, 'projectId'),
    )
    const result = (await requestSystem(system, 'git.branches', {
      workspaceRoot: project.folderPath,
    })) as { repo: boolean; current?: string | null; branches?: string[] }
    return {
      repo: result.repo,
      current: result.current ?? null,
      branches: result.branches ?? [],
    }
  },
  // ---------- Git 写操作：同一 workspaceRoot 串行（index.lock），Rust 免审批枚举 ----------
  'workspace.git_stage': async (p, { store, system }) => {
    const project = requireWorkspaceProject(
      store,
      requireString(p, 'projectId'),
    )
    const paths = requireStringArray(p, 'paths')
    await withGitQueue(project.folderPath, () =>
      requestSystem(
        system,
        'git.stage',
        {
          workspaceRoot: project.folderPath,
          paths: paths.map(assertRelativePath),
        },
        GIT_LOCAL_WRITE_TIMEOUT_MS,
      ),
    )
    return { ok: true as const }
  },
  'workspace.git_unstage': async (p, { store, system }) => {
    const project = requireWorkspaceProject(
      store,
      requireString(p, 'projectId'),
    )
    const paths = requireStringArray(p, 'paths')
    await withGitQueue(project.folderPath, () =>
      requestSystem(
        system,
        'git.unstage',
        {
          workspaceRoot: project.folderPath,
          paths: paths.map(assertRelativePath),
        },
        GIT_LOCAL_WRITE_TIMEOUT_MS,
      ),
    )
    return { ok: true as const }
  },
  'workspace.git_commit': async (p, { store, system }) => {
    const project = requireWorkspaceProject(
      store,
      requireString(p, 'projectId'),
    )
    const message = requireString(p, 'message')
    await withGitQueue(project.folderPath, () =>
      requestSystem(
        system,
        'git.commit',
        {
          workspaceRoot: project.folderPath,
          message,
        },
        GIT_LOCAL_WRITE_TIMEOUT_MS,
      ),
    )
    return { ok: true as const }
  },
  'workspace.git_fetch': async (p, { store, system }) => {
    const project = requireWorkspaceProject(
      store,
      requireString(p, 'projectId'),
    )
    await withGitQueue(project.folderPath, () =>
      requestSystem(
        system,
        'git.fetch',
        { workspaceRoot: project.folderPath },
        GIT_NETWORK_TIMEOUT_MS,
      ),
    )
    return { ok: true as const }
  },
  'workspace.git_push': async (p, { store, system }) => {
    const project = requireWorkspaceProject(
      store,
      requireString(p, 'projectId'),
    )
    await withGitQueue(project.folderPath, () =>
      requestSystem(
        system,
        'git.push',
        { workspaceRoot: project.folderPath },
        GIT_NETWORK_TIMEOUT_MS,
      ),
    )
    return { ok: true as const }
  },
  'workspace.git_pull': async (p, { store, system }) => {
    const project = requireWorkspaceProject(
      store,
      requireString(p, 'projectId'),
    )
    await withGitQueue(project.folderPath, () =>
      requestSystem(
        system,
        'git.pull',
        { workspaceRoot: project.folderPath },
        GIT_NETWORK_TIMEOUT_MS,
      ),
    )
    return { ok: true as const }
  },
  'workspace.git_branch_create': async (p, { store, system }) => {
    const project = requireWorkspaceProject(
      store,
      requireString(p, 'projectId'),
    )
    const name = requireString(p, 'name')
    await withGitQueue(project.folderPath, () =>
      requestSystem(
        system,
        'git.branch_create',
        {
          workspaceRoot: project.folderPath,
          name,
          ...(typeof p.checkout === 'boolean' ? { checkout: p.checkout } : {}),
        },
        GIT_LOCAL_WRITE_TIMEOUT_MS,
      ),
    )
    return { ok: true as const }
  },
  'workspace.git_branch_switch': async (p, { store, system }) => {
    const project = requireWorkspaceProject(
      store,
      requireString(p, 'projectId'),
    )
    const name = requireString(p, 'name')
    await withGitQueue(project.folderPath, () =>
      requestSystem(
        system,
        'git.branch_switch',
        {
          workspaceRoot: project.folderPath,
          name,
        },
        GIT_LOCAL_WRITE_TIMEOUT_MS,
      ),
    )
    return { ok: true as const }
  },
  'workspace.write_file': async (p, { store, system }) => {
    const project = requireWorkspaceProject(
      store,
      requireString(p, 'projectId'),
    )
    const path = assertRelativePath(requireString(p, 'path'))
    const content = typeof p.content === 'string' ? p.content : ''
    const root = project.folderPath
    const record = workspaceFileState.entry(root, path)
    if (record !== undefined && !record.complete) {
      throw new CommandError(
        'invalid_request',
        `${path} 的读取凭据来自分页窗口，不足以覆盖整文件：请完整读取后再保存。`,
      )
    }
    const result = (await requestSystem(system, 'file.write', {
      workspaceRoot: root,
      path,
      content,
      ...(record ? { revision: record.revision } : {}),
      // 用户直接动作：向 Rust 声明免审批来源（agent 路径才要求 grant）。
      source: 'ui',
    })) as { writtenBytes?: number; revision?: FileRevision }
    // 回写新凭据：编辑器连续保存以最新 revision 通过陈旧校验。
    if (result.revision !== undefined) {
      workspaceFileState.record(root, path, {
        revision: result.revision,
        complete: true,
      })
    }
    return { writtenBytes: result.writtenBytes ?? 0 }
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
function globSafe(value: string): string {
  return Array.from(value.trim())
    .filter((char) => /[\p{L}\p{N}._-]/u.test(char))
    .join('')
    .replace(/\.{2,}/g, '.')
}

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

/** 校验非空字符串数组（paths 之类）；空数组或含非字符串项都视为非法请求。 */
function requireStringArray(
  params: Record<string, unknown>,
  key: string,
): string[] {
  const value = params[key]
  if (!Array.isArray(value) || value.length === 0) {
    throw new CommandError('invalid_request', `missing param: ${key}`)
  }
  if (!value.every((item) => typeof item === 'string' && item !== '')) {
    throw new CommandError('invalid_request', `invalid param: ${key}`)
  }
  return value as string[]
}
