import { after } from 'node:test'
import { createServer } from 'node:http'

// undici 会为 fetch 池化 keep-alive 连接：server.close() 后空闲连接仍持有事件循环，
// 导致测试进程不退出、整个文件被 runner 的文件级超时强制取消。
// 因此把各用例创建的 server 登记在此，文件结束时强制关闭残余连接与监听器。
const servers = new Set()

export function startServer(handler) {
  return new Promise((resolve, reject) => {
    const server = createServer(handler)
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      servers.add(server)
      server.once('close', () => servers.delete(server))
      resolve(server)
    })
  })
}

after(() => {
  for (const server of servers) {
    // 正常退出的用例已自行 close()；断言中途失败时可能没有，这里兜底。
    if (server.listening) server.close()
    server.closeAllConnections()
  }
})

export function sseBody() {
  const lines = [
    'data: {"choices":[{"delta":{"content":"He"}}]}',
    '',
    'data: {"choices":[{"delta":{"content":"llo"}}]}',
    '',
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2}}',
    '',
    'data: [DONE]',
    '',
  ]
  return lines.join('\n')
}
