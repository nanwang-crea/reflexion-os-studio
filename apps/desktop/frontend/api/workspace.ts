import type {
  GitChangeEntry,
  RuntimeEvent,
  WorkspaceEntry,
  WorkspaceIndexSnapshot,
  WorkspaceReadResult,
} from '@reflexion-os-studio/runtime-client'
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
): Promise<{ entries: WorkspaceEntry[] }> {
  return request<{ entries: WorkspaceEntry[] }>('workspace.list_dir', {
    projectId,
    path,
  })
}

/** 分段读取文本文件；大文件用 offset（行号）+ limit 翻页。 */
export function readFile(
  projectId: string,
  path: string,
  offset?: number,
  limit?: number,
): Promise<WorkspaceReadResult> {
  return request<WorkspaceReadResult>('workspace.read_file', {
    projectId,
    path,
    ...(offset !== undefined ? { offset } : {}),
    ...(limit !== undefined ? { limit } : {}),
  })
}

/** Git 变更列表（porcelain 状态聚合）；repo=false 表示不是 Git 仓库。 */
export function gitStatus(
  projectId: string,
): Promise<{ repo: boolean; entries: GitChangeEntry[]; truncated: boolean }> {
  return request<{
    repo: boolean
    entries: GitChangeEntry[]
    truncated: boolean
  }>('workspace.git_status', { projectId })
}

/** 单文件 diff；staged=true 取索引（已暂存）版本，缺省工作树。 */
export function gitDiff(
  projectId: string,
  path: string,
  staged = false,
): Promise<{ repo: boolean; diff: string; truncated: boolean }> {
  return request<{ repo: boolean; diff: string; truncated: boolean }>(
    'workspace.git_diff',
    { projectId, path, staged },
  )
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
