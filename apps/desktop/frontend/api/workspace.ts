import type {
  GitChangeEntry,
  GitChangeStatus,
  RuntimeEvent,
  WorkspaceEntry,
  WorkspaceIndexSnapshot,
  WorkspaceReadResult,
  FileWriteResult,
} from '@reflexion-os-studio/runtime-client'

export interface WorkspaceListResult {
  entries: WorkspaceEntry[]
  truncated: boolean
  returnedCount: number
  nextOffset?: number
}
import { request } from './client'
import { transport } from '../lib/transport'

/** 启动/重启一次按需索引；大工作区异步运行，进度/结果走事件。 */
export function startIndex(projectId: string): Promise<{ accepted: boolean }> {
  return request<{ accepted: boolean }>('workspace.index.start', { projectId })
}

export function cancelIndex(projectId: string): Promise<{ accepted: boolean }> {
  return request<{ accepted: boolean }>('workspace.index.cancel', { projectId })
}

/** 索引快照查询；从未索引过为 null，stale 状态由 Runtime 按根目录 mtime 推导。 */
export function getIndexStatus(
  projectId: string,
): Promise<{ snapshot: WorkspaceIndexSnapshot | null }> {
  return request<{ snapshot: WorkspaceIndexSnapshot | null }>(
    'workspace.index.status',
    { projectId },
  )
}

/** 树节点按需加载：单层条目（非递归），目录条目另行展开时再取。 */
export function listDir(
  projectId: string,
  path = '.',
  offset?: number,
  limit?: number,
): Promise<WorkspaceListResult> {
  return request<WorkspaceListResult>('workspace.list_dir', {
    projectId,
    path,
    ...(offset !== undefined ? { offset } : {}),
    ...(limit !== undefined ? { limit } : {}),
  })
}

/** 分段读取文本文件；大文件用 offset（行号）+ limit 翻页。 */
export function readFile(
  projectId: string,
  path: string,
  options?: { offset?: number; limit?: number },
): Promise<WorkspaceReadResult> {
  return request<WorkspaceReadResult>('workspace.read_file', {
    projectId,
    path,
    ...(options?.offset !== undefined ? { offset: options.offset } : {}),
    ...(options?.limit !== undefined ? { limit: options.limit } : {}),
  })
}

/** 写入文本文件到工作区；覆盖保护（先读后写凭据）由 Runtime/ Rust 两层承担。 */
export function writeFile(
  projectId: string,
  path: string,
  content: string,
): Promise<FileWriteResult> {
  return request<FileWriteResult>('workspace.write_file', {
    projectId,
    path,
    content,
  })
}

/** 文件名子串搜索（glob 全量递归，复用 WorkspaceEntry 外形）；只读。 */
export function searchFiles(
  projectId: string,
  query: string,
): Promise<{ entries: WorkspaceEntry[]; truncated: boolean }> {
  return request<{ entries: WorkspaceEntry[]; truncated: boolean }>(
    'workspace.search_files',
    { projectId, query },
  )
}

/** Git 变更列表（porcelain 状态聚合）；repo=false 表示不是 Git 仓库。 */
export function gitStatus(projectId: string): Promise<{
  repo: boolean
  entries: GitChangeEntry[]
  truncated: boolean
  branch: string | null
  upstream: string | null
  ahead: number | null
  behind: number | null
}> {
  return request<{
    repo: boolean
    entries: GitChangeEntry[]
    truncated: boolean
    branch: string | null
    upstream: string | null
    ahead: number | null
    behind: number | null
  }>('workspace.git_status', { projectId })
}

/**
 * 单文件 diff 两侧内容；工作树 diff 为 索引→工作树，staged 为 HEAD→索引。
 * 新增/删除一侧为空串；binary=true 时内容不应按文本渲染。
 */
export function gitDiff(
  projectId: string,
  path: string,
  staged = false,
): Promise<{
  repo: boolean
  original: string
  modified: string
  truncated: boolean
  binary: boolean
}> {
  return request<{
    repo: boolean
    original: string
    modified: string
    truncated: boolean
    binary: boolean
  }>('workspace.git_diff', { projectId, path, staged })
}

/** 远端条目；URL 已在 Rust 侧剥离凭据（user:token@ → ***@）。 */
export interface GitRemote {
  name: string
  url: string
}

/** Git 分支列表（本地 + 远程）；repo=false 表示不是 Git 仓库，current=null 为 HEAD detached。 */
export function gitBranches(projectId: string): Promise<{
  repo: boolean
  current: string | null
  branches: string[]
  remoteBranches: string[]
}> {
  return request<{
    repo: boolean
    current: string | null
    branches: string[]
    remoteBranches: string[]
  }>('workspace.git_branches', { projectId })
}

/** 远端（remote）列表；repo=false 表示不是 Git 仓库。 */
export function gitRemotes(
  projectId: string,
): Promise<{ repo: boolean; remotes: GitRemote[] }> {
  return request<{ repo: boolean; remotes: GitRemote[] }>(
    'workspace.git_remotes',
    { projectId },
  )
}

/** 历史面板一行：commit 元信息（合并提交按第一父对比语义展示）。 */
export interface GitLogEntry {
  hash: string
  shortHash: string
  timestampMs: number
  authorName: string
  isMerge: boolean
  subject: string
}

/** 单 commit 改动文件；rename 携带 oldPath，status 复用工作树变更枚举。 */
export interface GitCommitFile {
  path: string
  oldPath?: string
  status: GitChangeStatus
}

/** 提交历史分页读取（HEAD 反向时间序）；repo=false 表示不是 Git 仓库。 */
export function gitLog(
  projectId: string,
  options: { skip?: number; limit?: number } = {},
): Promise<{ repo: boolean; commits: GitLogEntry[]; hasMore: boolean }> {
  return request<{ repo: boolean; commits: GitLogEntry[]; hasMore: boolean }>(
    'workspace.git_log',
    {
      projectId,
      ...(options.skip !== undefined ? { skip: options.skip } : {}),
      ...(options.limit !== undefined ? { limit: options.limit } : {}),
    },
  )
}

/** 单 commit 的改动文件列表（合并提交=对第一父）。 */
export function gitCommitFiles(
  projectId: string,
  hash: string,
): Promise<{ files: GitCommitFile[] }> {
  return request<{ files: GitCommitFile[] }>('workspace.git_commit_files', {
    projectId,
    hash,
  })
}

/**
 * 单 commit 内某文件 diff 两侧内容：original=<hash>^（root/新增→空），
 * modified=<hash>（删除→空）。rename 时新路径在父树不存在，Rust 侧经
 * commit_files 回查旧路径取改名前内容作 original；binary/truncated
 * 随结果返回（历史点开 diff 透传给渲染层）。
 */
export function gitCommitDiff(
  projectId: string,
  hash: string,
  path: string,
): Promise<{
  original: string
  modified: string
  binary: boolean
  truncated: boolean
}> {
  return request<{
    original: string
    modified: string
    binary: boolean
    truncated: boolean
  }>('workspace.git_commit_diff', { projectId, hash, path })
}

type GitOk = { ok: true }

function gitWrite(
  method: string,
  projectId: string,
  extra: Record<string, unknown> = {},
): Promise<GitOk> {
  return request<GitOk>(method, { projectId, ...extra })
}

/** 暂存指定路径到索引区。 */
export const gitStage = (projectId: string, paths: string[]) =>
  gitWrite('workspace.git_stage', projectId, { paths })
/** 取消暂存指定路径（索引区→工作树）。 */
export const gitUnstage = (projectId: string, paths: string[]) =>
  gitWrite('workspace.git_unstage', projectId, { paths })
/** 以给定提交信息提交已暂存变更。 */
export const gitCommit = (projectId: string, message: string) =>
  gitWrite('workspace.git_commit', projectId, { message })
/** 拉取远端更新（不合并）。 */
export const gitFetch = (projectId: string) =>
  gitWrite('workspace.git_fetch', projectId)
/** 推送本地已提交到远端。 */
export const gitPush = (projectId: string) =>
  gitWrite('workspace.git_push', projectId)
/** 拉取并合并远端更新（会改变工作树，需先过缓冲守卫）。 */
export const gitPull = (projectId: string) =>
  gitWrite('workspace.git_pull', projectId)
/** 新建分支；checkout=true 时同时切换过去；startRef=commit 哈希或 remote/branch。 */
export const gitBranchCreate = (
  projectId: string,
  name: string,
  checkout: boolean,
  startRef?: string,
) =>
  gitWrite('workspace.git_branch_create', projectId, {
    name,
    checkout,
    ...(startRef !== undefined ? { startRef } : {}),
  })
/** 切换到指定分支（会改变工作树，需先过缓冲守卫）。 */
export const gitBranchSwitch = (projectId: string, name: string) =>
  gitWrite('workspace.git_branch_switch', projectId, { name })
/** 添加远端（仅写本地 config；URL 合法性由 Rust enforce）。 */
export const gitRemoteAdd = (projectId: string, name: string, url: string) =>
  gitWrite('workspace.git_remote_add', projectId, { name, url })
/** 移除远端（连同其 refs/remotes 引用；不删任何本地提交）。 */
export const gitRemoteRemove = (projectId: string, name: string) =>
  gitWrite('workspace.git_remote_remove', projectId, { name })

export type WorkspaceIndexEvent = Extract<
  RuntimeEvent,
  { type: `workspace.index.${string}` }
>

/** 订阅 Workspace 索引事件（进度/完成/失败）；返回取消订阅函数。 */
export function onWorkspaceIndexEvent(
  handler: (event: WorkspaceIndexEvent) => void,
): () => void {
  return transport.onEvent((event) => {
    if (event.type.startsWith('workspace.index.')) {
      handler(event as WorkspaceIndexEvent)
    }
  })
}
