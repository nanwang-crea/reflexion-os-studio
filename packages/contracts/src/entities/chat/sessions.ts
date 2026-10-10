import { z } from 'zod'
import { IsoDateTimeSchema } from '../shared.js'

export const ProjectSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  // 项目对应的本地文件夹绝对路径；历史数据允许为空字符串。
  folderPath: z.string(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
})
export type Project = z.infer<typeof ProjectSchema>

export const SessionStatusSchema = z.enum(['active', 'archived'])
export type SessionStatus = z.infer<typeof SessionStatusSchema>

export const ExecutionModeSchema = z.enum(['execute', 'plan'])
export type ExecutionMode = z.infer<typeof ExecutionModeSchema>

export const SessionSchema = z.object({
  id: z.string().min(1),
  // null 表示不关联任何项目的独立会话。
  projectId: z.string().min(1).nullable(),
  // 项目 Git 会话绑定的本地分支；独立会话或旧数据为 null。
  gitBranch: z.string().min(1).nullable(),
  title: z.string().min(1),
  status: SessionStatusSchema,
  executionMode: ExecutionModeSchema,
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
})
export type Session = z.infer<typeof SessionSchema>
