import { createConnection } from '@playwright/mcp'
import type { BrowserContext } from 'playwright'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'

/** The official MCP shares our isolated context; it never launches another one. */
export async function connectBrowserMcp(
  context: BrowserContext,
  outputDir: string,
) {
  const server = await createConnection(
    {
      browser: { browserName: 'chromium', isolated: false },
      capabilities: ['core'],
      webmcp: false,
      outputDir,
      saveSession: false,
      imageResponses: 'omit',
      codegen: 'none',
      snapshot: { mode: 'none' },
      timeouts: { navigation: 15000, action: 5000 },
    },
    async () => context,
  )
  const client = new Client({ name: 'reflexion-browser', version: '1' })
  try {
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    return { client, server }
  } catch (error) {
    await Promise.allSettled([client.close(), server.close()])
    throw error
  }
}
