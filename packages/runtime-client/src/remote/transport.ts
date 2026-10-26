import {
  JsonRpcResponseSchema,
  RemotePairStateSchema,
  RemoteStreamPacketSchema,
  lookupCommandSchema,
  type RemoteStreamPacket,
  type RuntimeEvent,
} from '@reflexion-os-studio/contracts'
import { TransportError } from '../transport.js'

/** Same typed facade for a browser client. Cookies stay HttpOnly on the server. */
export class RemoteRuntimeTransport {
  private readonly handlers = new Set<(event: RuntimeEvent) => void>()
  constructor(private readonly baseUrl: string) {}
  async attach(): Promise<void> {}
  onEvent(handler: (event: RuntimeEvent) => void): () => void {
    this.handlers.add(handler)
    return () => {
      this.handlers.delete(handler)
    }
  }
  async pair(invitation: string, name: string) {
    return RemotePairStateSchema.parse(
      await this.json('api/pair', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ invitation, name }),
      }),
    )
  }
  async pairState() {
    return RemotePairStateSchema.parse(await this.json('api/pair'))
  }
  stream(
    sessionId: string,
    onPacket: (packet: RemoteStreamPacket) => void,
    onState: (state: 'connected' | 'reconnecting' | 'closed') => void,
  ): () => void {
    const streamUrl = new URL('api/events', this.baseUrl)
    streamUrl.searchParams.set('sessionId', sessionId)
    const events = new EventSource(streamUrl, {
      withCredentials: true,
    })
    events.onmessage = (message) => {
      try {
        const packet = RemoteStreamPacketSchema.parse(JSON.parse(message.data))
        onPacket(packet)
        if (packet.type === 'event')
          for (const handler of this.handlers) handler(packet.event)
        onState('connected')
      } catch {
        events.close()
        onState('closed')
      }
    }
    events.onerror = () =>
      onState(
        events.readyState === EventSource.CLOSED ? 'closed' : 'reconnecting',
      )
    return () => events.close()
  }
  async request<R>(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = 30_000,
  ): Promise<R> {
    try {
      const response = JsonRpcResponseSchema.parse(
        await this.json('api/rpc', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: crypto.randomUUID(),
            method,
            params,
          }),
          signal: AbortSignal.timeout(timeoutMs),
        }),
      )
      if (response.error)
        throw new TransportError(response.error.message, response.error)
      const schema = lookupCommandSchema(method)?.result
      const parsed = schema?.safeParse(response.result)
      if (parsed && !parsed.success)
        throw new TransportError(
          `runtime response validation failed for ${method}`,
        )
      return (parsed?.success ? parsed.data : response.result) as R
    } catch (error) {
      if (error instanceof TransportError) throw error
      throw new TransportError(
        '连接中断，操作结果可能尚未确认；请恢复连接后核对，勿重复发送',
      )
    }
  }
  private async json(path: string, init?: RequestInit): Promise<unknown> {
    const response = await fetch(new URL(path, this.baseUrl), {
      credentials: 'same-origin',
      cache: 'no-store',
      ...init,
    })
    if (!response.ok)
      throw new Error(
        response.status === 403
          ? '设备未批准、已撤销或配对已过期，请在电脑重新配对'
          : '连接失败，请检查电脑和网络',
      )
    return response.json()
  }
}
