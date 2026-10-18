import { DEFAULT_TIMEOUT_MS } from './shared.js'

const causes: Record<string, string> = {
  UND_ERR_SOCKET: '连接在传输期间关闭',
  ECONNRESET: '连接被重置',
  EPIPE: '写入时连接已关闭',
  ECONNREFUSED: '目标拒绝连接，请检查服务地址及代理',
  ENOTFOUND: '域名解析失败，请检查服务地址及 DNS',
  EAI_AGAIN: 'DNS 暂时不可用',
  ETIMEDOUT: '网络连接超时',
  UND_ERR_CONNECT_TIMEOUT: '建立连接超时',
  UND_ERR_HEADERS_TIMEOUT: '等待响应头超时',
  UND_ERR_BODY_TIMEOUT: '等待响应数据超时',
  CERT_HAS_EXPIRED: 'TLS 证书已过期',
  DEPTH_ZERO_SELF_SIGNED_CERT: 'TLS 证书不受信任',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: '无法验证 TLS 证书链',
  ERR_TLS_CERT_ALTNAME_INVALID: 'TLS 证书与域名不匹配',
  UND_ERR_RES_CONTENT_LENGTH_MISMATCH: '响应数据长度不完整',
}

interface FailureContext {
  phase: 'request' | 'stream'
  receivedData: boolean
  retries: number
  maxRetries: number
  timeoutMs?: number
  signal: AbortSignal
  apiKey: string
}

/** Only known diagnostic codes/messages are exposed; never dump socket or request data. */
export function describeTransportFailure(
  error: unknown,
  context: FailureContext,
) {
  const pending: unknown[] = [error]
  const seen = new Set<unknown>()
  const codes = new Set<string>()
  let timeout = false
  let explanation = '底层未提供可识别的网络错误码'
  let redacted = false
  for (let index = 0; index < pending.length && index < 12; index += 1) {
    const item = pending[index]
    if (!(item instanceof Error) || seen.has(item)) continue
    seen.add(item)
    timeout ||= item.name === 'TimeoutError'
    redacted ||= !!context.apiKey && item.message.includes(context.apiKey)
    if (item.message === 'malformed SSE data payload')
      explanation = '响应中的 SSE 数据格式无效（malformed SSE data payload）'
    if (item.message === 'terminated') explanation = '响应流意外中断'
    if (item.message === 'fetch failed') explanation = '网络请求未能完成'
    if (item.message === 'provider response has no body')
      explanation = '服务返回了空响应体'
    if (item.message === 'stream ended before [DONE]')
      explanation = '响应流结束，但未收到协议结束标记 [DONE]'
    const code = 'code' in item ? item.code : undefined
    if (typeof code === 'string' && Object.hasOwn(causes, code)) {
      codes.add(code)
      timeout ||= code.includes('TIMEOUT') || code === 'ETIMEDOUT'
    }
    pending.push(item.cause)
    if (item instanceof AggregateError)
      pending.push(...item.errors.slice(0, 12))
  }
  const idleTimedOut =
    context.signal.aborted &&
    context.signal.reason instanceof Error &&
    context.signal.reason.name === 'TimeoutError'
  timeout ||= idleTimedOut
  if (idleTimedOut) {
    explanation = `连续 ${context.timeoutMs ?? DEFAULT_TIMEOUT_MS} 毫秒未收到响应数据，触发本地等待超时`
  }
  const code = timeout ? 'timeout' : 'network'
  const phase =
    context.phase === 'request'
      ? '请求阶段失败（尚未收到响应头）'
      : `读取响应流失败（${context.receivedData ? '已收到部分响应数据' : '尚未收到响应数据'}）`
  const details = [...codes].map((value) => `${value}：${causes[value]}`)
  const detail = `${phase}：${explanation}${details.length ? `；${details.join('；')}` : ''}${redacted ? ' [redacted]' : ''}`
  return {
    code,
    reason: `${timeout ? 'timeout' : context.phase === 'stream' ? 'stream failure' : 'network'}: ${detail}`,
    message: `${detail}。已重试 ${context.retries}/${context.maxRetries} 次（共 ${context.retries + 1} 次请求）。${idleTimedOut ? '' : '仅凭此错误无法确定是供应商、网关还是本地网络导致。'}`,
  } as const
}
