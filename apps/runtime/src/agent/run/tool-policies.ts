import { fileResourceKeys } from '../delegation/resource-locks.js'
import type { ToolExecutionPolicy } from '@reflexion-os-studio/agent-core'

/**
 * 内置工具的副作用调度策略（W3）：
 * - read：workspace 只读命令按有界批次并行；
 * - write：可信单文件写可并行；其余变更串行，读写段之间保留屏障；
 * - shell：workspace 级 mutation lane，与任何 mutation 不交叉；
 * - state：会话内状态写（计划/委派）串行；
 * - pure：纯计算可并行。
 * 资源键只用于调度排序，不替代 Rust 侧 workspace/授权检查。
 */
export const READ_POLICY = (pathKey = true): ToolExecutionPolicy => ({
  effect: 'read',
  resourceKeys: pathKey ? fileResourceKeys : () => [],
})

export const WRITE_POLICY: ToolExecutionPolicy = {
  effect: 'write',
  resourceKeys: fileResourceKeys,
  idempotent: false,
}

export const FILE_WRITE_POLICY: ToolExecutionPolicy = {
  ...WRITE_POLICY,
  concurrentSafe: true,
}

export const SHELL_POLICY: ToolExecutionPolicy = {
  effect: 'shell',
  resourceKeys: () => ['workspace:mutation-lane'],
  idempotent: false,
}

export const STATE_POLICY: ToolExecutionPolicy = {
  effect: 'state',
  resourceKeys: () => ['session:state'],
}

export const PURE_POLICY: ToolExecutionPolicy = { effect: 'pure' }

/** Stateless HTTP reads do not conflict, even on the same origin or URL. */
export const WEB_READ_POLICY: ToolExecutionPolicy = {
  effect: 'read',
  resourceKeys: () => [],
  idempotent: true,
}
