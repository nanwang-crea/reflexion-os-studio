import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DelegationBudgetCoordinator } from '../dist/agent/delegation/budget.js'

const settings = {
  maxChildRuns: 2,
  maxParallelChildren: 8,
  unlimitedLimits: [],
}

test('finished children release quantity slots across repeated batches', () => {
  const budget = new DelegationBudgetCoordinator('root', settings)
  for (let batch = 0; batch < 10; batch++) {
    const first = budget.acquire()
    const second = budget.acquire()
    assert.throws(
      () => budget.acquire(),
      (error) => error.code === 'child_limit_runs',
    )
    first.release()
    first.release()
    const replacement = budget.acquire()
    assert.throws(() => budget.acquire(), /未结束/)
    second.release()
    replacement.release()
  }
})

test('setup rollback releases both limits exactly once', () => {
  const budget = new DelegationBudgetCoordinator('root', {
    ...settings,
    maxChildRuns: 1,
    maxParallelChildren: 1,
  })
  const lease = budget.acquire()
  lease.rollback()
  lease.release()
  lease.rollback()
  const next = budget.acquire()
  assert.throws(() => budget.acquire())
  next.release()
})

test('restored terminal history occupies neither quantity nor parallel slots', () => {
  const budget = new DelegationBudgetCoordinator(
    'root',
    { ...settings, maxParallelChildren: 1 },
    ['completed', 'cancelled', 'failed'].flatMap((status) =>
      Array.from({ length: 10 }, () => ({ status })),
    ),
  )
  const lease = budget.acquire()
  assert.throws(
    () => budget.acquire(),
    (error) => error.code === 'child_limit_parallel',
  )
  lease.release()
  budget.acquire().release()
})

test('restored pending and running children still occupy slots', () => {
  const existing = [
    { status: 'pending' },
    { status: 'running' },
    { status: 'completed' },
  ]
  assert.throws(
    () => new DelegationBudgetCoordinator('root', settings, existing).acquire(),
    /未结束/,
  )
  assert.throws(
    () =>
      new DelegationBudgetCoordinator(
        'root',
        { ...settings, maxChildRuns: 8, maxParallelChildren: 2 },
        existing,
      ).acquire(),
    /并发/,
  )
})

for (const status of ['completed', 'failed', 'cancelled']) {
  test(`${status} child releases its slot for the next task and after recovery`, async (t) => {
    const { Store } = await import('../dist/store/index.js')
    const { createChildRunStarter } =
      await import('../dist/agent/delegation/starter.js')
    const { mkdtempSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dir = mkdtempSync(join(tmpdir(), 'delegation-budget-'))
    const store = new Store(dir)
    t.after(() => {
      store.close()
      rmSync(dir, { recursive: true, force: true })
    })
    store.agentSettings.upsert({
      ...store.agentSettings.get(),
      maxChildRuns: 1,
      maxParallelChildren: 1,
    })
    const session = store.sessions.create(null)
    const parent = store.runs.create({
      sessionId: session.id,
      providerId: 'provider',
      model: 'model',
    })
    const deps = {
      store,
      notifier: () => {},
      profile: { id: 'provider', models: ['model'] },
      apiKey: 'unused',
      model: 'model',
      sampling: {},
      launcher: {
        depthOf: () => 0,
        launch: (input) => {
          if (status === 'completed') input.onResult('done')
          else if (status === 'failed')
            input.onFailure(new Error('synthetic failure'))
          else input.onCancel()
        },
      },
    }
    const starter = createChildRunStarter(deps, parent, session)
    const invoke = async (start) => {
      const result = start({
        task: 'work',
        signal: new AbortController().signal,
      })
      if (status === 'completed') await result
      else await assert.rejects(result)
    }
    for (let i = 0; i < 4; i++) await invoke(starter)
    const restored = createChildRunStarter(deps, parent, session)
    await invoke(restored)
    const history = store.delegations.listByRootRun(parent.id)
    assert.equal(history.length, 5)
    assert.ok(history.every((item) => item.status === status))
  })
}
