/** 业务命令错误：handlers 捕获后转为带稳定 code 的 JSON-RPC error response。 */
export class CommandError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'CommandError'
    this.code = code
  }
}

/**
 * 子 Run 安全边界触发：超时 / token 预算 / 委派限制。
 * 以 AbortController 的 reason 形式传播，runner 据此区分"父取消(cancelled)"
 * 与"子限额(failed+稳定错误码)"，避免把超时/预算误标为取消。
 */
export class ChildLimitError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'ChildLimitError'
    this.code = code
  }
}
