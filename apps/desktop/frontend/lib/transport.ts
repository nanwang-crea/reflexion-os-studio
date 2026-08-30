import { invoke as tauriInvoke, type InvokeArgs } from '@tauri-apps/api/core'
import { listen as tauriListen } from '@tauri-apps/api/event'
import { RuntimeTransport } from '@reflexion-os-studio/runtime-client'

export const transport = new RuntimeTransport({
  invoke: <T>(command: string, args?: unknown) =>
    tauriInvoke<T>(command, args as InvokeArgs),
  listen: <T>(event: string, handler: (event: { payload: T }) => void) =>
    tauriListen<T>(event, handler),
})

export const newRequestId = (): string => crypto.randomUUID()
