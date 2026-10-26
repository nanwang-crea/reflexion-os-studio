import type { RemoteStatus } from '@reflexion-os-studio/contracts'
import { request } from './client'
export const getRemoteStatus = (): Promise<RemoteStatus> =>
  request('remote.status')
export const startRemote = (
  sessionId: string,
  address: string,
): Promise<RemoteStatus> =>
  request('remote.start', { sessionId, address }, 60_000)
export const inviteRemote = (): Promise<RemoteStatus> =>
  request('remote.invite')
export const stopRemote = (): Promise<{ ok: boolean }> => request('remote.stop')
export const resolveRemoteDevice = (
  deviceId: string,
  approved: boolean,
): Promise<{ accepted: boolean }> =>
  request('remote.device.resolve', { deviceId, approved })
export const revokeRemoteDevice = (
  deviceId: string,
): Promise<{ removed: boolean }> =>
  request('remote.device.revoke', { deviceId })
