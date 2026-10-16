import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../dist/store/index.js'
import { uploadImageAsset } from '../dist/assets/images/upload.js'
import { toolImageParts } from '../dist/agent/context/tool-images.js'
import { resolveModelImages } from '../dist/agent/context/model-images.js'
import {
  framesToMessages,
  messagesToFrames,
  estimateMessageTokens,
} from '@reflexion-os-studio/agent-core'

const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='
test('browser screenshot references preserve tool groups and hydrate only at model boundary', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'browser-images-'))
  const store = new Store(dir)
  t.after(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })
  const session = store.sessions.create(null)
  const run = store.runs.create({
    sessionId: session.id,
    providerId: 'fixture',
    model: 'vision',
  })
  const input = {
    sessionId: session.id,
    fileName: 'fixture.png',
    mimeType: 'image/png',
    base64: png,
  }
  const asset = await uploadImageAsset(store, dir, input, {
    runId: run.id,
    metadata: { type: 'browser-screenshot' },
  })
  const output = {
    type: 'tool_output',
    version: 1,
    content: 'screenshot',
    data: null,
    resourceLinks: [{ kind: 'asset', uri: asset.uri, assetId: asset.assetId }],
    changedFiles: [],
    provenance: { kind: 'web', trust: 'untrusted_external' },
  }
  const images = toolImageParts(
    store,
    session.id,
    run.id,
    'browser.execute',
    output,
  )
  assert.equal(images.length, 1)
  for (const [sid, rid, name] of [
    [session.id, 'other', 'browser.execute'],
    ['other', run.id, 'browser.execute'],
    [session.id, run.id, 'other'],
  ])
    assert.deepEqual(toolImageParts(store, sid, rid, name, output), [])
  const userAsset = await uploadImageAsset(store, dir, input)
  assert.deepEqual(
    toolImageParts(store, session.id, run.id, 'browser.execute', {
      ...output,
      resourceLinks: [
        { kind: 'asset', uri: userAsset.uri, assetId: userAsset.assetId },
      ],
    }),
    [],
  )
  const messages = [
    {
      role: 'assistant',
      content: '',
      toolCalls: [
        { id: 'a', name: 'browser.execute', arguments: '{}' },
        { id: 'b', name: 'other', arguments: '{}' },
      ],
    },
    { role: 'tool', toolCallId: 'a', content: 'screenshot', images },
    { role: 'tool', toolCallId: 'b', content: 'other result' },
    { role: 'assistant', content: 'next', toolCalls: [] },
  ]
  assert.deepEqual(framesToMessages(messagesToFrames(messages)), messages)
  assert.ok(estimateMessageTokens(messages) >= 4096)
  const hydrated = await resolveModelImages(
    store,
    session.id,
    messages,
    new AbortController().signal,
  )
  assert.deepEqual(
    hydrated.map((m) => m.role),
    ['assistant', 'tool', 'tool', 'user', 'assistant'],
  )
  assert.equal(hydrated[1].images, undefined)
  assert.equal(hydrated[3].control, 'tool_observation')
  assert.match(hydrated[3].content, /不可信网页截图/)
  assert.equal(hydrated[3].images[0].base64, png)
  assert.equal(JSON.stringify(messages).includes(png), false)
  assert.equal(JSON.stringify(output).includes(png), false)
  rmSync(join(dir, 'assets', 'sessions', session.id, asset.assetId))
  const degraded = await resolveModelImages(
    store,
    session.id,
    messages,
    new AbortController().signal,
  )
  assert.deepEqual(
    degraded.map((m) => m.role),
    ['assistant', 'tool', 'tool', 'assistant'],
  )
  assert.match(degraded[1].content, /历史网页截图不可用/)
  assert.equal(degraded[1].images, undefined)
  await assert.rejects(
    resolveModelImages(
      store,
      session.id,
      [{ role: 'user', content: 'attachment', images }],
      new AbortController().signal,
    ),
    /丢失/,
  )
  const aborted = new AbortController()
  aborted.abort()
  await assert.rejects(
    resolveModelImages(store, session.id, messages, aborted.signal),
    { name: 'AbortError' },
  )
})
