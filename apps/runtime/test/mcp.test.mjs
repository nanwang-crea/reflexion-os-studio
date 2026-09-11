import assert from 'node:assert/strict'
import { test } from 'node:test'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { McpClient } from '../dist/mcp/client.js'
import { McpManager } from '../dist/mcp/manager.js'
import { createMcpTool } from '../dist/agent/tools/mcp.js'
import { Store } from '../dist/store/index.js'
import { mkdtempSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'

const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'mock-mcp-server.mjs',
)
const NODE = process.execPath

test('McpClient handshake, lists tools and calls them', async () => {
  const client = new McpClient({
    command: NODE,
    args: [FIXTURE],
    env: {},
  })
  await client.connect()
  const tools = await client.listTools()
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ['echo', 'count'],
  )
  const echo = await client.callTool('echo', { text: '你好' })
  assert.equal(echo, 'echo:你好')
  const count = await client.callTool('count', { text: 'abcde' })
  assert.equal(count, 'count:5')
  await assert.rejects(client.callTool('nope', {}), /unknown tool/)
  client.dispose()
})

test('McpManager connects server, exposes tools and handles errors', async () => {
  const store = new Store(mkdtempSync(join(tmpdir(), 'reflexion-mcp-')))
  const events = []
  const manager = new McpManager(store, (event) => events.push(event))

  const created = store.mcpServers.create({
    name: 'mock',
    command: NODE,
    args: [FIXTURE],
    env: [],
  })
  await manager.reload()
  const server = store.mcpServers.get(created.id)
  assert.equal(server?.status, 'ready')
  assert.equal(server?.toolCount, 2)

  const tools = manager.allTools()
  assert.deepEqual(
    tools.map((tool) => tool.spec.name),
    [`${created.id}/echo`, `${created.id}/count`],
  )
  // toolName 保持服务器原始名,供工具桥执行时使用。
  assert.deepEqual(
    tools.map((tool) => tool.toolName),
    ['echo', 'count'],
  )

  const echo = await manager.callTool(created.id, 'echo', { text: 'ok' })
  assert.equal(echo.isError, false)
  assert.equal(echo.content, 'echo:ok')

  const missing = await manager.callTool('missing-id', 'echo', {})
  assert.equal(missing.isError, true)
  assert.match(missing.content, /未连接/)

  assert.ok(events.some((event) => event.type === 'mcp.changed'))
  manager.dispose()
  store.close()
})

test('MCP tool bridge registers prefixed name, calls server with raw tool name', async () => {
  const store = new Store(mkdtempSync(join(tmpdir(), 'reflexion-mcp-')))
  const manager = new McpManager(store, () => {})
  store.mcpServers.create({
    name: 'mock',
    command: NODE,
    args: [FIXTURE],
    env: [],
  })
  await manager.reload()
  const [{ serverId, toolName, spec }] = manager.allTools()
  const tool = createMcpTool(manager, serverId, toolName, spec)
  // 注册名与协议声明名一致(serverId/toolName),不出现双重前缀。
  assert.equal(tool.name, `${serverId}/echo`)
  const result = await tool.execute({
    args: { text: '桥测' },
    signal: new AbortController().signal,
  })
  assert.equal(result.isError, false)
  assert.equal(result.content, 'echo:桥测')
  manager.dispose()
  store.close()
})

test('McpClient aborts hung tool call fast and sends notifications/cancelled', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'reflexion-mcp-cancel-'))
  const marker = join(dir, 'cancelled.jsonl')
  const client = new McpClient({
    command: NODE,
    args: [FIXTURE],
    env: { MOCK_MCP_CANCELLED_FILE: marker },
  })
  await client.connect()
  const controller = new AbortController()
  const pending = client.callTool('slow', {}, controller.signal)
  setTimeout(() => controller.abort(), 100)
  // 快速失败：不等 30s 协议超时，立即以 AbortError 拒绝。
  await assert.rejects(pending, (error) => error.name === 'AbortError')
  // 回执：mock server 收到 notifications/cancelled 并落盘。
  for (let i = 0; i < 80 && !existsSync(marker); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  const receipts = existsSync(marker)
    ? readFileSync(marker, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
    : []
  const receipt = receipts.find((entry) => typeof entry.requestId === 'number')
  assert.ok(receipt, 'server should receive notifications/cancelled')
  assert.equal(receipt.reason, 'client aborted')
  // 取消后连接仍可用（pending 表未被污染）。
  assert.equal(await client.callTool('echo', { text: '续' }), 'echo:续')
  client.dispose()
})
