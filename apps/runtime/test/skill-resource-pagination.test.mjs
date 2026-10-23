import assert from 'node:assert/strict'
import { test } from 'node:test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ToolRegistry } from '@reflexion-os-studio/agent-core'
import {
  SkillPrepareInputSchema,
  SkillPreparedSchema,
} from '@reflexion-os-studio/contracts'
import { createSkillPrepareTool } from '../dist/agent/tools/skill-authoring.js'
import { capToolResultForModel } from '../dist/agent/run/toolResults.js'
import { fixture, input } from './fixtures/skill-packages.mjs'

async function setup(t, content) {
  const f = fixture(t)
  const plugin = await f.service.save(input(f.project.id))
  const resource = 'references/分页资料.md'
  writeFileSync(join(plugin.installPath, resource), content)
  const registry = new ToolRegistry()
  registry.register(
    createSkillPrepareTool({
      projectId: f.project.id,
      runId: 'pages',
      skillTools: f.service,
    }),
  )
  const call = (options = {}) =>
    registry.call(
      {
        id: 'page',
        name: 'skill.prepare',
        arguments: JSON.stringify({ skillId: plugin.id, resource, ...options }),
      },
      new AbortController().signal,
    )
  const page = async (options) => {
    const result = await call(options)
    assert.equal(result.isError, false, result.content)
    return SkillPreparedSchema.parse(result.data).resource
  }
  return { ...f, plugin, resource, call, page }
}

test('default and explicit pages reconstruct a large UTF-8 resource without loss, including long lines and CRLF', async (t) => {
  const content =
    '\ufeff' + ('中文🙂\r\n' + 'a'.repeat(100001)).repeat(3) + '\n结束'
  const f = await setup(t, content)
  const first = await f.page()
  assert.equal(first.offset, 0)
  assert.equal(first.totalBytes, Buffer.byteLength(content))
  assert.equal(first.hasMore, true)
  assert.ok(first.bytesRead <= 100000)
  assert.ok(first.content.length < content.length)
  let reconstructed = ''
  let offset = 0
  let pages = 0
  while (true) {
    const page = await f.page({ offset, limit: 65537 })
    reconstructed += page.content
    assert.equal(page.offset, offset)
    assert.ok(page.bytesRead > 0 && page.bytesRead <= 65537)
    assert.equal(page.hasMore, page.nextOffset !== null)
    pages++
    if (!page.hasMore) break
    assert.equal(page.nextOffset, offset + page.bytesRead)
    offset = page.nextOffset
  }
  assert.ok(pages > 3)
  assert.equal(reconstructed, content.slice(1))
})

test('UTF-8 cursors preserve Chinese, emoji, interior BOMs and tiny pages without splitting characters', async (t) => {
  const content = 'a中文🙂b\ufeff末尾'
  const f = await setup(t, content)
  for (const limit of [4, 5, 6, 7, 8]) {
    let reconstructed = ''
    let offset = 0
    while (true) {
      const page = await f.page({ offset, limit })
      reconstructed += page.content
      assert.equal(page.bytesRead, Buffer.byteLength(page.content))
      assert.ok(page.bytesRead > 0 && page.bytesRead <= limit)
      if (!page.hasMore) break
      offset = page.nextOffset
    }
    assert.equal(reconstructed, content)
  }
  const invalid = await f.call({ offset: 2, limit: 4 })
  assert.equal(invalid.isError, true)
  assert.match(invalid.content, /UTF-8 字符边界.*nextOffset/)
})

test('UTF-8 validation and pages cross IO-buffer boundaries without replacement characters', async (t) => {
  const content = 'a'.repeat(65535) + '中🙂' + 'b'.repeat(65530) + '末🙂'
  const f = await setup(t, content)
  let offset = 0
  let reconstructed = ''
  while (true) {
    const page = await f.page({ offset, limit: 65536 })
    reconstructed += page.content
    assert.doesNotMatch(page.content, /\ufffd/)
    if (!page.hasMore) break
    offset = page.nextOffset
  }
  assert.equal(reconstructed, content)
})

test('empty resources, exact-size pages and EOF offsets have unambiguous final-page metadata', async (t) => {
  for (const content of ['', 'a'.repeat(100000), 'a'.repeat(100001)]) {
    const f = await setup(t, content)
    const first = await f.page()
    assert.ok(first.bytesRead <= Math.min(100000, content.length))
    assert.equal(first.hasMore, first.bytesRead < content.length)
    assert.equal(first.nextOffset, first.hasMore ? first.bytesRead : null)
    const raw = f.service.prepare(
      f.plugin.id,
      f.project.id,
      'pages',
      f.resource,
    )
    assert.equal(raw.resource.bytesRead, Math.min(100000, content.length))
    const eof = await f.page({ offset: content.length })
    assert.equal(eof.content, '')
    assert.equal(eof.bytesRead, 0)
    assert.equal(eof.totalBytes, content.length)
    assert.equal(eof.hasMore, false)
    assert.equal(eof.nextOffset, null)
    const beyond = await f.call({ offset: content.length + 1 })
    assert.equal(beyond.isError, true)
    assert.match(beyond.content, /offset 超出资源大小.*nextOffset/)
  }
})

test('pagination input rejects invalid ranges and missing resource while legacy input remains valid', async (t) => {
  const f = await setup(t, 'some text')
  assert.equal(
    SkillPrepareInputSchema.safeParse({ skillId: 'example-helper' }).success,
    true,
  )
  for (const options of [
    { offset: -1 },
    { offset: 1.5 },
    { offset: Number.MAX_SAFE_INTEGER + 1 },
    { limit: 0 },
    { limit: 3 },
    { limit: 100001 },
    { limit: 4.5 },
    { offset: '0' },
    { limit: '4' },
    { resource: undefined, offset: 0 },
    { resource: undefined, limit: 4 },
  ]) {
    const result = await f.call(options)
    assert.equal(result.isError, true, JSON.stringify(options))
    assert.notEqual(result.code, 'internal_error')
  }
  const partial = await f.page({ limit: 4 })
  const rest = await f.page({ offset: partial.nextOffset })
  assert.equal(partial.content + rest.content, 'some text')
})

test('large binary and invalid UTF-8 resources are rejected even when corruption is beyond the requested page', async (t) => {
  for (const [suffix, reason] of [
    [Buffer.from([0]), /二进制/],
    [Buffer.from([0xc3, 0x28]), /UTF-8/],
    [Buffer.from([0xf0, 0x9f]), /UTF-8/],
  ]) {
    const f = await setup(t, Buffer.concat([Buffer.alloc(200000, 65), suffix]))
    const result = await f.call({ limit: 4 })
    assert.equal(result.isError, true)
    assert.match(result.content, reason)
  }
})

test('continuation detects snapshot changes beyond the requested page and rejects growth or truncation', async (t) => {
  for (const replacement of [
    'a'.repeat(299999) + 'b',
    'a'.repeat(300001),
    'a'.repeat(299999),
  ]) {
    const f = await setup(t, 'a'.repeat(300000))
    const first = await f.page()
    const list = f.service.prepare(f.plugin.id, f.project.id, 'pages')
    writeFileSync(join(list.directory, f.resource), replacement)
    const next = await f.call({ offset: first.nextOffset })
    assert.equal(next.isError, true)
    assert.match(next.content, /快照资源已变化/)
  }
})

test('page cache keys include resource, offset and limit, and evicted pages remain readable', async (t) => {
  const content = 'abcdefghijklmnop'.repeat(10)
  const f = await setup(t, content)
  const first = await f.page({ limit: 4 })
  assert.equal(first.content, content.slice(0, 4))
  assert.equal((await f.page({ limit: 8 })).content, content.slice(0, 8))
  for (let offset = 4; offset <= 120; offset += 4)
    assert.equal(
      (await f.page({ offset, limit: 4 })).content,
      content.slice(offset, offset + 4),
    )
  assert.deepEqual(await f.page({ limit: 4 }), first)
  const other = f.service.prepare(
    f.plugin.id,
    f.project.id,
    'pages',
    'references/input.md',
    { limit: 4 },
  )
  assert.equal(other.resource.content, 'Inpu')
})

test('model feedback preserves every page byte, including JSON escapes, and uses the adjusted cursor', async (t) => {
  for (const content of [
    '\ufeff' + 'a'.repeat(250000),
    'a"\\\n\t\u0001🙂中'.repeat(15000),
  ]) {
    const f = await setup(t, content)
    let offset = 0
    let reconstructed = ''
    while (true) {
      const result = await f.call({ offset })
      assert.equal(result.isError, false, result.content)
      const projected = capToolResultForModel(result.content)
      assert.equal(projected, result.content)
      const page = JSON.parse(projected).resource
      assert.deepEqual(page, result.data.resource)
      assert.ok(page.bytesRead > 0 && page.bytesRead <= 100000)
      assert.equal(
        page.bytesRead,
        Buffer.byteLength(page.content) +
          (offset === 0 && content.startsWith('\ufeff') ? 3 : 0),
      )
      reconstructed += page.content
      if (!page.hasMore) break
      assert.equal(page.nextOffset, offset + page.bytesRead)
      offset = page.nextOffset
    }
    assert.equal(reconstructed, content.replace(/^\ufeff/, ''))
  }
})
