import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import {
  AgentBrowserLaunchSchema,
  BrowserPlanJsonSchema,
  AgentBrowserNavigateSchema,
  AgentBrowserDisplaySchema,
  AgentBrowserNavigateJsonSchema,
  AgentBrowserPageJsonSchema,
  AgentBrowserPageSchema,
  AgentBrowserClickJsonSchema,
  AgentBrowserTypeJsonSchema,
} from '@reflexion-os-studio/contracts'
import { PlaywrightBackend } from './backend.js'

const display = AgentBrowserDisplaySchema.parse(
  process.argv
    .find((arg) => arg.startsWith('--display='))
    ?.slice('--display='.length) ?? 'headless',
)
const launch = AgentBrowserLaunchSchema.parse(
  JSON.parse(
    process.argv
      .find((arg) => arg.startsWith('--launch='))
      ?.slice('--launch='.length) ?? '{"channel":"chromium"}',
  ),
)
const backend = new PlaywrightBackend(display, launch)
const server = new Server(
  { name: 'reflexion-playwright', version: '1' },
  { capabilities: { tools: {} } },
)
let tail = Promise.resolve()
const errors = new Set([
  'browser_system_chrome_unavailable',
  'browser_url_denied',
  'browser_page_stale',
  'browser_source_changed',
  'browser_snapshot_unavailable',
  'browser_interaction_denied',
  'browser_interaction_failed',
  'browser_interaction_network_denied',
])
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    { name: 'execute', inputSchema: BrowserPlanJsonSchema },
    { name: 'navigate', inputSchema: AgentBrowserNavigateJsonSchema },
    { name: 'click', inputSchema: AgentBrowserClickJsonSchema },
    { name: 'type', inputSchema: AgentBrowserTypeJsonSchema },
    { name: 'read', inputSchema: AgentBrowserPageJsonSchema },
    { name: 'close', inputSchema: { type: 'object' } },
  ],
}))
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const invoke = async () => {
    try {
      const { name, arguments: args } = request.params
      let result: unknown
      if (name === 'execute') result = await backend.execute(args)
      else if (name === 'navigate') {
        const input = AgentBrowserNavigateSchema.parse(args)
        result = await backend.navigate(input.url, input.from)
      } else if (name === 'click' || name === 'type')
        result = await backend.interact(name, args)
      else if (name === 'read')
        result = await backend.read(AgentBrowserPageSchema.parse(args))
      else if (name === 'close') {
        await backend.close()
        result = { closed: true }
      } else throw new Error('invalid_tool')
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result) }],
      }
    } catch (error) {
      const code =
        error instanceof Error && errors.has(error.message)
          ? error.message
          : 'browser_operation_failed'
      return { isError: true, content: [{ type: 'text' as const, text: code }] }
    }
  }
  if (request.params.name === 'close') return invoke()
  const result = tail.then(invoke)
  tail = result.then(
    () => {},
    () => {},
  )
  return result
})
let stopping = false
async function stop() {
  if (stopping) return
  stopping = true
  const timer = setTimeout(() => process.exit(1), 2000)
  timer.unref()
  await backend.close()
  await server.close()
  process.exit(0)
}
process.once('SIGTERM', () => void stop())
process.once('SIGINT', () => void stop())
process.stdin.once('end', () => void stop())
process.once('disconnect', () => void stop())
await server.connect(new StdioServerTransport())
