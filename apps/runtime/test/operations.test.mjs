import assert from 'node:assert/strict'
import { test } from 'node:test'
import { OperationRegistry } from '../dist/operations/registry.js'
import { withGitQueue } from '../dist/workspace/git-queue.js'

const tick = () => new Promise((resolve) => setImmediate(resolve))
test('duplicate concurrent and completed requests execute once; changed payload is rejected', async () => {
  const events = []
  const registry = new OperationRegistry((event) => events.push(event))
  let finish
  let writes = 0
  const gate = new Promise((resolve) => {
    finish = resolve
  })
  const params = { requestId: 'one', projectId: 'project', paths: ['file.txt'] }
  const task = async () => {
    writes++
    await gate
    return { ok: true }
  }
  const first = registry.execute('workspace.git_stage', params, () =>
    withGitQueue('repo', task),
  )
  const duplicate = registry.execute(
    'workspace.git_stage',
    { paths: ['file.txt'], projectId: 'project', requestId: 'one' },
    task,
  )
  assert.equal(first, duplicate)
  await tick()
  assert.equal(writes, 1)
  finish()
  await first
  assert.deepEqual(
    await registry.execute('workspace.git_stage', params, task),
    { ok: true },
  )
  assert.equal(writes, 1)
  await assert.rejects(
    registry.execute(
      'workspace.git_stage',
      { ...params, paths: ['other.txt'] },
      task,
    ),
    /不同操作内容/,
  )
  assert.deepEqual(
    events.map((e) => e.phase),
    ['queued', 'running', 'succeeded'],
  )
})
test('workspace queue accurately reports waiting and execution without blocking read checks', async () => {
  const registry = new OperationRegistry()
  let finish
  const gate = new Promise((resolve) => {
    finish = resolve
  })
  const first = registry.execute(
    'workspace.git_stage',
    { requestId: 'one' },
    () =>
      withGitQueue('repo', async () => {
        await gate
        return { ok: true }
      }),
  )
  await tick()
  const second = registry.execute(
    'workspace.git_commit',
    { requestId: 'two' },
    () => withGitQueue('repo', async () => ({ ok: true })),
  )
  await tick()
  assert.equal(registry.get('workspace.git_stage', 'one').phase, 'running')
  assert.equal(registry.get('workspace.git_commit', 'two').phase, 'queued')
  finish()
  await Promise.all([first, second])
  assert.equal(registry.get('workspace.git_commit', 'two').phase, 'succeeded')
})
test('timeout is uncertain, preserved and never automatically replayed', async () => {
  const registry = new OperationRegistry()
  let calls = 0
  const task = async () => {
    calls++
    throw new Error('system request timeout: git.commit')
  }
  const params = { requestId: 'timeout' }
  await assert.rejects(
    registry.execute('workspace.git_commit', params, task),
    /timeout/,
  )
  await assert.rejects(
    registry.execute('workspace.git_commit', params, task),
    /timeout/,
  )
  assert.equal(calls, 1)
  assert.equal(
    registry.get('workspace.git_commit', 'timeout').phase,
    'uncertain',
  )
  assert.equal(
    new OperationRegistry().get('workspace.git_commit', 'timeout'),
    null,
  )
})
test('receipts and lifecycle events never include mutation inputs', async () => {
  const events = []
  const registry = new OperationRegistry((event) => events.push(event))
  await registry.execute(
    'provider.configure',
    { requestId: 'provider', secret: 'synthetic-acceptance-placeholder' },
    async () => ({ profile: { id: 'id' } }),
  )
  assert.ok(
    !JSON.stringify(events).includes('synthetic-acceptance-placeholder'),
  )
  assert.deepEqual(
    Object.keys(registry.get('provider.configure', 'provider')).sort(),
    ['error', 'method', 'phase', 'requestId'],
  )
})
