import type {
  ApprovalSubject,
  PermissionPreset,
  ToolOperation,
} from '@reflexion-os-studio/contracts'

export type DecisionMode = 'automatic' | 'ask' | 'denied'

/** 缺省档位：升级/未知输入一律保守回落到最窄日常档。 */
export const DEFAULT_PRESET: PermissionPreset = 'workspace-read'

/**
 * 三档日常预设 × 十种工具操作 → 决策矩阵（PERMISSION-MODEL §1）。
 * workspace-read 是"写要问"而不是"写被拒"（与旧 read-only 不同）。
 */
const POLICY: Record<PermissionPreset, Record<ToolOperation, DecisionMode>> = {
  'workspace-read': {
    'file.read': 'automatic',
    'file.list': 'automatic',
    'file.glob': 'automatic',
    'file.grep': 'automatic',
    'file.write': 'ask',
    'file.edit': 'ask',
    'file.mkdir': 'ask',
    'file.move': 'ask',
    'file.delete': 'ask',
    'shell.execute': 'ask',
  },
  'workspace-write': {
    'file.read': 'automatic',
    'file.list': 'automatic',
    'file.glob': 'automatic',
    'file.grep': 'automatic',
    'file.write': 'automatic',
    'file.edit': 'automatic',
    'file.mkdir': 'automatic',
    'file.move': 'automatic',
    'file.delete': 'ask',
    'shell.execute': 'ask',
  },
  'workspace-full': {
    'file.read': 'automatic',
    'file.list': 'automatic',
    'file.glob': 'automatic',
    'file.grep': 'automatic',
    'file.write': 'automatic',
    'file.edit': 'automatic',
    'file.mkdir': 'automatic',
    'file.move': 'automatic',
    'file.delete': 'automatic',
    'shell.execute': 'automatic',
  },
}

const TOOL_OPERATIONS = new Set<string>(Object.keys(POLICY['workspace-read']))

export function isToolOperation(toolName: string): toolName is ToolOperation {
  return TOOL_OPERATIONS.has(toolName)
}

/** 非操作类的内置纯计算工具：无需审批（ask-everything 也不覆盖——无副作用）。 */
const AUTOMATIC_OTHER_TOOLS = new Set([
  'get_current_time',
  'web.fetch',
  'skill.use',
  // 计划工具只在本会话的 plans 表内写状态，不触工作区/Shell，无需审批。
  // manage_plan 为新名；update_plan 保留兼容别名映射到同一实现。
  'manage_plan',
  'update_plan',
  // 用户问答走独立 InteractionGateway，不属于权限审批。
  'ask_user',
  'enter_plan_mode',
  'exit_plan_mode',
  // 记忆只写数据目录内应用自管的 MEMORY.md，不触用户工作区，免审批。
  'memory.remember',
  // 委派只创建 Runtime 管理的受限 child Run；工具/深度/并发预算由 starter 强制。
  'task',
])

/** Rust 侧 require_grant 强制校验凭据的操作（写类 + Shell）；读取类不受约束。 */
const RUST_GRANT_OPERATIONS = new Set<ToolOperation>([
  'file.write',
  'file.edit',
  'file.delete',
  'file.move',
  'file.mkdir',
  'shell.execute',
])

/** 该工具调用是否必须携带 Rust 凭据（含 automatic 放行的写/Shell）。 */
export function requiresRustGrant(toolName: string): boolean {
  return isToolOperation(toolName) && RUST_GRANT_OPERATIONS.has(toolName)
}

/**
 * legacy 双轨（permissionMode + trusted）→ 单一 preset 的一版本兼容映射。
 * @deprecated 下一协议版本删除 legacy 分支。
 */
export function legacyToPreset(
  permissionMode: 'workspace' | 'read-only' | undefined,
  trusted: boolean | undefined,
): PermissionPreset | null {
  if (trusted === true) return 'workspace-full'
  if (permissionMode === 'workspace' || permissionMode === 'read-only') {
    return 'workspace-read'
  }
  return null
}

/** 解析 message.send 的档位：新字段优先，legacy 兼容一个版本，缺省保守回落。 */
export function resolveInputPreset(input: {
  permissionPreset?: PermissionPreset
  permissionMode?: 'workspace' | 'read-only'
  trusted?: boolean
}): PermissionPreset {
  return (
    input.permissionPreset ??
    legacyToPreset(input.permissionMode, input.trusted) ??
    DEFAULT_PRESET
  )
}

/** 权限决策入参：subject 由 Runtime 构造（模型不可提供），决策不再只看工具名。 */
export interface PermissionRequest {
  toolName: string
  subject: ApprovalSubject
  /** shell 显式提权标志（无工作区会话唯一可审批入口）。 */
  escalation: boolean
}

export interface PermissionGateOptions {
  preset: PermissionPreset
  hasWorkspace: boolean
  /** 高级审批覆盖项（ask-everything），仅当前会话生效。 */
  approvalOverride: 'default' | 'ask-everything'
  /** Danger lease 活跃查询：每次决策实时读取（租约可随时撤销）。 */
  dangerActive: () => boolean
  /** 会话执行模式实时查询；plan 模式优先于 preset/Danger 强制只读。 */
  executionMode?: () => 'execute' | 'plan'
}

const PLAN_MODE_ALLOWED_TOOLS = new Set([
  'get_current_time',
  'web.fetch',
  'skill.use',
  'manage_plan',
  'update_plan',
  'ask_user',
  'enter_plan_mode',
  'exit_plan_mode',
  'file.read',
  'file.list',
  'file.glob',
  'file.grep',
])

/**
 * 单次 Run 的策略闸门：preset 矩阵 + ask-everything 覆盖 + Danger 旁路 +
 * 无工作区硬边界。Danger 只旁路内置操作的审批，MCP/未知工具仍 ask；
 * denied（硬边界）永远优先。
 */
export class PermissionGate {
  constructor(private readonly opts: PermissionGateOptions) {}

  /** 本次 Run 的预设（choice 构造需要）。 */
  get preset(): PermissionPreset {
    return this.opts.preset
  }

  get dangerActive(): boolean {
    return this.opts.dangerActive()
  }

  decisionFor(request: PermissionRequest): DecisionMode {
    if (
      this.opts.executionMode?.() === 'plan' &&
      !PLAN_MODE_ALLOWED_TOOLS.has(request.toolName)
    ) {
      return 'denied'
    }
    if (!isToolOperation(request.toolName)) {
      // MCP 与其它未知工具默认 ask（需用户审批），内置纯计算工具白名单放行。
      // Danger lease 不旁路 MCP：系统范围访问经 shell 承担，工具审批语义不变。
      return AUTOMATIC_OTHER_TOOLS.has(request.toolName) ? 'automatic' : 'ask'
    }
    if (this.dangerActive) return 'automatic'
    if (!this.opts.hasWorkspace) {
      // 无工作区：file.* 一律拒绝；Shell 只有显式提权请求才进入审批。
      if (request.toolName === 'shell.execute' && request.escalation) {
        return 'ask'
      }
      return 'denied'
    }
    let decision = POLICY[this.opts.preset][request.toolName]
    // 工作区外访问必须显式提权审批（§6.1"工作区外=ask escalation"列）：
    // 任何日常档位都不因 automatic 静默扩大沙箱（Danger 在前面已旁路）。
    if (request.toolName === 'shell.execute' && request.escalation) {
      if (decision === 'automatic') decision = 'ask'
    }
    // ask-everything：automatic 升为 ask；denied（硬边界）不变。
    if (
      decision === 'automatic' &&
      this.opts.approvalOverride === 'ask-everything'
    ) {
      decision = 'ask'
    }
    return decision
  }
}
