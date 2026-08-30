// 可配置的假 Rust System Runtime：SystemRuntimeClient 测试夹具。
// env: FAKE_MODE = normal | fail-startup | crash-after-ready
import { createInterface } from 'node:readline'

const mode = process.env.FAKE_MODE ?? 'normal'

function emit(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

if (mode === 'fail-startup') {
  // 不发 ready 直接退出：驱动握手失败 → 有限重启 → 预算耗尽路径。
  process.exit(1)
}

emit({
  jsonrpc: '2.0',
  method: 'system.ready',
  params: { protocolVersion: '1.0', runtimeVersion: 'fake', capabilities: [] },
})

if (mode === 'crash-after-ready') {
  setTimeout(() => process.exit(2), 100)
}

const readline = createInterface({ input: process.stdin })
readline.on('line', (line) => {
  let message
  try {
    message = JSON.parse(line)
  } catch {
    return
  }
  if (message.method === 'system.ping') {
    emit({ jsonrpc: '2.0', id: message.id, result: { ok: true } })
  }
  if (message.method === 'system.shutdown') {
    emit({ jsonrpc: '2.0', id: message.id, result: { ok: true } })
    setTimeout(() => process.exit(0), 50)
  }
})
