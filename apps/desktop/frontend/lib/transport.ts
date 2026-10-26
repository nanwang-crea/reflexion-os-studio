import { isRemoteClient } from './environment'
import { invoke as tauriInvoke, type InvokeArgs } from '@tauri-apps/api/core'
import { listen as tauriListen } from '@tauri-apps/api/event'
import {
  RemoteRuntimeTransport,
  RuntimeTransport,
} from '@reflexion-os-studio/runtime-client'

let remote: RemoteRuntimeTransport | undefined
export function getRemoteTransport(): RemoteRuntimeTransport {
  return (remote ??= new RemoteRuntimeTransport(
    new URL('./', window.location.href).href,
  ))
}
export const transport = isRemoteClient
  ? getRemoteTransport()
  : new RuntimeTransport({
      invoke: <T>(command: string, args?: unknown) =>
        tauriInvoke<T>(command, args as InvokeArgs),
      listen: <T>(event: string, handler: (event: { payload: T }) => void) =>
        tauriListen<T>(event, handler),
    })
export const newRequestId = (): string => crypto.randomUUID()
