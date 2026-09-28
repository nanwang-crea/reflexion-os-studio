import { z } from 'zod'
import { runtimeCommands } from './commands/runtime.js'
import { chatCommands } from './commands/chat.js'
import { agentCommands } from './commands/agent.js'
import { agentTemplateCommands } from './commands/agent-template.js'
import { delegationCommands } from './commands/delegation.js'
import { mutationReceiptCommands } from './commands/mutation-receipt.js'
import { agentSettingsCommands } from './commands/agent-settings.js'
import { mcpCommands } from './commands/mcp.js'
import { permissionsCommands } from './commands/permissions.js'
import { interactionsCommands } from './commands/interactions.js'
import { permissionCommands } from './commands/permission.js'
import { providerCommands } from './commands/provider.js'
import { instructionsCommands } from './commands/instructions.js'
import { skillCommands } from './commands/skill.js'
import { pluginCommands } from './commands/plugin.js'
import { workspaceCommands } from './commands/workspace.js'
import { assetCommands } from './commands/asset.js'
import { terminalCommands } from './commands/terminal.js'
export * from './commands/params.js'

export const CommandSchemaRegistry = {
  ...runtimeCommands,
  ...chatCommands,
  ...agentCommands,
  ...agentTemplateCommands,
  ...delegationCommands,
  ...mutationReceiptCommands,
  ...agentSettingsCommands,
  ...mcpCommands,
  ...permissionsCommands,
  ...interactionsCommands,
  ...permissionCommands,
  ...providerCommands,
  ...instructionsCommands,
  ...skillCommands,
  ...pluginCommands,
  ...workspaceCommands,
  ...assetCommands,
  ...terminalCommands,
} satisfies Record<string, { params: z.ZodType; result: z.ZodType }>

export type CommandName = keyof typeof CommandSchemaRegistry

/** Commands accepted by the desktop Host and forwarded to Runtime. */
export const runtimeMethodNames = Object.freeze(
  Object.keys(CommandSchemaRegistry).sort() as CommandName[],
)

export type CommandSchemaEntry = {
  params: z.ZodType
  result: z.ZodType
}

export function lookupCommandSchema(
  method: string,
): CommandSchemaEntry | undefined {
  const entry = (CommandSchemaRegistry as Record<string, CommandSchemaEntry>)[
    method
  ]
  return entry
}
