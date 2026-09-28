import type { DangerCapability, Session } from '@reflexion-os-studio/contracts'
import type { SkillRegistry } from '../skills/index.js'
import { resolveInvocation } from '../skills/index.js'
import type { Store } from '../store/index.js'
import type { SystemRuntimeClient } from '../system.js'
import { CommandError } from './errors.js'

/** 平台 Danger capability 探测；没有真机验证的 provider 一律 fail-closed。 */
export function dangerCapability(
  system: SystemRuntimeClient | null,
): DangerCapability {
  const provider = system?.sandboxName ?? null
  if (provider === 'seatbelt') {
    return {
      supported: true,
      provider: 'seatbelt',
      detail:
        'macOS Seatbelt danger profile：非敏感系统读写放开、敏感路径读写 deny 保留（真机已验证）',
    }
  }
  if (provider === 'bwrap') {
    return {
      supported: false,
      provider: null,
      detail:
        'Linux bwrap danger 档已实现并经单测钉住，待 Linux 真机验收后启用（当前构建不可启用）',
    }
  }
  const suffix = provider ? `（当前沙箱 provider：${provider}）` : ''
  return {
    supported: false,
    provider: null,
    detail:
      '当前平台缺少可验证的 credential-guard 危险档边界，拒绝启用' + suffix,
  }
}

export function requireSession(store: Store, sessionId: string): Session {
  const session = store.sessions.get(sessionId)
  if (!session) {
    throw new CommandError('invalid_request', `session not found: ${sessionId}`)
  }
  return session
}

export function requireIdleSession(store: Store, sessionId: string): void {
  if (store.runs.activeForSession(sessionId)) {
    throw new CommandError(
      'invalid_request',
      '该会话有正在进行的回复，请等待完成或先停止',
    )
  }
}

export function resolveSkillInvocation(
  content: string,
  explicitSkillId: string | undefined,
  skills: SkillRegistry,
  projectId: string | null = null,
): ReturnType<typeof resolveInvocation> {
  try {
    return resolveInvocation(content, explicitSkillId, skills, projectId)
  } catch (error) {
    throw new CommandError(
      'invalid_request',
      error instanceof Error ? error.message : String(error),
    )
  }
}
