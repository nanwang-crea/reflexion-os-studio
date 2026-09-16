import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DangerLeaseService } from '../dist/agent/permissions/index.js'

function service(capability) {
  const events = []
  const notifier = (event) => events.push(event)
  const danger = new DangerLeaseService(notifier, () => capability)
  return { danger, events }
}

const unsupported = { supported: false, provider: null, detail: '无硬边界' }
const supported = { supported: true, provider: 'seatbelt', detail: null }

test('capability 不支持时 prepare fail-closed（danger_capability_unavailable）', () => {
  const { danger } = service(unsupported)
  assert.throws(
    () => danger.prepare('s1'),
    (error) => error.code === 'danger_capability_unavailable',
  )
})

test('两段式：prepare 签发 challenge，enable 消费一次并绑定 sessionId', () => {
  const { danger, events } = service(supported)
  const { challengeId, capability } = danger.prepare('s1')
  assert.equal(capability.provider, 'seatbelt')
  const { lease } = danger.enable(challengeId)
  assert.equal(lease.sessionId, 's1')
  assert.equal(lease.enforcement, 'credential-guard')
  assert.ok(lease.expiresAt > Date.now())
  assert.ok(danger.isActive('s1'))
  // challenge 单次消费：重复 enable 失败。
  assert.throws(
    () => danger.enable(challengeId),
    (error) => error.code === 'danger_challenge_invalid',
  )
  // 启用即广播 danger.changed。
  assert.ok(
    events.some(
      (e) => e.type === 'danger.changed' && e.lease?.sessionId === 's1',
    ),
  )
})

test('enable 用他会话 challenge 无效（跨会话消费）', () => {
  const { danger } = service(supported)
  const { challengeId } = danger.prepare('s1')
  // challenge 绑定 s1；用 s2 上下文无法伪造 provider，直接 enable 仍签发 s1 租约。
  const { lease } = danger.enable(challengeId)
  assert.equal(lease.sessionId, 's1')
  assert.equal(danger.isActive('s2'), false)
})

test('disable 撤销租约并广播 danger.changed（reason=user-disabled）', () => {
  const { danger, events } = service(supported)
  const { lease } = danger.enable(danger.prepare('s1').challengeId)
  assert.ok(lease)
  const result = danger.disable('s1')
  assert.equal(result.disabled, true)
  assert.equal(danger.isActive('s1'), false)
  assert.ok(
    events.some(
      (e) =>
        e.type === 'danger.changed' &&
        e.lease === null &&
        e.reason === 'user-disabled',
    ),
  )
  // 无租约时 disable 返回 false（幂等）。
  assert.equal(danger.disable('s1').disabled, false)
})

test('provider 降级即时撤销全部租约（fail-closed）', () => {
  const { danger, events } = service(supported)
  danger.enable(danger.prepare('s1').challengeId)
  danger.enable(danger.prepare('s2').challengeId)
  danger.onProviderDegraded()
  assert.equal(danger.isActive('s1'), false)
  assert.equal(danger.isActive('s2'), false)
  assert.equal(
    events.filter(
      (e) => e.type === 'danger.changed' && e.reason === 'provider-degraded',
    ).length,
    2,
  )
})

test('会话删除撤销租约并作废未消费 challenge', () => {
  const { danger } = service(supported)
  danger.enable(danger.prepare('s1').challengeId)
  const pending = danger.prepare('s1').challengeId
  danger.revoke('s1', 'session-deleted')
  assert.equal(danger.isActive('s1'), false)
  assert.throws(
    () => danger.enable(pending),
    (error) => error.code === 'danger_challenge_invalid',
  )
})
