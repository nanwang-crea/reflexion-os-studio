// 测试用假 System Runtime（终端通知路由）：
// 握手 → 响应 ping（先推两条 terminal 通知再回包，验证通知不阻塞响应关联）
// → 支持 system.shutdown 干净退出。
import { PROTOCOL_VERSION } from '@reflexion-os-studio/contracts'

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`)

send({
  jsonrpc: '2.0',
  method: 'system.ready',
  params: {
    protocolVersion: PROTOCOL_VERSION,
    runtimeVersion: '0.0.0-test',
    capabilities: ['system.bootstrap', 'system.tools'],
  },
})

process.stdin.setEncoding('utf8')
let buffer = ''
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let index
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index).trim()
    buffer = buffer.slice(index + 1)
    if (!line) continue
    const request = JSON.parse(line)
    if (request.method === 'system.ping') {
      send({
        jsonrpc: '2.0',
        method: 'terminal.output',
        params: {
          terminalId: 't1',
          outputSeq: 0,
          generation: 1,
          data: 'aGk=',
        },
      })
      send({
        jsonrpc: '2.0',
        method: 'terminal.state',
        params: {
          terminalId: 't1',
          generation: 1,
          status: 'running',
          exitCode: null,
        },
      })
      send({ jsonrpc: '2.0', id: request.id, result: { ok: true } })
    }
    if (request.method === 'test.crash') {
      // 不回包直接退出：驱动客户端崩溃重启（代际 +1）路径。
      process.exit(1)
    }
    if (request.method === 'system.shutdown') {
      send({ jsonrpc: '2.0', id: request.id, result: { ok: true } })
      process.exit(0)
    }
  }
})
