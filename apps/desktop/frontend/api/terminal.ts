import type { Terminal } from '@reflexion-os-studio/runtime-client'
import { request } from './client'

/**
 * 集成终端前端请求入口（W2）：用户本机 shell，不经 Agent 通道。
 * requestId 由 request() 统一注入；组件不得直连 transport。
 */

/** 在当前项目 workspace 下新建终端；initialCwd=启动目录，非 shell 当前目录。 */
export function createTerminal(
  projectId: string,
  rows: number,
  cols: number,
): Promise<{ terminal: Terminal }> {
  return request<{ terminal: Terminal }>('terminal.create', {
    projectId,
    rows,
    cols,
  })
}

/** 列出某项目的全部终端及状态。 */
export function listTerminals(
  projectId: string,
): Promise<{ terminals: Terminal[] }> {
  return request<{ terminals: Terminal[] }>('terminal.list', { projectId })
}

/** 绑定输出消费者（consumerId=xterm 宿主实例身份），开始按序交付输出。 */
export function attachTerminal(
  projectId: string,
  terminalId: string,
  consumerId: string,
): Promise<{ terminal: Terminal; replayedBytes: number }> {
  return request<{ terminal: Terminal; replayedBytes: number }>(
    'terminal.attach',
    { projectId, terminalId, consumerId },
  )
}

/** 送入一批带序号的输入（base64 字节帧）；accepted 仅表示已入队，非命令执行完成。 */
export function writeTerminal(
  projectId: string,
  terminalId: string,
  inputSeq: number,
  dataBase64: string,
): Promise<{ accepted: true; inputSeq: number }> {
  return request<{ accepted: true; inputSeq: number }>('terminal.write', {
    projectId,
    terminalId,
    inputSeq,
    data: dataBase64,
  })
}

/** 更新终端行列；Runtime 侧保留最新尺寸（可合并）。 */
export function resizeTerminal(
  projectId: string,
  terminalId: string,
  rows: number,
  cols: number,
): Promise<{ ok: true }> {
  return request<{ ok: true }>('terminal.resize', {
    projectId,
    terminalId,
    rows,
    cols,
  })
}

/** 累计确认已消费到的 outputSeq，释放未确认输出额度。 */
export function ackTerminal(
  projectId: string,
  terminalId: string,
  throughOutputSeq: number,
): Promise<{ ok: true }> {
  return request<{ ok: true }>('terminal.ack', {
    projectId,
    terminalId,
    throughOutputSeq,
  })
}

/** 幂等关闭终端；完成回收后响应。 */
export function closeTerminal(
  projectId: string,
  terminalId: string,
): Promise<{ closed: true }> {
  return request<{ closed: true }>('terminal.close', { projectId, terminalId })
}
