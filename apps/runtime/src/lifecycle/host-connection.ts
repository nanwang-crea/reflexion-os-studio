import type { Readable, Writable } from 'node:stream'
import type { JsonRpcMessage } from '@reflexion-os-studio/contracts'

/** Stdio belongs to the host; losing it must not leave a standalone Runtime. */
export function createHostConnection(
  streams: { input: Readable; output: Writable; diagnostics: Writable },
  onDisconnect: () => void,
): (message: JsonRpcMessage, onFlush?: () => void) => void {
  let connected = true
  const disconnect = (): void => {
    if (!connected) return
    connected = false
    onDisconnect()
  }
  streams.input.once('end', disconnect)
  streams.input.once('close', disconnect)
  streams.input.on('error', disconnect)
  streams.output.once('close', disconnect)
  streams.output.on('error', disconnect)
  // A dead host can close its log pipe while async cleanup is still logging.
  streams.diagnostics.on('error', disconnect)
  return (message, onFlush) => {
    if (!connected) {
      onFlush?.()
      return
    }
    try {
      streams.output.write(`${JSON.stringify(message)}\n`, onFlush)
    } catch {
      disconnect()
      onFlush?.()
    }
  }
}
