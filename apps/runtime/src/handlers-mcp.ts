import { CommandError } from './agent/index.js'
import { deleteSecret, saveSecret } from './secrets.js'
import { requireString, type CommandHandler } from './command-utils.js'

export const mcpCommandHandlers: Record<string, CommandHandler> = {
  'mcp.list': (_params, { mcp }) => {
    if (!mcp) throw new CommandError('unavailable', 'MCP service unavailable')
    return { servers: mcp.list(), tools: mcp.listTools() }
  },
  'mcp.add': (params, { mcp }) => {
    if (!mcp) throw new CommandError('unavailable', 'MCP service unavailable')
    const env = Array.isArray(params.env) ? params.env : []
    const keys = new Set<string>()
    const storedEnv = env.map((entry) => {
      if (!entry || typeof entry !== 'object')
        throw new CommandError('invalid_request', 'invalid env entry')
      const item = entry as Record<string, unknown>
      const key = typeof item.key === 'string' ? item.key : ''
      if (!key) throw new CommandError('invalid_request', 'env key is required')
      if (keys.has(key))
        throw new CommandError('invalid_request', `duplicate env key: ${key}`)
      keys.add(key)
      const secret = typeof item.secret === 'string' ? item.secret : undefined
      const secretRef =
        typeof item.secretRef === 'string' ? item.secretRef : undefined
      if (!secret && !secretRef)
        throw new CommandError(
          'invalid_request',
          `env ${key} requires secret or secretRef`,
        )
      return { key, secretRef: secretRef ?? saveSecret(secret as string) }
    })
    return {
      server: mcp.add({
        name: requireString(params, 'name'),
        command: requireString(params, 'command'),
        args: Array.isArray(params.args) ? params.args.map(String) : [],
        env: storedEnv,
      }),
    }
  },
  'mcp.remove': (params, { mcp }) => {
    if (!mcp) throw new CommandError('unavailable', 'MCP service unavailable')
    const serverId = requireString(params, 'serverId')
    const server = mcp.list().find((item) => item.id === serverId)
    const removed = mcp.remove(serverId)
    if (removed && server) {
      for (const entry of server.env) deleteSecret(entry.secretRef)
    }
    return { removed }
  },
  'mcp.toggle': async (params, { mcp }) => {
    if (!mcp) throw new CommandError('unavailable', 'MCP service unavailable')
    const server = await mcp.toggle(requireString(params, 'serverId'))
    if (!server)
      throw new CommandError('invalid_request', 'MCP server not found')
    return { server }
  },
  'mcp.reload': async (_params, { mcp }) => {
    if (!mcp) throw new CommandError('unavailable', 'MCP service unavailable')
    return { servers: await mcp.reload() }
  },
}
