import {
  lookupCommandSchema,
  summarizeZodIssuesForLog,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from '@reflexion-os-studio/contracts'
import { CommandError } from '../../agent/errors.js'

export type RequestPrincipal =
  | { kind: 'desktop' }
  | { kind: 'device'; deviceId: string; accessScope: 'all_sessions' }
export interface RequestGatewayOptions {
  dispatch: (
    method: string,
    params: Record<string, unknown>,
  ) => Promise<unknown>
  authorize: (
    principal: RequestPrincipal,
    method: string,
    params: Record<string, unknown>,
  ) => void
  report: (message: string) => void
}

/** Every transport passes the same schema and business error boundary. */
export class RuntimeRequestGateway {
  constructor(private readonly options: RequestGatewayOptions) {}
  async execute(
    request: JsonRpcRequest,
    principal: RequestPrincipal,
  ): Promise<JsonRpcResponse> {
    const error = (
      code: number,
      message: string,
      data?: unknown,
    ): JsonRpcResponse => ({
      jsonrpc: '2.0',
      id: request.id,
      error: { code, message, ...(data === undefined ? {} : { data }) },
    })
    const entry = lookupCommandSchema(request.method)
    if (!entry) return error(-32601, `Method not found: ${request.method}`)
    const params = entry.params.safeParse(request.params ?? {})
    if (!params.success) {
      const reasons = summarizeZodIssuesForLog(params.error.issues)
      this.options.report(
        `${request.method} rejected (-32602 invalid_params): ${reasons.join('; ')}`,
      )
      return error(-32602, 'Invalid params', reasons)
    }
    try {
      const input = params.data as Record<string, unknown>
      this.options.authorize(principal, request.method, input)
      let dispatchInput = input
      const prefix =
        principal.kind === 'device' ? `device:${principal.deviceId}:` : ''
      if (principal.kind === 'device') {
        if (typeof input.requestId !== 'string' || input.requestId.length > 256)
          throw new CommandError('invalid_request', 'invalid requestId')
        dispatchInput = { ...input, requestId: prefix + input.requestId }
        if (request.method === 'operation.get')
          dispatchInput.targetRequestId = prefix + input.targetRequestId
      }
      let result = await this.options.dispatch(request.method, dispatchInput)
      if (
        principal.kind === 'device' &&
        request.method === 'operation.get' &&
        result &&
        typeof result === 'object' &&
        'operation' in result &&
        result.operation
      ) {
        result = {
          operation: {
            ...(result.operation as object),
            requestId: input.targetRequestId,
          },
        }
      }
      return { jsonrpc: '2.0', id: request.id, result }
    } catch (cause) {
      if (cause instanceof CommandError) {
        // Remote errors never include internal paths, provider failures or parameters.
        const message =
          principal.kind === 'device'
            ? '请求被拒绝或执行失败，请在电脑查看详情'
            : cause.message
        this.options.report(`${request.method} failed (${cause.code})`)
        return error(-32000, message, { code: cause.code, message })
      }
      this.options.report(`${request.method} internal error`)
      return error(-32000, 'internal error', {
        code: 'internal',
        message:
          principal.kind === 'desktop' && cause instanceof Error
            ? cause.message
            : 'internal error',
      })
    }
  }
}
