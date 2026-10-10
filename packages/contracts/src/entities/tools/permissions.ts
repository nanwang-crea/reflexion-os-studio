import { z } from 'zod'

/** Agent 可见工具操作类型；与 PERMISSION-MODEL 的审批维度一致。 */
export const ToolOperationSchema = z.enum([
  'file.read',
  'file.list',
  'file.glob',
  'file.grep',
  'file.write',
  'file.write_stream',
  'file.edit',
  'file.delete',
  'file.move',
  'file.mkdir',
  'shell.execute',
])
export type ToolOperation = z.infer<typeof ToolOperationSchema>

/**
 * 审批操作的协议表示：内置操作（ToolOperation，点分命名如 file.read）或任意动态工具名
 * （MCP 工具的 `serverId/toolName`、Agent 侧注册的 manage_plan 等，命名不在此枚举内）。
 * 前端据此决定如何渲染审批卡；不能只接受内置枚举，否则动态工具名会被校验丢弃。
 */
export const ApprovalOperationSchema = z.union([
  ToolOperationSchema,
  z.string().min(1),
])
export type ApprovalOperation = z.infer<typeof ApprovalOperationSchema>

/**
 * 三档日常权限预设（替代 permissionMode + trusted 双轨）。
 * 全部只作用于工作区内；工作区外访问必须走显式提权审批。
 */
export const PermissionPresetSchema = z.enum([
  'workspace-read',
  'workspace-write',
  'workspace-full',
])
export type PermissionPreset = z.infer<typeof PermissionPresetSchema>

/**
 * 高级审批覆盖项：ask-everything 时读取/写入/删除/Shell 全部进入 ask
 * （硬拒绝仍为 denied）。仅当前会话生效、不持久化，不占日常下拉档位。
 */
export const ApprovalOverrideSchema = z.enum(['default', 'ask-everything'])
export type ApprovalOverride = z.infer<typeof ApprovalOverrideSchema>

/**
 * 沙箱能力档位：与权限决策正交——审批只决定"是否要问"，
 * SandboxPolicy 决定"获批后实际能访问什么"。任何档位下 no-read 机密规则不变。
 */
export const SandboxPolicySchema = z.enum([
  'read-only',
  'workspace-write',
  'escalated',
  'danger',
])
export type SandboxPolicy = z.infer<typeof SandboxPolicySchema>
