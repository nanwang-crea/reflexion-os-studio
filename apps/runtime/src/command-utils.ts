import type { ChatAgent } from './agent/index.js'
import { CommandError } from './agent/index.js'
import type { ApprovalGateway } from './agent/permissions.js'
import type { Store } from './store/index.js'
import type { SystemRuntimeClient } from './system.js'
import type { WorkspaceIndexer } from './workspace/indexer.js'

export type CommandResult = Record<string, unknown>

export interface CommandContext {
  store: Store
  agent: ChatAgent
  approvals: ApprovalGateway
  /** Phase 1B Workspace 索引器（仅 workspace.* 命令使用）。 */
  workspace: WorkspaceIndexer
  /** Rust System Runtime 通道（文件树/查看器的执行后端）。 */
  system: SystemRuntimeClient
}

export type CommandHandler = (
  params: Record<string, unknown>,
  ctx: CommandContext,
) => CommandResult | Promise<CommandResult>

export function requireString(
  params: Record<string, unknown>,
  key: string,
): string {
  const value = params[key]
  if (typeof value !== 'string' || value === '') {
    throw new CommandError('invalid_request', `missing param: ${key}`)
  }
  return value
}
