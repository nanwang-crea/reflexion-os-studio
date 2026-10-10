import { z } from 'zod'
import { IsoDateTimeSchema } from '../shared.js'
import { ChangedFileSchema } from '../../tool-output.js'

// ---------------- Workspace Surface (Phase 1B) ----------------

/** 文件树条目（Rust file.list 透传）：路径为 workspace 相对形状。 */
export const WorkspaceEntrySchema = z.object({
  path: z.string().min(1),
  kind: z.enum(['file', 'dir']),
  sizeBytes: z.number().int().nonnegative(),
})
export type WorkspaceEntry = z.infer<typeof WorkspaceEntrySchema>

export const WorkspaceIndexStatusSchema = z.enum([
  'idle',
  'scanning',
  'completed',
  'stale',
  'failed',
])
export type WorkspaceIndexStatus = z.infer<typeof WorkspaceIndexStatusSchema>

/** 按扩展名统计：ext 带点（.ts），无扩展名归 .bin 无法区分时归 "（无）"。 */
export const WorkspaceExtStatsSchema = z.object({
  ext: z.string().min(1),
  files: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative(),
})
export type WorkspaceExtStats = z.infer<typeof WorkspaceExtStatsSchema>

/**
 * 每项目一份的索引快照：version 单调递增，staleAt 表示"与磁盘不再一致"的时间
 * （按工作区根目录 mtime 推断），仅查询时计算、不落盘。
 */
export const WorkspaceIndexSnapshotSchema = z.object({
  projectId: z.string().min(1),
  status: WorkspaceIndexStatusSchema,
  version: z.number().int().nonnegative(),
  startedAt: IsoDateTimeSchema.nullable(),
  completedAt: IsoDateTimeSchema.nullable(),
  staleAt: IsoDateTimeSchema.nullable(),
  fileCount: z.number().int().nonnegative(),
  dirCount: z.number().int().nonnegative(),
  totalBytes: z.number().int().nonnegative(),
  extStats: z.array(WorkspaceExtStatsSchema),
  truncated: z.boolean(),
  error: z.string().nullable(),
})
export type WorkspaceIndexSnapshot = z.infer<
  typeof WorkspaceIndexSnapshotSchema
>

/** 覆盖写凭据（Rust file.read 发放、file.write 校验）：防盲写/丢更新。 */
export const FileRevisionSchema = z.object({
  modifiedMs: z.number().int().nonnegative(),
  sizeBytes: z.number().int().nonnegative(),
  sha256: z.string().min(1),
})
export type FileRevision = z.infer<typeof FileRevisionSchema>

/** workspace.read_file 结果；默认 content 保留原文换行与末尾空行。 */
export const WorkspaceReadResultSchema = z.object({
  content: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  totalLines: z.number().int().nonnegative(),
  offset: z.number().int().nonnegative(),
  readComplete: z.boolean(),
  // 前端保存携带本次读取快照的 token，不使用其他读取请求的凭据。
  readToken: z.string().min(1).optional(),
  revision: FileRevisionSchema.optional(),
})
export type WorkspaceReadResult = z.infer<typeof WorkspaceReadResultSchema>

export const WorkspaceWriteResultSchema = z.object({
  writtenBytes: z.number().int().nonnegative(),
  readToken: z.string().min(1).optional(),
})
export type WorkspaceWriteResult = z.infer<typeof WorkspaceWriteResultSchema>

export const FileWriteResultSchema = z.object({
  writtenBytes: z.number().int().nonnegative(),
  changedFiles: z.array(ChangedFileSchema).optional(),
})
export type FileWriteResult = z.infer<typeof FileWriteResultSchema>

export const StructuredPatchChangeSchema = z.object({
  kind: z.enum(['replace', 'insert_before', 'insert_after', 'replace_range']),
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
  before: z.string(),
  after: z.string(),
})
export type StructuredPatchChange = z.infer<typeof StructuredPatchChangeSchema>

export const FileEditResultSchema = z.object({
  replacedCount: z.number().int().nonnegative(),
  sizeBytes: z.number().int().nonnegative(),
  changedFiles: z.array(ChangedFileSchema).optional(),
  structuredPatch: z.array(StructuredPatchChangeSchema),
})
export type FileEditResult = z.infer<typeof FileEditResultSchema>

export const FileDeleteResultSchema = z.object({
  kind: z.enum(['file', 'dir']),
  changedFiles: z.array(ChangedFileSchema).optional(),
})
export type FileDeleteResult = z.infer<typeof FileDeleteResultSchema>

export const FileMoveResultSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  changedFiles: z.array(ChangedFileSchema).optional(),
})
export type FileMoveResult = z.infer<typeof FileMoveResultSchema>

export const FileMkdirResultSchema = z.object({
  path: z.string().min(1),
  changedFiles: z.array(ChangedFileSchema).optional(),
})
export type FileMkdirResult = z.infer<typeof FileMkdirResultSchema>
