import type { FileRevision } from '@reflexion-os-studio/contracts'
import { CommandError } from '../agent/errors.js'
import { extractRevision } from '../agent/tools/read-state.js'
import { requireString, type CommandHandler } from '../command-utils.js'
import { workspaceFileState } from './file-state.js'
import { workspaceGitCommandHandlers } from './handlers-git.js'
import {
  assertRelativePath,
  requestSystem,
  requireWorkspaceProject,
} from './shared.js'

/**
 * Phase 1B Workspace 命令：索引生命周期 + 文件树/查看器 + 编辑器读写。
 * 文件访问全部透传 Rust System Runtime（workspace 边界与先读后写在 Rust 侧
 * 二次校验），Runtime 这里只做前置校验与凭据簿记：路径必须相对、命令目标
 * 必须是已关联文件夹的项目；read_file 登记 revision 凭据、write_file（UI
 * 保存）按登记注入并以 source:"ui" 声明免审批来源，前端不搬运凭据。
 * Git 域（状态/diff/历史/写操作）在 handlers-git.ts，按域合并进本表。
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
  // Git 域（只读查询 + 历史 + 写操作）在 handlers-git.ts，按域合并注册。
  ...workspaceGitCommandHandlers,
}

/** 文件名子串搜索的 glob 清洗：仅保留字母数字与 ._ -，收敛多点为单点。 */
function globSafe(value: string): string {
  return Array.from(value.trim())
    .filter((char) => /[\p{L}\p{N}._-]/u.test(char))
    .join('')
    .replace(/\.{2,}/g, '.')
}
