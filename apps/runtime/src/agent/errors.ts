/** 业务命令错误：handlers 捕获后转为带稳定 code 的 JSON-RPC error response。 */
export class CommandError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'CommandError'
    this.code = code
  }
}
