import type { ToolExecutionPolicy } from '@reflexion-os-studio/agent-core'

/**
 * 内置工具的副作用调度策略（W3）：
 * - read：workspace 只读命令按 workspace:path 冲突键并行；
 * - write：workspace 变更串行（同轮内一个完成后后续 read 才能开始）；
 * - shell：workspace 级 mutation lane，与任何 mutation 不交叉；
 * - state：会话内状态写（计划/委派）串行；
 * - pure：纯计算可并行。
 * 资源键只用于调度排序，不替代 Rust 侧 workspace/授权检查。
 */
export const READ_POLICY = (pathKey = true): ToolExecutionPolicy => ({
  effect: 'read',
  ...(pathKey
    ? {
        resourceKeys: (args) => {
          const path =
            typeof args === 'object' &&
            args !== null &&
            !Array.isArray(args) &&
            typeof (args as Record<string, unknown>).path === 'string'
              ? (args as Record<string, unknown>).path
              : ''
          return path === '' ? [] : [`workspace:${path}`]
        },
      }
    : {}),
})

export const WRITE_POLICY: ToolExecutionPolicy = {
  effect: 'write',
  resourceKeys: (args) => {
    const path =
      typeof args === 'object' &&
      args !== null &&
      !Array.isArray(args) &&
      typeof (args as Record<string, unknown>).path === 'string'
        ? (args as Record<string, unknown>).path
        : ''
    return path === '' ? [] : [`workspace:${path}`]
  },
  idempotent: false,
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
