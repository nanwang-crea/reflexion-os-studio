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
              ? 'export const requestList = async () => []; export async function request(method, params) { globalThis.__chatRequests.push({ method, params }); return {} }'
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
