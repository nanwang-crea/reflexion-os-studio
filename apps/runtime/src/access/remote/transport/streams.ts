import { remoteEvent } from '../state/projection.js'
import type { ServerResponse } from 'node:http'
import type { RemoteStreamPacket } from '@reflexion-os-studio/contracts'
import type { RuntimeEventBus } from '../../events.js'
import type { RemoteAccessPolicy } from '../auth/policy.js'
import type { RemotePairing } from '../auth/pairing.js'

export class RemoteStreams {
  private readonly connections = new Map<
    ServerResponse,
    { deviceId: string; close: () => void }
  >()
  constructor(
    private readonly bus: RuntimeEventBus,
    private readonly policy: RemoteAccessPolicy,
    private readonly pairing: RemotePairing,
  ) {}
  open(
    response: ServerResponse,
    credential: string,
    sessionId: string,
    snapshot: () => RemoteStreamPacket,
  ): void {
    const device = this.pairing.authenticate(credential)
    const forDevice = [...this.connections.values()].filter(
      (connection) => connection.deviceId === device.id,
    ).length
    if (forDevice >= 2 || this.connections.size >= 16) {
      response.writeHead(429)
      response.end()
      return
    }
    let closed = false
    const close = (): void => {
      if (closed) return
      closed = true
      unsubscribe()
      clearInterval(heartbeat)
      this.connections.delete(response)
      response.end()
    }
    const send = (packet: RemoteStreamPacket): void => {
      if (closed) return
      // The stream is ordered; a client that cannot keep up reconnects for a snapshot.
      response.write(
        `data: ${JSON.stringify(packet.type === 'event' ? { ...packet, event: remoteEvent(packet.event) } : packet)}\n\n`,
      )
      if (response.writableLength > 16 * 1024 * 1024) {
        close()
        response.destroy()
      }
    }
    const valid = (): boolean => {
      try {
        this.pairing.authenticate(credential)
        return true
      } catch {
        close()
        return false
      }
    }
    const unsubscribe = this.bus.subscribe((event) => {
      if (!valid()) return
      if (event.type === 'operation.changed') {
        const prefix = `device:${device.id}:`
        if (event.operation.requestId.startsWith(prefix))
          send({
            type: 'event',
            event: {
              ...event,
              operation: {
                ...event.operation,
                requestId: event.operation.requestId.slice(prefix.length),
              },
            },
          })
      } else if (this.policy.eventBelongs(event, sessionId))
        send({ type: 'event', event })
    })
    const heartbeat = setInterval(() => {
      if (valid()) response.write(': heartbeat\n\n')
    }, 15_000)
    heartbeat.unref()
    const expires = setTimeout(
      close,
      Math.max(1, Date.parse(device.expiresAt) - Date.now()),
    )
    expires.unref()
    response.once('close', () => {
      clearTimeout(expires)
      close()
    })
    response.once('error', close)
    this.connections.set(response, { deviceId: device.id, close })
    response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'X-Accel-Buffering': 'no',
    })
    // No await between canonical snapshot and subscription: JS event order is the boundary.
    try {
      send(snapshot())
    } catch {
      close()
    }
  }
  closeDevice(id: string): void {
    for (const connection of this.connections.values())
      if (connection.deviceId === id) connection.close()
  }
  close(): void {
    for (const connection of this.connections.values()) connection.close()
  }
}
