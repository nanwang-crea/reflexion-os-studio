import { z } from 'zod'
import { IsoDateTimeSchema } from '../shared.js'
import { ResourceLinkSchema } from '../../resource-links.js'

// ---------------- Asset / Artifact / ResourceLink（Phase 1B 第二阶段） ----------------

/** Asset 内容类别；mime 未知时归 file。 */
export const AssetKindSchema = z.enum([
  'image',
  'text',
  'audio',
  'video',
  'file',
])
export type AssetKind = z.infer<typeof AssetKindSchema>

/**
 * Asset 引用与元数据：内容存受控 Asset Store（数据目录 assets/<projectId>/，
 * 按项目隔离），库与事件只保存引用与元数据；大文件不进协议。
 */
export const AssetRefSchema = z.object({
  assetId: z.string().min(1),
  projectId: z.string().min(1).nullable(),
  sessionId: z.string().min(1).nullable().optional(),
  uri: z.string().min(1),
  kind: AssetKindSchema,
  mimeType: z.string().min(1),
  size: z.number().int().nonnegative(),
  hash: z.string().min(1),
  fileName: z.string().min(1),
  /** 导入时无 Run；Run 产出的 Asset 挂其 id。 */
  runId: z.string().nullable(),
  /** 多 Agent 阶段预留；当前恒 null。 */
  nodeRunId: z.string().nullable(),
  createdBy: z.enum(['user', 'agent']),
  createdAt: IsoDateTimeSchema,
  metadata: z.record(z.string(), z.unknown()),
  preview: z.enum(['ready', 'unsupported', 'failed']),
})
export type AssetRef = z.infer<typeof AssetRefSchema>

/** 一次 Run 的面向用户成果卡：聚合该 Run 消息中出现的资源引用。 */
export const ArtifactSchema = z.object({
  runId: z.string().min(1),
  title: z.string().min(1),
  links: z.array(ResourceLinkSchema),
  createdAt: IsoDateTimeSchema,
})
export type Artifact = z.infer<typeof ArtifactSchema>
