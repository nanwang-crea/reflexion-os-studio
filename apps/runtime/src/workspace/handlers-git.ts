/**
 * Workspace Git 域命令：状态/diff/分支/历史/远程列表只读查询与
 * stage/commit/fetch/push/pull/branch/remote_add/remote_remove 写操作。
 * 写命令经 withGitQueue 按 workspaceRoot
 * 串行（index.lock 互斥）；hash/路径在本层预校验后仍由 Rust 二次 enforce。
 */
import { CommandError } from '../agent/errors.js'
import { requireString, type CommandHandler } from '../command-utils.js'
import { withGitQueue } from './git-queue.js'
import {
  assertRelativePath,
  requestSystem,
  requireWorkspaceProject,
} from './shared.js'

/** 外层必须大于 Rust 内层超时，避免 Rust 仍在等待时 TS 先断：本地写 35s（Rust 30s）、网络 130s（Rust 120s）。 */
const GIT_LOCAL_WRITE_TIMEOUT_MS = 35_000
const GIT_NETWORK_TIMEOUT_MS = 130_000

export const workspaceGitCommandHandlers: Record<string, CommandHandler> = {
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
    })) as {
      repo: boolean
      current?: string | null
      branches?: string[]
      remoteBranches?: string[]
    }
    return {
      repo: result.repo,
      current: result.current ?? null,
      branches: result.branches ?? [],
      remoteBranches: result.remoteBranches ?? [],
    }
  },
  // ---------- Git 远程管理：列表只读；add/remove 走队列（本地 config 写，URL 合法性由 Rust enforce） ----------
  'workspace.git_remotes': async (p, { store, system }) => {
    const project = requireWorkspaceProject(
      store,
      requireString(p, 'projectId'),
    )
    const result = (await requestSystem(system, 'git.remotes', {
      workspaceRoot: project.folderPath,
    })) as {
      repo?: boolean
      remotes?: { name: string; url: string }[]
    }
    return {
      repo: result.repo ?? false,
      remotes: result.remotes ?? [],
    }
  },
  'workspace.git_remote_add': async (p, { store, system }) => {
    const project = requireWorkspaceProject(
      store,
      requireString(p, 'projectId'),
    )
    const name = requireString(p, 'name')
    const url = requireString(p, 'url')
    await withGitQueue(project.folderPath, () =>
      requestSystem(
        system,
        'git.remote_add',
        { workspaceRoot: project.folderPath, name, url },
        GIT_LOCAL_WRITE_TIMEOUT_MS,
      ),
    )
    return { ok: true as const }
  },
  'workspace.git_remote_remove': async (p, { store, system }) => {
    const project = requireWorkspaceProject(
      store,
      requireString(p, 'projectId'),
    )
    const name = requireString(p, 'name')
    await withGitQueue(project.folderPath, () =>
      requestSystem(
        system,
        'git.remote_remove',
        { workspaceRoot: project.folderPath, name },
        GIT_LOCAL_WRITE_TIMEOUT_MS,
      ),
    )
    return { ok: true as const }
  },
  // ---------- Git 提交历史（只读浏览；hash 走 requireHash，路径走 assertRelativePath） ----------
  'workspace.git_log': async (p, { store, system }) => {
    const project = requireWorkspaceProject(
      store,
      requireString(p, 'projectId'),
    )
    const params: Record<string, unknown> = {
      workspaceRoot: project.folderPath,
    }
    if (typeof p.skip === 'number')
      params.skip = Math.max(0, Math.trunc(p.skip))
    if (typeof p.limit === 'number')
      params.limit = Math.max(1, Math.trunc(p.limit))
    const result = (await requestSystem(system, 'git.log', params)) as {
      repo: boolean
      commits?: unknown[]
      hasMore?: boolean
    }
    return {
      repo: result.repo,
      commits: result.commits ?? [],
      hasMore: result.hasMore ?? false,
    }
  },
  'workspace.git_commit_files': async (p, { store, system }) => {
    const project = requireWorkspaceProject(
      store,
      requireString(p, 'projectId'),
    )
    const hash = requireHash(p)
    const result = (await requestSystem(system, 'git.commit_files', {
      workspaceRoot: project.folderPath,
      hash,
    })) as { files?: unknown[] }
    return { files: result.files ?? [] }
  },
  'workspace.git_commit_diff': async (p, { store, system }) => {
    const project = requireWorkspaceProject(
      store,
      requireString(p, 'projectId'),
    )
    const hash = requireHash(p)
    const path = assertRelativePath(requireString(p, 'path'))
    const result = (await requestSystem(system, 'git.commit_diff', {
      workspaceRoot: project.folderPath,
      hash,
      path,
    })) as {
      original?: string
      modified?: string
      binary?: boolean
      truncated?: boolean
    }
    return {
      original: result.original ?? '',
      modified: result.modified ?? '',
      binary: result.binary ?? false,
      truncated: result.truncated ?? false,
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
          ...(typeof p.startRef === 'string' && p.startRef !== ''
            ? { startRef: p.startRef }
            : {}),
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

/** 提交哈希：仅接受 4–64 位十六进制（短哈希或全哈希），其余一律拒绝在 Rust 之前。 */
function requireHash(params: Record<string, unknown>): string {
  const value = requireString(params, 'hash')
  if (!/^[0-9a-fA-F]{4,64}$/.test(value)) {
    throw new CommandError('invalid_request', 'hash 必须是 4-64 位十六进制')
  }
  return value
}
