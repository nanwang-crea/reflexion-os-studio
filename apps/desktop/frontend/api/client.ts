import { newRequestId, transport } from '../lib/transport'

/** 统一入口：自动注入 requestId，调用方不再手写。 */
export function request<T>(method: string, params?: object): Promise<T> {
  return transport.request<T>(method, {
    requestId: newRequestId(),
    ...params,
  } as Record<string, unknown>)
}

/** 列表类读请求：偶发事件丢失时自动重试一次，避免闪现超时错误。 */
export async function requestList<T>(
  method: string,
  params?: object,
): Promise<T> {
  try {
    return await request<T>(method, params)
  } catch (error) {
    if (error instanceof Error && error.message.includes('timeout')) {
      await new Promise((resolve) => setTimeout(resolve, 1500))
      return request<T>(method, params)
    }
    throw error
  }
}
