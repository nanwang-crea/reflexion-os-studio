#!/usr/bin/env node
// Mock MCP server(stdio JSON-RPC):初始化握手 → tools/list 返回两个工具 →
// tools/call 回显参数。供 runtime 单测与冒烟使用。
import { createInterface } from 'node:readline'

const readline = createInterface({ input: process.stdin })

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

readline.on('line', (line) => {
  let message
  try {
    message = JSON.parse(line)
  } catch {
    return
  }
  if (message.method === 'initialize') {
    write({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'mock-mcp', version: '1.0.0' },
      },
    })
    return
  }
  if (message.method === 'tools/list') {
    write({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        tools: [
          {
            name: 'echo',
            description: '回显输入文本',
            inputSchema: {
              type: 'object',
              properties: { text: { type: 'string' } },
            },
          },
          {
            name: 'count',
            description: '返回字符数',
            inputSchema: {
              type: 'object',
              properties: { text: { type: 'string' } },
            },
          },
        ],
      },
    })
    return
  }
  if (message.method === 'tools/call') {
    const args = message.params?.arguments ?? {}
    if (message.params?.name === 'echo') {
      write({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          content: [{ type: 'text', text: `echo:${String(args.text ?? '')}` }],
        },
      })
      return
    }
    if (message.params?.name === 'count') {
      write({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          content: [
            { type: 'text', text: `count:${String(args.text ?? '').length}` },
          ],
        },
      })
      return
    }
    write({
      jsonrpc: '2.0',
      id: message.id,
      error: { code: -32602, message: 'unknown tool' },
    })
    return
  }
  // initialized 等 notification 不回执。
})
