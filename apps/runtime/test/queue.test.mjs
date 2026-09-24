import assert from 'node:assert/strict'
import { test } from 'node:test'
import { QueueService } from '../dist/agent/session/queue.js'

function freshQueue() {
  const events = []
  const service = new QueueService((event) => events.push(event))
  return { service, events }
}

function params(content) {
  return { content, permissionMode: 'workspace', skillId: undefined }
}

test('queue FIFO: enqueue positions, dequeue order, notify snapshots', () => {
  const { service, events } = freshQueue()
  const a = service.enqueue('s1', params('第一条'))
  const b = service.enqueue('s1', params('第二条'))
  const listed = service.list('s1')
  assert.deepEqual(
    listed.map((entry) => entry.content),
    ['第一条', '第二条'],
  )
  assert.equal(listed[0].position, 0)
  assert.equal(listed[1].position, 1)

  assert.equal(service.dequeue('s1')?.id, a.id)
  assert.equal(service.dequeue('s1')?.id, b.id)
  assert.equal(service.dequeue('s1'), null)
  // 最终快照为空。
  const last = events[events.length - 1]
  assert.equal(last.type, 'queue.changed')
  assert.equal(last.items.length, 0)
})

test('queue update replaces content and revalidates via params', () => {
  const { service } = freshQueue()
  const entry = service.enqueue('s1', params('原内容'))
  const updated = service.update('s1', entry.id, {
    ...entry.params,
    content: '新内容',
    skillId: 'code-review',
  })
  assert.equal(updated?.params.content, '新内容')
  assert.equal(service.list('s1')[0].skillId, 'code-review')
  assert.equal(service.update('s1', 'missing-id', { content: 'x' }), null)
})

test('queue remove and moveToFront', () => {
  const { service, events } = freshQueue()
  const a = service.enqueue('s1', params('a'))
  service.enqueue('s1', params('b'))
  const c = service.enqueue('s1', params('c'))

  assert.equal(service.moveToFront('s1', c.id), true)
  assert.deepEqual(
    service.list('s1').map((entry) => entry.content),
    ['c', 'a', 'b'],
  )
  assert.equal(service.moveToFront('s1', c.id), true) // 已在队首

  assert.equal(service.remove('s1', a.id), true)
  assert.equal(service.remove('s1', a.id), false)
  assert.equal(
    service
      .list('s1')
      .map((entry) => entry.content)
      .join(','),
    'c,b',
  )
  assert.ok(events.some((event) => event.type === 'queue.changed'))
})

test('queue removeSession drops entire session queue on delete', () => {
  const { service } = freshQueue()
  service.enqueue('s1', params('a'))
  service.enqueue('s1', params('b'))
  service.enqueue('s2', params('其他会话'))
  service.removeSession('s1')
  assert.equal(service.list('s1').length, 0)
  assert.equal(service.list('s2').length, 1)
})

test('queue update keeps explicit skillId and re-resolves slash skill', async () => {
  // 该场景由 ChatAgent.updateQueue 负责斜杠解析;此处验证 params 透传语义。
  const { service } = freshQueue()
  const entry = service.enqueue('s1', {
    content: '/code-review 看看',
    skillId: undefined,
  })
  const updated = service.update('s1', entry.id, {
    ...entry.params,
    content: '/web-research 查一下',
    skillId: 'web-research',
  })
  assert.equal(updated?.params.skillId, 'web-research')
  assert.equal(service.list('s1')[0].skillId, 'web-research')
})

test('queue entry snapshots permission preset (resolved at enqueue)', () => {
  const { service } = freshQueue()
  // 未传档位 → 保守回落 workspace-read（UI badge 与执行档位一致）。
  const plain = service.enqueue('s1', params('普通消息'))
  assert.equal(
    service.list('s1').find((e) => e.id === plain.id).permissionPreset,
    'workspace-read',
  )
  // 显式档位 → 快照可见（QueueBar 档位徽标依据）。
  const full = service.enqueue('s1', {
    ...params('完全允许消息'),
    permissionPreset: 'workspace-full',
  })
  assert.equal(
    service.list('s1').find((e) => e.id === full.id).permissionPreset,
    'workspace-full',
  )
  // legacy trusted=true → workspace-full（一版本兼容映射在入队时固化）。
  const legacy = service.enqueue('s1', {
    ...params('旧客户端消息'),
    trusted: true,
  })
  assert.equal(
    service.list('s1').find((e) => e.id === legacy.id).permissionPreset,
    'workspace-full',
  )
})

test('queue.changed 事件 seq 在会话流内单调递增，跨会话独立', () => {
  const events = []
  const service = new QueueService((event) => events.push(event))
  service.enqueue('s1', { content: 'a' })
  service.enqueue('s1', { content: 'b' })
  service.enqueue('s2', { content: 'c' })
  const s1 = events.filter(
    (e) => e.type === 'queue.changed' && e.sessionId === 's1',
  )
  assert.equal(s1.length, 2)
  assert.equal(s1[0].scope, 'session')
  assert.equal(s1[0].seq, 0)
  assert.equal(s1[1].seq, 1)
  const s2 = events.filter(
    (e) => e.type === 'queue.changed' && e.sessionId === 's2',
  )
  assert.equal(s2[0].seq, 0)
})
