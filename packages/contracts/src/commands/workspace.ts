import { z } from 'zod'
import {
  WorkspaceEntrySchema,
  WorkspaceIndexSnapshotSchema,
  WorkspaceReadResultSchema,
  GitChangeEntrySchema,
  GitChangeStatusSchema,
  ChangedFileSchema,
} from '../entities.js'
import { RequestIdSchema } from './params.js'

export const workspaceCommands = {
  'workspace.index.start': {
    params: z.object({
      requestId: RequestIdSchema,
      projectId: z.string().min(1),
    }),
    result: z.object({ accepted: z.boolean() }),
  },
  'workspace.index.cancel': {
    params: z.object({
      requestId: RequestIdSchema,
      projectId: z.string().min(1),
    }),
    result: z.object({ accepted: z.boolean() }),
  },
  'workspace.index.status': {
    params: z.object({
      requestId: RequestIdSchema,
      projectId: z.string().min(1),
    }),
    // 从未索引过返回 null；stale 状态由查询时按根目录 mtime 推导。
    result: z.object({ snapshot: WorkspaceIndexSnapshotSchema.nullable() }),
  },
  'workspace.list_dir': {
    params: z.object({
      requestId: RequestIdSchema,
      projectId: z.string().min(1),
      // 工作区相对目录；缺省 "."（根），只允许相对路径。
      path: z.string().optional(),
      // 分页续读：与 path 一起透传 file.list；缺省按服务端默认页大小返回。
      offset: z.number().int().nonnegative().optional(),
      limit: z.number().int().nonnegative().optional(),
    }),
    result: z.object({
      entries: z.array(WorkspaceEntrySchema),
      // 稳定排序后仍有后续页或触达遍历硬上限时为 true，用 nextOffset 续读。
      truncated: z.boolean(),
      returnedCount: z.number().int().nonnegative(),
      // 仍有后续内容时给出下一次请求的偏移量；无后续内容时省略。
      nextOffset: z.number().int().nonnegative().optional(),
    }),
  },
  'workspace.watch_dir': {
    params: z.object({
      requestId: RequestIdSchema,
      projectId: z.string().min(1),
      path: z.string().min(1),
    }),
    result: z.object({ watchId: z.string().min(1) }),
  },
  'workspace.unwatch_dir': {
    params: z.object({
      requestId: RequestIdSchema,
      watchId: z.string().min(1),
    }),
    result: z.object({ removed: z.boolean() }),
  },
  'workspace.search_files': {
    params: z.object({
      requestId: RequestIdSchema,
      projectId: z.string().min(1),
      query: z.string().min(1),
    }),
    result: z.object({
      entries: z.array(WorkspaceEntrySchema),
      truncated: z.boolean(),
      scanTruncated: z.boolean(),
      scannedFiles: z.number().int().nonnegative(),
      actualGlob: z.string(),
      ignoreCase: z.boolean(),
    }),
  },
  'workspace.read_file': {
    params: z.object({
      requestId: RequestIdSchema,
      projectId: z.string().min(1),
      path: z.string().min(1),
      offset: z.number().int().nonnegative().optional(),
      // 默认保留原始换行；false 仅用于兼容分行展示。
      preserveLineEndings: z.boolean().optional(),
      limit: z.number().int().nonnegative().optional(),
    }),
    result: WorkspaceReadResultSchema,
  },
  'workspace.read_binary': {
    params: z.object({
      requestId: RequestIdSchema,
      projectId: z.string().min(1),
      path: z.string().min(1),
    }),
    result: z.object({
      dataBase64: z.string(),
      sizeBytes: z.number().int().nonnegative(),
      mimeType: z.string().min(1),
    }),
  },
  'workspace.git_status': {
    params: z.object({
      requestId: RequestIdSchema,
      projectId: z.string().min(1),
    }),
    // repo=false 表示目录不是 Git 仓库（前端展示提示而非错误）。
    result: z.object({
      repo: z.boolean(),
      entries: z.array(GitChangeEntrySchema),
      truncated: z.boolean(),
      // 分支上下文（porcelain v2 --branch）；detached/无仓库时 null。
      branch: z.string().nullable(),
      upstream: z.string().nullable(),
      ahead: z.number().int().nonnegative().nullable(),
      behind: z.number().int().nonnegative().nullable(),
    }),
  },
  'workspace.agent_changes': {
    params: z.object({
      requestId: RequestIdSchema,
      projectId: z.string().min(1),
      sessionId: z.string().min(1),
    }),
    result: z.object({
      rootRunId: z.string().min(1).nullable(),
      changes: z.array(ChangedFileSchema),
    }),
  },
  'workspace.git_diff': {
    params: z.object({
      requestId: RequestIdSchema,
      projectId: z.string().min(1),
      path: z.string().min(1),
      // 缺省为工作树 diff；true 对比 HEAD 与索引（已暂存）。
      staged: z.boolean().optional(),
    }),
    // 两侧内容直接取自 git 对象/磁盘：工作树 diff 为 索引→工作树，
    // 已暂存为 HEAD→索引；新增侧为空串，删除侧为空串。
    result: z.object({
      repo: z.boolean(),
      original: z.string(),
      modified: z.string(),
      truncated: z.boolean(),
      binary: z.boolean(),
    }),
  },
  'workspace.git_branches': {
    params: z.object({
      requestId: RequestIdSchema,
      projectId: z.string().min(1),
    }),
    result: z.object({
      repo: z.boolean(),
      current: z.string().min(1).nullable(),
      branches: z.array(z.string().min(1)),
      // 远程跟踪分支（refs/remotes/*，剔除 */HEAD），`origin/main` 形态。
      remoteBranches: z.array(z.string().min(1)),
    }),
  },
  // ---------- Git 写操作（方案 A：UI 直接动作免审批凭据；Rust 枚举拼装 argv） ----------
  'workspace.git_stage': {
    params: z.object({
      requestId: RequestIdSchema,
      projectId: z.string().min(1),
      paths: z.array(z.string().min(1)).min(1),
    }),
    result: z.object({ ok: z.literal(true) }),
  },
  'workspace.git_unstage': {
    params: z.object({
      requestId: RequestIdSchema,
      projectId: z.string().min(1),
      paths: z.array(z.string().min(1)).min(1),
    }),
    result: z.object({ ok: z.literal(true) }),
  },
  'workspace.git_commit': {
    params: z.object({
      requestId: RequestIdSchema,
      projectId: z.string().min(1),
      message: z.string().min(1),
    }),
    result: z.object({ ok: z.literal(true) }),
  },
  'workspace.git_fetch': {
    params: z.object({
      requestId: RequestIdSchema,
      projectId: z.string().min(1),
    }),
    result: z.object({ ok: z.literal(true) }),
  },
  'workspace.git_push': {
    params: z.object({
      requestId: RequestIdSchema,
      projectId: z.string().min(1),
    }),
    result: z.object({ ok: z.literal(true) }),
  },
  'workspace.git_pull': {
    params: z.object({
      requestId: RequestIdSchema,
      projectId: z.string().min(1),
    }),
    result: z.object({ ok: z.literal(true) }),
  },
  'workspace.git_branch_create': {
    params: z.object({
      requestId: RequestIdSchema,
      projectId: z.string().min(1),
      name: z.string().min(1),
      // true 时创建并切换（switch -c）；缺省仅创建。
      checkout: z.boolean().optional(),
      // 可选起点：commit 哈希（历史「基于此建分支」）或 `remote/branch`
      // （远程分支检出为本地跟踪分支）。形态安全校验在 Rust。
      startRef: z.string().min(1).optional(),
    }),
    result: z.object({ ok: z.literal(true) }),
  },
  'workspace.git_branch_switch': {
    params: z.object({
      requestId: RequestIdSchema,
      projectId: z.string().min(1),
      name: z.string().min(1),
    }),
    result: z.object({ ok: z.literal(true) }),
  },
  // ---------- Git 提交历史（只读浏览 + 导航；hash 一律十六进制校验） ----------
  'workspace.git_log': {
    params: z.object({
      requestId: RequestIdSchema,
      projectId: z.string().min(1),
      skip: z.number().int().nonnegative().optional(),
      limit: z.number().int().positive().optional(),
    }),
    result: z.object({
      repo: z.boolean(),
      commits: z.array(
        z.object({
          hash: z.string(),
          shortHash: z.string(),
          timestampMs: z.number().int().nonnegative(),
          authorName: z.string(),
          isMerge: z.boolean(),
          subject: z.string(),
        }),
      ),
      hasMore: z.boolean(),
    }),
  },
  'workspace.git_commit_files': {
    params: z.object({
      requestId: RequestIdSchema,
      projectId: z.string().min(1),
      hash: z.string().regex(/^[0-9a-fA-F]{4,64}$/),
    }),
    result: z.object({
      files: z.array(
        z.object({
          path: z.string(),
          oldPath: z.string().optional(),
          status: GitChangeStatusSchema,
        }),
      ),
    }),
  },
  'workspace.git_commit_diff': {
    params: z.object({
      requestId: RequestIdSchema,
      projectId: z.string().min(1),
      hash: z.string().regex(/^[0-9a-fA-F]{4,64}$/),
      path: z.string().min(1),
    }),
    // original = 该文件在 <hash>^ 的内容（root/新增→空），modified = <hash>。
    result: z.object({
      original: z.string(),
      modified: z.string(),
      binary: z.boolean(),
      truncated: z.boolean(),
    }),
  },
  // ---------- Git 远程管理（列出/添加/移除 remote；远程分支检出复用 branch API） ----------
  'workspace.git_remotes': {
    params: z.object({
      requestId: RequestIdSchema,
      projectId: z.string().min(1),
    }),
    result: z.object({
      repo: z.boolean(),
      // url 回显已剥内嵌凭据（scheme://***@host）。
      remotes: z.array(z.object({ name: z.string(), url: z.string() })),
    }),
  },
  'workspace.git_remote_add': {
    params: z.object({
      requestId: RequestIdSchema,
      projectId: z.string().min(1),
      name: z.string().min(1),
      url: z.string().min(1),
    }),
    result: z.object({ ok: z.literal(true) }),
  },
  'workspace.git_remote_remove': {
    params: z.object({
      requestId: RequestIdSchema,
      projectId: z.string().min(1),
      name: z.string().min(1),
    }),
    result: z.object({ ok: z.literal(true) }),
  },
  'workspace.write_file': {
    params: z.object({
      requestId: RequestIdSchema,
      projectId: z.string().min(1),
      path: z.string().min(1),
      content: z.string(),
    }),
    result: z.object({
      writtenBytes: z.number().int().nonnegative(),
    }),
  },
  // ---------- Asset（Phase 1B 第二阶段）：内容入 Store，引用与元数据落库 ----------
}
