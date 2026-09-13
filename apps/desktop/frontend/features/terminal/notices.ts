import { TransportError } from '@reflexion-os-studio/runtime-client'
import { showToast } from '../../components/Toast'

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
