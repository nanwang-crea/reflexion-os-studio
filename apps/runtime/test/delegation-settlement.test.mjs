import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../dist/store/index.js'
import { createChildRunStarter } from '../dist/agent/delegation/starter.js'
import { RunLauncher } from '../dist/agent/launcher.js'
import { ApprovalGateway } from '../dist/agent/permissions/index.js'

function fixture(t, notifier = () => {}) {
  const dir = mkdtempSync(join(tmpdir(), 'delegation-settlement-'))
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
    providerId: 'p',
    model: 'm',
  })
  const launcher = { depthOf: () => 0, launch: () => {} }
  const deps = {
    store,
    notifier,
    launcher,
    profile: { id: 'p', models: ['m'] },
    apiKey: 'unused',
    model: 'm',
    sampling: {},
  }
  const starter = createChildRunStarter(deps, parent, session)
  return { store, session, parent, launcher, deps, starter }
}

async function bounded(promise) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('delegation hung')), 1000)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

for (const outcome of ['completed', 'failed', 'cancelled']) {
  test(`${outcome}: notifier failure cannot strand the parent or leak budget`, async (t) => {
    const f = fixture(t, () => {
      throw new Error('notifier unavailable')
    })
    const failure = new Error('child failed')
    f.launcher.launch = (input) =>
      queueMicrotask(() => {
        if (outcome === 'completed') input.onResult('done')
        else if (outcome === 'failed') input.onFailure(failure)
        else input.onCancel()
        // Duplicate/late terminal callbacks cannot rewrite the settled outcome.
        input.onFailure(new Error('late failure'))
      })
    for (let i = 0; i < 2; i++) {
      const pending = bounded(
        f.starter({ task: 'work', signal: new AbortController().signal }),
      )
      if (outcome === 'completed') assert.equal((await pending).summary, 'done')
      else
        await assert.rejects(
          pending,
          outcome === 'cancelled'
            ? { name: 'AbortError' }
            : (error) => error === failure,
        )
    }
    assert.ok(
      f.store.delegations
        .listByParentRun(f.parent.id)
        .every((row) => row.status === outcome),
    )
  })
}

for (const outcome of ['completed', 'failed', 'cancelled']) {
  test(`${outcome}: store failure still settles and releases the child budget`, async (t) => {
    const f = fixture(t)
    const update = f.store.delegations.update.bind(f.store.delegations)
    const failure = new Error('child failed')
    f.launcher.launch = (input) =>
      queueMicrotask(() => {
        t.mock.method(f.store.delegations, 'update', () => {
          throw new Error('storage unavailable')
        })
        if (outcome === 'completed') input.onResult('done')
        else if (outcome === 'failed') input.onFailure(failure)
        else input.onCancel()
        t.mock.method(f.store.delegations, 'update', update)
      })
    for (let i = 0; i < 2; i++) {
      await assert.rejects(
        bounded(
          f.starter({ task: 'work', signal: new AbortController().signal }),
        ),
        outcome === 'cancelled'
          ? { name: 'AbortError' }
          : outcome === 'failed'
            ? (error) => error === failure
            : /结果收尾失败/,
      )
    }
  })
}

test('failure reading child Run metadata cannot strand the parent', async (t) => {
  const f = fixture(t)
  const failure = new Error('child failed')
  f.launcher.launch = (input) =>
    queueMicrotask(() => {
      t.mock.method(f.store.runs, 'get', () => {
        throw new Error('read failed')
      })
      input.onFailure(failure)
    })
  await assert.rejects(
    bounded(f.starter({ task: 'work', signal: new AbortController().signal })),
    (error) => error === failure,
  )
})

test('synchronous launch failure records delegation failure and releases budget', async (t) => {
  const f = fixture(t)
  f.launcher.launch = () => {
    throw new Error('launch failed')
  }
  for (let i = 0; i < 2; i++)
    await assert.rejects(
      bounded(
        f.starter({ task: 'work', signal: new AbortController().signal }),
      ),
      /launch failed/,
    )
  assert.ok(
    f.store.delegations
      .listByParentRun(f.parent.id)
      .every((row) => row.status === 'failed'),
  )
})

test('escaped Runner finalization failure reaches the delegating parent', async (t) => {
  const f = fixture(t)
  let finished
  const settled = new Promise((resolve) => {
    finished = resolve
  })
  f.deps.launcher = new RunLauncher(
    {
      store: f.store,
      system: null,
      mcp: null,
      runner: {
        execute: async () => {
          throw new Error('finalization failed')
        },
      },
      approvals: new ApprovalGateway(),
      skills: { list: () => [] },
      danger: { isActive: () => false },
    },
    { onRunSettled: finished },
  )
  const starter = createChildRunStarter(f.deps, f.parent, f.session)
  await assert.rejects(
    bounded(starter({ task: 'work', signal: new AbortController().signal })),
    /执行或终态收尾异常/,
  )
  await bounded(settled)
  const [delegation] = f.store.delegations.listByParentRun(f.parent.id)
  assert.equal(delegation.status, 'failed')
  assert.equal(f.deps.launcher.cancel(delegation.childRunId), false)
})
