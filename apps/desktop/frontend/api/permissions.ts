import type {
  ApprovalOverride,
  DangerAccessLease,
  DangerCapability,
} from '@reflexion-os-studio/runtime-client'
import { request } from './client'

/** 高级审批覆盖项（仅当前会话内存生效，不持久化）。 */
export function setApprovalOverride(
  sessionId: string,
  override: ApprovalOverride,
): Promise<{ override: ApprovalOverride }> {
  return request('permission.approval_override.set', { sessionId, override })
}

export function getApprovalOverride(
  sessionId: string,
): Promise<{ override: ApprovalOverride }> {
  return request('permission.approval_override.get', { sessionId })
}

// ---------- Danger 高级能力（两段式确认；Runtime 是租约唯一真源） ----------

export interface DangerPrepareResult {
  challengeId: string
  expiresAt: number
  warning: string
  capability: DangerCapability
}

export function dangerPrepare(sessionId: string): Promise<DangerPrepareResult> {
  return request('danger.prepare', { sessionId })
}

export function dangerEnable(challengeId: string): Promise<{
  lease: DangerAccessLease
}> {
  return request('danger.enable', {
    challengeId,
    // 明确确认标志：必须显式 true，前端不默认填充。
    acceptedRisk: true,
  })
}

export function dangerDisable(
  sessionId: string,
): Promise<{ disabled: boolean }> {
  return request('danger.disable', { sessionId })
}

export function dangerStatus(sessionId: string): Promise<{
  lease: DangerAccessLease | null
}> {
  return request('danger.status', { sessionId })
}
