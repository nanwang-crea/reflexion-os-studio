import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from 'esbuild'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const outfile = join(
  mkdtempSync(join(tmpdir(), 'chat-actions-')),
  'actions.mjs',
)
await build({
  entryPoints: ['frontend/hooks/session/useSessionActions.ts'],
  absWorkingDir: fileURLToPath(new URL('..', import.meta.url)),
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile,
  plugins: [
    {
      name: 'stub-desktop-boundaries',
      setup(build) {
        build.onResolve({ filter: /api\/client$|^\.\/client$/ }, () => ({
          path: 'client',
          namespace: 'stub',
        }))
        build.onResolve({ filter: /features\/terminal\/manager$/ }, () => ({
          path: 'terminal',
          namespace: 'stub',
        }))
        build.onLoad({ filter: /.*/, namespace: 'stub' }, ({ path }) => ({
          contents:
            path === 'client'
              ? 'export const requestList = async () => []; export async function request(method, params) { globalThis.__chatRequests.push({ method, params }); return globalThis.__chatRequestResult?.(method, params) ?? {} }'
              : 'export const terminalManager = {}',
        }))
      },
    },
  ],
})
const { useSessionActions } = await import(pathToFileURL(outfile).href)

test('changing composer selection immediately changes retry and edit resend requests', async () => {
  globalThis.__chatRequests = []
  const deps = {
    activeSessionId: 'session',
    activeProjectId: null,
    selectedModelKey: 'old-provider::old-model',
    permissionPreset: 'workspace-read',
    sessionData: {
      runs: [{ id: 'original', status: 'failed', supersededByRunId: null }],
    },
    refreshSessionData: async () => {},
    refreshStandaloneSessions: async () => {},
    setNotice: (notice) => {
      if (notice) throw new Error(notice)
    },
  }
  const initial = useSessionActions(deps)
  await initial.retryRun()
  const updated = useSessionActions({
    ...deps,
    selectedModelKey: 'new-provider::new::model',
  })
  await updated.retryRun()
  await updated.editResendMessage('message', 'edited question')
  const [before, retry, edit] = globalThis.__chatRequests
  assert.equal(before.params.model, 'old-model')
  assert.equal(retry.method, 'run.retry')
  assert.equal(edit.method, 'message.edit_resend')
  for (const request of [retry, edit]) {
    assert.equal(request.params.providerId, 'new-provider')
    assert.equal(request.params.model, 'new::model')
  }
  delete globalThis.__chatRequests
})

function sendDeps(overrides = {}) {
  return {
    activeSessionId: 'session',
    activeProjectId: null,
    activeSessionRef: { current: 'session' },
    activeProjectRef: { current: null },
    selectedModelKey: null,
    permissionPreset: 'workspace-read',
    setNotice: () => {},
    setActiveSessionId: () => {},
    refreshSessionData: async () => {},
    refreshStandaloneSessions: async () => {},
    ...overrides,
  }
}

test('accepted sends resolve despite refresh failure so composer clears its draft', async () => {
  globalThis.__chatRequests = []
  const notices = []
  await useSessionActions(
    sendDeps({
      setNotice: (value) => notices.push(value),
      refreshSessionData: async () => {
        throw new Error('refresh failed')
      },
    }),
  ).sendMessage('hello')
  assert.equal(
    globalThis.__chatRequests.filter((r) => r.method === 'message.send').length,
    1,
  )
  assert.equal(notices.at(-1), 'refresh failed')
})

test('rejected sends still reject and retain the composer draft', async () => {
  globalThis.__chatRequests = []
  globalThis.__chatRequestResult = () => {
    throw new Error('send failed')
  }
  try {
    await assert.rejects(
      useSessionActions(sendDeps()).sendMessage('hello'),
      /send failed/,
    )
  } finally {
    delete globalThis.__chatRequestResult
  }
})

test('late sends do not navigate away from the selected conversation', async () => {
  globalThis.__chatRequests = []
  const deps = sendDeps({
    setActiveSessionId: () => assert.fail('unexpected navigation'),
    refreshSessionData: () => assert.fail('unexpected refresh'),
  })
  globalThis.__chatRequestResult = () => {
    deps.activeSessionRef.current = 'other'
  }
  try {
    await useSessionActions(deps).sendMessage('hello')
  } finally {
    delete globalThis.__chatRequestResult
  }
})
