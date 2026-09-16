import { randomUUID } from 'node:crypto'
import { CommandError } from '../errors.js'
import { EmitterRegistry, type EventNotifier } from '../../events.js'
import type {
  DangerAccessLease,
  DangerCapability,
  DangerProvider,
  DangerRevokeReason,
} from '@reflexion-os-studio/contracts'

/**
 * Danger 高级能力：两段式确认的会话租约（§6.4）。
 * challenge ≤60s、单次消费、绑定 sessionId；lease ≤30min、内存态。
 * 平台 capability 由注入的 provider 给出（macOS Seatbelt / Linux bwrap /
 * Windows guard；无硬边界时 supported=false，enable 必须 fail-closed）。
 */

const CHALLENGE_TTL_MS = 60_000
export const DANGER_LEASE_TTL_MS = 30 * 60 * 1000

export const DANGER_WARNING =
  '启用后 30 分钟内：工作区内外文件与 Shell 操作不再逐次审批、Shell 网络不再单独审批。' +
  '机密文件（私钥/.env/凭据等）仍被禁止读取，日志脱敏与进程树回收仍生效；' +
  '到期、会话删除、Runtime 重启或手动关闭即刻失效。'

interface DangerChallenge {
  sessionId: string
  expiresAt: number
  capability: DangerCapability
}

export interface DangerPrepareResult {
  challengeId: string
  expiresAt: number
  warning: string
  capability: DangerCapability
}

export class DangerLeaseService {
  private readonly challenges = new Map<string, DangerChallenge>()
  private readonly leases = new Map<string, DangerAccessLease>()
  private readonly timers = new Map<string, NodeJS.Timeout>()
  private readonly emitters: EmitterRegistry

  constructor(
    notifier: EventNotifier,
    /** 平台 capability 探测：由宿主侧 sandbox provider 状态提供（W4/W5 接线）。 */
    private readonly capabilityProvider: () => DangerCapability,
  ) {
    this.emitters = new EmitterRegistry(notifier)
  }

  prepare(sessionId: string): DangerPrepareResult {
    this.expireStaleChallenges()
    const capability = this.capabilityProvider()
    if (!capability.supported) {
      throw new CommandError(
        'danger_capability_unavailable',
        capability.detail ??
          '当前平台缺少可验证的 Danger 硬边界（credential guard），拒绝启用',
      )
    }
    const challengeId = randomUUID()
    const expiresAt = Date.now() + CHALLENGE_TTL_MS
    this.challenges.set(challengeId, { sessionId, expiresAt, capability })
    return { challengeId, expiresAt, warning: DANGER_WARNING, capability }
  }

  enable(challengeId: string): { lease: DangerAccessLease } {
    const challenge = this.challenges.get(challengeId)
    // challenge 单次消费：无论成败先摘除。
    if (challenge) this.challenges.delete(challengeId)
    if (
      !challenge ||
      challenge.expiresAt <= Date.now() ||
      !challenge.capability.supported ||
      challenge.capability.provider === null
    ) {
      throw new CommandError(
        'danger_challenge_invalid',
        'Danger challenge 无效、已过期或已消费，请重新确认',
      )
    }
    const now = Date.now()
    const lease: DangerAccessLease = {
      sessionId: challenge.sessionId,
      issuedAt: now,
      expiresAt: now + DANGER_LEASE_TTL_MS,
      enforcement: 'credential-guard',
      provider: challenge.capability.provider as DangerProvider,
    }
    this.leases.set(lease.sessionId, lease)
    this.armExpiry(lease)
    this.notify(lease.sessionId, lease, null)
    return { lease }
  }

  disable(sessionId: string): { disabled: boolean } {
    const had = this.revoke(sessionId, 'user-disabled')
    return { disabled: had }
  }

  leaseFor(sessionId: string): DangerAccessLease | null {
    const lease = this.leases.get(sessionId)
    if (!lease) return null
    if (lease.expiresAt <= Date.now()) {
      this.revoke(sessionId, 'expired')
      return null
    }
    return lease
  }

  isActive(sessionId: string): boolean {
    return this.leaseFor(sessionId) !== null
  }

  /** 会话删除 / provider 降级 / guard 自检失败：立即撤销并通知 UI。 */
  revoke(sessionId: string, reason: DangerRevokeReason): boolean {
    const lease = this.leases.get(sessionId)
    this.challengesDeleteSession(sessionId)
    if (!lease) return false
    this.leases.delete(sessionId)
    const timer = this.timers.get(sessionId)
    if (timer) clearTimeout(timer)
    this.timers.delete(sessionId)
    this.notify(sessionId, null, reason)
    return true
  }

  /** provider 降级钩子：租约必须随之撤销（fail-closed，不静默维持）。 */
  onProviderDegraded(): void {
    for (const sessionId of [...this.leases.keys()]) {
      this.revoke(sessionId, 'provider-degraded')
    }
  }

  /** Runtime 关停时清定时器（有界资源纪律）。 */
  dispose(): void {
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
  }

  private armExpiry(lease: DangerAccessLease): void {
    const existing = this.timers.get(lease.sessionId)
    if (existing) clearTimeout(existing)
    const timer = setTimeout(
      () => {
        const current = this.leases.get(lease.sessionId)
        if (current && current.expiresAt <= Date.now()) {
          this.revoke(lease.sessionId, 'expired')
        }
      },
      Math.max(0, lease.expiresAt - Date.now()),
    )
    // 到期定时器只做清理，不延长进程生命周期（sidecar 退出时租约本就消亡）。
    timer.unref()
    this.timers.set(lease.sessionId, timer)
  }

  private challengesDeleteSession(sessionId: string): void {
    for (const [id, challenge] of this.challenges) {
      if (challenge.sessionId === sessionId) this.challenges.delete(id)
    }
  }

  private expireStaleChallenges(): void {
    const now = Date.now()
    for (const [id, challenge] of this.challenges) {
      if (challenge.expiresAt <= now) this.challenges.delete(id)
    }
  }

  private notify(
    sessionId: string,
    lease: DangerAccessLease | null,
    reason: DangerRevokeReason | null,
  ): void {
    this.emitters
      .for({ scope: 'session', sessionId })
      .next({ type: 'danger.changed', sessionId, lease, reason })
  }
}
