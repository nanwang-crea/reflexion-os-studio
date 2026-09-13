import type { Terminal } from '@reflexion-os-studio/contracts'
import type { RuntimeTransport } from './transport.js'

export type { Terminal }

export interface TerminalClientRequestOptions {
  transport: RuntimeTransport
  requestId: string
}

/** 在项目 workspace 下新建终端；返回的 initialCwd 是启动目录，非 shell 当前目录。 */
export function createTerminal(
  request: TerminalClientRequestOptions & {
    projectId: string
    rows: number
    cols: number
  },
): Promise<{ terminal: Terminal }> {
  const { transport, requestId, ...params } = request
  return transport.request('terminal.create', { requestId, ...params })
}

/** 列出某项目的全部终端及状态。 */
export function listTerminals(
  request: TerminalClientRequestOptions & { projectId: string },
): Promise<{ terminals: Terminal[] }> {
  const { transport, requestId, ...params } = request
  return transport.request('terminal.list', { requestId, ...params })
}

/** 绑定输出消费者（consumerId=前端 xterm 宿主实例身份），允许开始输出。 */
export function attachTerminal(
  request: TerminalClientRequestOptions & {
    projectId: string
    terminalId: string
    consumerId: string
  },
): Promise<{ terminal: Terminal; replayedBytes: number }> {
  const { transport, requestId, ...params } = request
  return transport.request('terminal.attach', { requestId, ...params })
}

/** 送入一批带序号的输入；dataBase64 为 base64 字节帧，重复序号不重写。 */
export function writeTerminal(
  request: TerminalClientRequestOptions & {
    projectId: string
    terminalId: string
    inputSeq: number
    dataBase64: string
  },
): Promise<{ accepted: true; inputSeq: number }> {
  const { transport, requestId, dataBase64, ...params } = request
  return transport.request('terminal.write', {
    requestId,
    ...params,
    data: dataBase64,
  })
}

/** 更新终端行列；Runtime 侧保留最新尺寸（可合并）。 */
export function resizeTerminal(
  request: TerminalClientRequestOptions & {
    projectId: string
    terminalId: string
    rows: number
    cols: number
  },
): Promise<{ ok: true }> {
  const { transport, requestId, ...params } = request
  return transport.request('terminal.resize', { requestId, ...params })
}

/** 累计确认已消费到的 outputSeq，释放未确认输出额度。 */
export function ackTerminal(
  request: TerminalClientRequestOptions & {
    projectId: string
    terminalId: string
    throughOutputSeq: number
  },
): Promise<{ ok: true }> {
  const { transport, requestId, ...params } = request
  return transport.request('terminal.ack', { requestId, ...params })
}

/** 幂等关闭终端，完成回收后响应。 */
export function closeTerminal(
  request: TerminalClientRequestOptions & {
    projectId: string
    terminalId: string
  },
): Promise<{ closed: true }> {
  const { transport, requestId, ...params } = request
  return transport.request('terminal.close', { requestId, ...params })
}
