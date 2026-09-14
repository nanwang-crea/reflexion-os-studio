import { TransportError } from '@reflexion-os-studio/runtime-client'
import { showToast } from '../../components/Toast'
import { INPUT_OUT_OF_ORDER_MESSAGE } from './input-channel'

/**
 * 终端错误分类与用户可见通知（W3）：后端稳定 code → 中文提示映射。
 * 错误分类语义：有明确 JSON-RPC 错误回执 = definite（后端可幂等判重，
 * 前端可安全重试一次）；请求超时/响应校验失败 = uncertain（写入状态
 * 未知，绝不自动重发）。
 */

const TERMINAL_ERROR_NOTICES: Record<string, string> = {
  terminal_quota_project: '本项目终端数量已达上限，请先关闭旧标签',
  terminal_quota_global: '全局终端数量已达上限，请先关闭其他项目的终端',
  terminal_quota_retained: '已退出终端留存已满，请先清理退出标签',
  terminal_not_found: '终端已不存在',
  terminal_not_running: '终端已退出，无法执行该操作',
  terminal_closed: '终端已关闭',
  terminal_input_out_of_order: INPUT_OUT_OF_ORDER_MESSAGE,
  // 防御性兜底（终审 #3）：前端 flush 已按 ≤8 KiB 切批，正常不可能触发；
  // 出现即为缺陷信号（第三方调用方/回归），如实报而不静默截断。
  terminal_input_batch_too_large:
    '输入批次超限，请联系开发者（正常不会发生）。',
  too_many_terminals:
    '系统终端会话已满（含未清理的退出会话），请关闭一些终端标签后重试。',
  pty_error: '终端创建失败：无法启动 shell。',
  io_error: '终端 I/O 失败，标签可能已失效。',
  project_not_found: '项目未找到或未打开',
}

/** 从 TransportError.runtimeError.data 里取后端稳定错误 code（无则 null）。 */
export function extractErrorCode(error: unknown): string | null {
  if (error instanceof TransportError) {
    const data = error.runtimeError?.data as { code?: string } | undefined
    if (typeof data?.code === 'string') return data.code
  }
  return null
}

export function isUncertainError(error: unknown): boolean {
  return !(error instanceof TransportError && error.runtimeError !== undefined)
}

/** 轻提示（toast，不打断）：优先稳定 code 映射文案，兜底原始消息。 */
export function notifyTerminalError(error: unknown, prefix: string): void {
  const code = extractErrorCode(error)
  const notice = code !== null ? TERMINAL_ERROR_NOTICES[code] : undefined
  if (notice !== undefined) {
    showToast(notice, 'error')
    return
  }
  showToast(
    `${prefix}：${error instanceof Error ? error.message : String(error)}`,
    'error',
  )
}
