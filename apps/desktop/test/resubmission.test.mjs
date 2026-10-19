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
    refreshSessions: async () => {},
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
  await updated.editResendMessage('message', 'edited question', [], [])
  const [before, retry, edit] = globalThis.__chatRequests
  assert.equal(before.params.model, 'old-model')
  assert.equal(retry.method, 'run.retry')
  assert.equal(edit.method, 'message.edit_resend')
  assert.deepEqual(edit.params.attachmentAssetIds, [])
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
    refreshSessions: async () => {},
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

test('edit resend forwards retained image references and explicit removal', async () => {
  globalThis.__chatRequests = []
  const actions = useSessionActions(sendDeps())
  await actions.editResendMessage(
    'message',
    'edited question',
    ['retained-image'],
    [],
  )
  await actions.editResendMessage('message', 'edited question', [], [])
  assert.deepEqual(
    globalThis.__chatRequests.map((r) => r.params.attachmentAssetIds),
    [['retained-image'], []],
  )
  delete globalThis.__chatRequests
})

test('document sends use the general upload command and preserve extracted asset references', async () => {
  globalThis.__chatRequests = []
  globalThis.FileReader = class {
    readAsDataURL(file) {
      void file.arrayBuffer().then((buffer) => {
        this.result = `data:;base64,${Buffer.from(buffer).toString('base64')}`
        this.onload()
      })
    }
  }
  globalThis.__chatRequestResult = (method) =>
    method === 'asset.upload_document' ? { asset: { assetId: 'document' } } : {}
  try {
    await useSessionActions(sendDeps()).sendMessage('analyze', undefined, [
      new File(['const x = 1'], 'example.ts'),
    ])
    const upload = globalThis.__chatRequests.find(
      (request) => request.method === 'asset.upload_document',
    )
    const send = globalThis.__chatRequests.find(
      (request) => request.method === 'message.send',
    )
    assert.equal(upload.params.fileName, 'example.ts')
    assert.deepEqual(send.params.attachmentAssetIds, ['document'])
    assert.equal(send.params.imageAssetIds, undefined)
  } finally {
    delete globalThis.__chatRequestResult
    delete globalThis.FileReader
  }
})

test('five files are rejected before upload and partial failed uploads are cleaned up', async () => {
  globalThis.__chatRequests = []
  const actions = useSessionActions(sendDeps())
  const files = Array.from(
    { length: 5 },
    (_, index) => new File(['text'], `${index}.txt`),
  )
  await assert.rejects(
    actions.sendMessage('analyze', undefined, files),
    /最多 4 个文件/,
  )
  assert.equal(globalThis.__chatRequests.length, 0)
  globalThis.FileReader = class {
    readAsDataURL(file) {
      void file.arrayBuffer().then((buffer) => {
        this.result = `data:;base64,${Buffer.from(buffer).toString('base64')}`
        this.onload()
      })
    }
  }
  let count = 0
  globalThis.__chatRequestResult = (method) => {
    if (method === 'asset.upload_document') {
      if (++count === 2) throw new Error('parse failed')
      return { asset: { assetId: 'first' } }
    }
    return {}
  }
  try {
    await assert.rejects(
      actions.sendMessage('analyze', undefined, files.slice(0, 2)),
      /parse failed/,
    )
    assert.deepEqual(
      globalThis.__chatRequests
        .filter((request) => request.method === 'asset.delete')
        .map((request) => request.params.assetId),
      ['first'],
    )
    assert.equal(
      globalThis.__chatRequests.some(
        (request) => request.method === 'message.send',
      ),
      false,
    )
  } finally {
    delete globalThis.__chatRequestResult
    delete globalThis.FileReader
  }
})

test('accepted edit keeps uploaded attachments despite either refresh failing; rejected edit cleans once', async () => {
  const previousReader = globalThis.FileReader
  globalThis.FileReader = class {
    readAsDataURL(file) {
      void file.arrayBuffer().then((buffer) => {
        this.result = `data:;base64,${Buffer.from(buffer).toString('base64')}`
        this.onload()
      })
    }
  }
  try {
    for (const failure of ['refreshSessionData', 'refreshSessions', 'resend']) {
      globalThis.__chatRequests = []
      globalThis.__chatRequestResult = (method) => {
        if (method === 'asset.upload_document')
          return { asset: { assetId: 'uploaded' } }
        if (method === 'message.edit_resend' && failure === 'resend')
          throw Error('resend failed')
        return {}
      }
      const notices = []
      const actions = useSessionActions(
        sendDeps({
          setNotice: (notice) => notices.push(notice),
          ...(failure !== 'resend'
            ? {
                [failure]: async () => {
                  throw Error('refresh failed')
                },
              }
            : {}),
        }),
      )
      const result = actions.editResendMessage(
        'message',
        'edited',
        ['retained'],
        [new File(['text'], 'notes.txt')],
      )
      if (failure === 'resend') await assert.rejects(result, /resend failed/)
      else await result
      assert.deepEqual(
        globalThis.__chatRequests
          .filter((r) => r.method === 'asset.delete')
          .map((r) => r.params.assetId),
        failure === 'resend' ? ['uploaded'] : [],
      )
      assert.equal(
        globalThis.__chatRequests.filter(
          (r) => r.method === 'message.edit_resend',
        ).length,
        1,
      )
      assert.equal(
        notices.at(-1),
        failure === 'resend' ? 'resend failed' : 'refresh failed',
      )
    }
  } finally {
    globalThis.FileReader = previousReader
    delete globalThis.__chatRequestResult
    delete globalThis.__chatRequests
  }
})
