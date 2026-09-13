import type {
  GitChangeEntry,
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

/** 本地 Git 分支列表；repo=false 表示不是 Git 仓库，current=null 为 HEAD detached。 */
export function gitBranches(
  projectId: string,
): Promise<{ repo: boolean; current: string | null; branches: string[] }> {
  return request<{ repo: boolean; current: string | null; branches: string[] }>(
    'workspace.git_branches',
    { projectId },
  )
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
/** 新建分支；checkout=true 时同时切换过去。 */
export const gitBranchCreate = (
  projectId: string,
  name: string,
  checkout: boolean,
) => gitWrite('workspace.git_branch_create', projectId, { name, checkout })
/** 切换到指定分支（会改变工作树，需先过缓冲守卫）。 */
export const gitBranchSwitch = (projectId: string, name: string) =>
  gitWrite('workspace.git_branch_switch', projectId, { name })

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
