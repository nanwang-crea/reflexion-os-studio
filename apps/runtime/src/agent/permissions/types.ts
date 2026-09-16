import type {
  ApprovalOverride,
  PermissionPreset,
  SandboxPolicy,
  ShellInterpreter,
  ToolOperation,
} from '@reflexion-os-studio/contracts'

export type { ShellInterpreter }

/** 会话授权的隔离身份：sessionId + workspaceRoot 双键（§7.3）。 */
export interface ApprovalScope {
  sessionId: string
  workspaceRoot: string | null
}

/**
 * 会话规则（内存态，Runtime 重启失效；不落盘、不进事件/日志/工作区文件）。
 * workspace-path：同 operation + 精确规范化相对路径才命中；
 * shell-prefix：token 前缀 + cwd + sandbox + network + interpreter 全等才命中。
 */
export interface WorkspacePathRule {
  kind: 'workspace-path'
  sessionId: string
  workspaceRoot: string
  operation: ToolOperation
  path: string
}

export interface ShellPrefixRule {
  kind: 'shell-prefix'
  id: string
  sessionId: string
  workspaceRoot: string | null
  interpreter: ShellInterpreter
  /** 规范化相对 cwd（'.' = 工作区根）；cwd 参与 rule identity（§9.3）。 */
  cwd: string
  prefix: string[]
  sandbox: Extract<SandboxPolicy, 'read-only' | 'workspace-write' | 'escalated'>
  network: boolean
}

export type SessionPermissionRule = WorkspacePathRule | ShellPrefixRule

/** 前缀匹配的实际请求视图（token 化后的命令 + 执行维度）。 */
export interface ShellRuleMatch {
  interpreter: ShellInterpreter
  cwd: string
  tokens: string[]
  sandbox: Extract<SandboxPolicy, 'read-only' | 'workspace-write' | 'escalated'>
  network: boolean
}

/** Run 装配所需的权限快照（launcher → gate）。 */
export interface RunPermissionSettings {
  preset: PermissionPreset
  approvalOverride: ApprovalOverride
}
