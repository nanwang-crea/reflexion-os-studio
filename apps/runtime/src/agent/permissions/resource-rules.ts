import type { ToolOperation } from '@reflexion-os-studio/contracts'
import type { ApprovalScope, WorkspacePathRule } from './types.js'

/**
 * 文件路径会话规则：sessionId + workspaceRoot + operation + 精确路径。
 * Windows 匹配按平台文件系统规则忽略大小写（协议展示保留原始大小写）；
 * POSIX 保持大小写敏感。
 */

const IS_WINDOWS = process.platform === 'win32'

function pathMatchKey(path: string): string {
  return IS_WINDOWS ? path.toLowerCase() : path
}

export function workspacePathRuleKey(input: {
  sessionId: string
  workspaceRoot: string
  operation: ToolOperation
  path: string
}): string {
  return [
    input.sessionId,
    input.workspaceRoot,
    input.operation,
    pathMatchKey(input.path),
  ].join('\u0000')
}

export function buildWorkspacePathRule(input: {
  scope: ApprovalScope
  operation: ToolOperation
  path: string
}): WorkspacePathRule {
  const workspaceRoot = input.scope.workspaceRoot
  if (workspaceRoot === null) {
    throw new Error('workspace-path rule requires a workspace')
  }
  return {
    kind: 'workspace-path',
    sessionId: input.scope.sessionId,
    workspaceRoot,
    operation: input.operation,
    path: input.path,
  }
}

export class WorkspacePathRuleStore {
  private readonly rules = new Map<string, WorkspacePathRule>()

  add(rule: WorkspacePathRule): void {
    this.rules.set(
      workspacePathRuleKey({
        sessionId: rule.sessionId,
        workspaceRoot: rule.workspaceRoot,
        operation: rule.operation,
        path: rule.path,
      }),
      rule,
    )
  }

  has(scope: ApprovalScope, operation: ToolOperation, path: string): boolean {
    if (scope.workspaceRoot === null) return false
    return this.rules.has(
      workspacePathRuleKey({
        sessionId: scope.sessionId,
        workspaceRoot: scope.workspaceRoot,
        operation,
        path,
      }),
    )
  }

  /** 会话删除时清全部规则（含 file.edit 的 read+edit 成对规则）。 */
  clearSession(sessionId: string): void {
    for (const [key, rule] of this.rules) {
      if (rule.sessionId === sessionId) this.rules.delete(key)
    }
  }

  get size(): number {
    return this.rules.size
  }
}
