import type { ChatAgent } from './agent/index.js'
import { CommandError } from './agent/index.js'
import type { ApprovalGateway } from './agent/permissions.js'
import type { Store } from './store/index.js'

export type CommandResult = Record<string, unknown>

export interface CommandContext {
  store: Store
  agent: ChatAgent
  approvals: ApprovalGateway
}

export type CommandHandler = (
  params: Record<string, unknown>,
  ctx: CommandContext,
) => CommandResult

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
