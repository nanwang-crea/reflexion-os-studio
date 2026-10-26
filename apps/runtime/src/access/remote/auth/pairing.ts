import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto'
import type { RemoteDevice } from '@reflexion-os-studio/contracts'
import { CommandError } from '../../../agent/errors.js'
const digest = (value: string): string =>
  createHash('sha256').update(value).digest('hex')
const deny = (): never => {
  throw new CommandError('forbidden', '设备未授权或配对已失效')
}
interface Entry {
  device: RemoteDevice
  credentialHash: string
}

/** Credentials are generated here, stay in memory, and are never in device DTOs. */
export class RemotePairing {
  private invitation?: { hash: string; expires: number }
  private readonly entries = new Map<string, Entry>()
  constructor(private readonly now: () => number = Date.now) {}
  invite(): { invitation: string; expiresAt: string } {
    const invitation = randomBytes(32).toString('base64url')
    const expires = this.now() + 120_000
    this.invitation = { hash: digest(invitation), expires }
    return { invitation, expiresAt: new Date(expires).toISOString() }
  }
  pair(
    invitation: string,
    name: string,
  ): { device: RemoteDevice; credential: string } {
    this.prune()
    if (
      !this.invitation ||
      this.invitation.expires <= this.now() ||
      this.invitation.hash !== digest(invitation)
    )
      return deny()
    if (this.entries.size >= 8)
      throw new CommandError('limit', '最多连接 8 台设备')
    this.invitation = undefined
    const credential = randomBytes(32).toString('base64url')
    const device: RemoteDevice = {
      id: randomUUID(),
      name,
      verificationCode: String(randomInt(100000, 1000000)),
      approved: false,
      expiresAt: new Date(this.now() + 120_000).toISOString(),
    }
    this.entries.set(device.id, { device, credentialHash: digest(credential) })
    return { device: { ...device }, credential }
  }
  authenticate(credential: string, approved = true): RemoteDevice {
    this.prune()
    const hash = digest(credential)
    const entry = [...this.entries.values()].find(
      (item) => item.credentialHash === hash,
    )
    if (!entry || (approved && !entry.device.approved)) return deny()
    return { ...entry.device }
  }
  resolve(id: string, approved: boolean): boolean {
    this.prune()
    const entry = this.entries.get(id)
    if (!entry || entry.device.approved) return false
    if (!approved) this.entries.delete(id)
    else {
      entry.device.approved = true
      entry.device.expiresAt = new Date(this.now() + 8 * 3600_000).toISOString()
    }
    return true
  }
  revoke(id: string): boolean {
    return this.entries.delete(id)
  }
  list(): RemoteDevice[] {
    this.prune()
    return [...this.entries.values()].map(({ device }) => ({ ...device }))
  }
  clear(): void {
    this.entries.clear()
    this.invitation = undefined
  }
  private prune(): void {
    for (const [id, entry] of this.entries)
      if (Date.parse(entry.device.expiresAt) <= this.now())
        this.entries.delete(id)
  }
}
