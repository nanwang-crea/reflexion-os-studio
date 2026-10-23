import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  existsSync,
  linkSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { ToolRegistry } from '@reflexion-os-studio/agent-core'
import { createSkillPrepareTool } from '../dist/agent/tools/skill-authoring.js'
import { fixture, input } from './fixtures/skill-packages.mjs'

function tools(f, runId = 'resources') {
  const registry = new ToolRegistry()
  const tool = createSkillPrepareTool({
    projectId: f.project.id,
    runId,
    skillTools: f.service,
  })
  registry.register(tool)
  return {
    tool,
    call: (skillId, resource, signal = new AbortController().signal) =>
      registry.call(
        {
          id: 'prepare',
          name: 'skill.prepare',
          arguments: JSON.stringify({ skillId, resource }),
        },
        signal,
      ),
  }
}

test('small resources remain readable beyond the old aggregate budget and after cache eviction', async (t) => {
  const f = fixture(t)
  const plugin = await f.service.save(input(f.project.id))
  const directory = join(plugin.installPath, 'references', 'guide')
  mkdirSync(directory)
  const paths = Array.from(
    { length: 25 },
    (_, index) => `a-${String(index).padStart(2, '0')}.md`,
  )
  const filler = 'a'.repeat(90000)
  for (const path of paths) writeFileSync(join(directory, path), filler)
  const resource = 'references/guide/被裁了之后先做什么.md'
  const content = '参考资料。'.repeat(399) + '好'
  assert.equal(Buffer.byteLength(content), 5988)
  assert.ok(paths.length * Buffer.byteLength(filler) > 2000000)
  writeFileSync(join(plugin.installPath, resource), content)
  const { call } = tools(f)
  const list = await call(plugin.id)
  assert.equal(list.isError, false)
  assert.ok(list.data.resources.includes(resource))
  assert.equal(list.data.resource, null)
  for (const path of [
    resource,
    ...paths.map((p) => `references/guide/${p}`),
    resource,
  ]) {
    const result = await call(plugin.id, path)
    assert.equal(result.isError, false, result.content)
    assert.equal(
      result.data.resource.content,
      path === resource ? content : filler,
    )
  }
  f.service.releaseRun('resources')
  assert.equal(existsSync(list.data.directory), false)
})

test('prepare reports distinct actionable errors through ToolRegistry and can recover with a valid resource', async (t) => {
  const f = fixture(t)
  const plugin = await f.service.save(input(f.project.id))
  const files = [
    ['limit.txt', 'a'.repeat(100000)],
    ['large.txt', 'a'.repeat(100001)],
    ['binary.dat', Buffer.from([65, 0, 66])],
    ['invalid.txt', Buffer.from([0xc3, 0x28])],
    ['empty.txt', ''],
  ]
  for (const [name, bytes] of files)
    writeFileSync(join(plugin.installPath, 'references', name), bytes)
  const { call } = tools(f)
  for (const [resource, reason] of [
    ['references/binary.dat', /二进制/],
    ['references/invalid.txt', /UTF-8/],
    ['references/missing.txt', /不存在或越界/],
    ['references/../SKILL.md', /不存在或越界/],
    ['references\\input.md', /不存在或越界/],
    ['/references/input.md', /不存在或越界/],
  ]) {
    const result = await call(plugin.id, resource)
    assert.equal(result.isError, true)
    assert.equal(result.code, 'tool_error')
    assert.match(result.content, reason)
    assert.doesNotMatch(result.content, /inconsistent internal state/)
  }
  const unavailable = await call('missing-skill')
  assert.equal(unavailable.code, 'tool_error')
  assert.match(unavailable.content, /不可用/)
  const large = await call(plugin.id, 'references/large.txt')
  assert.equal(large.isError, false, large.content)
  assert.ok(
    large.data.resource.bytesRead > 0 &&
      large.data.resource.bytesRead <= 100000,
  )
  assert.equal(large.data.resource.hasMore, true)
  assert.equal(large.data.resource.nextOffset, large.data.resource.bytesRead)
  for (const name of ['limit.txt', 'empty.txt', 'input.md']) {
    const result = await call(plugin.id, `references/${name}`)
    assert.equal(result.isError, false, result.content)
  }
})

test('unread resources cannot be replaced after preparation; installed changes do not affect the Run snapshot', async (t) => {
  const f = fixture(t)
  const plugin = await f.service.save(input(f.project.id))
  const { call } = tools(f)
  const list = await call(plugin.id)
  writeFileSync(
    join(plugin.installPath, 'references', 'input.md'),
    'Updated source',
  )
  const original = await call(plugin.id, 'references/input.md')
  assert.equal(original.data.resource.content, 'Input contract')
  writeFileSync(
    join(list.data.directory, 'scripts', 'report.mjs'),
    'Replacement',
  )
  const changed = await call(plugin.id, 'scripts/report.mjs')
  assert.equal(changed.code, 'tool_error')
  assert.match(changed.content, /快照资源已变化/)
  assert.doesNotMatch(changed.content, /Replacement/)
})

for (const kind of ['file symlink', 'directory symlink', 'hard link']) {
  test(
    `prepare rejects an unread resource replaced with a ${kind}`,
    {
      skip: process.platform === 'win32' && kind.includes('symlink'),
    },
    async (t) => {
      const f = fixture(t)
      const plugin = await f.service.save(input(f.project.id))
      const { call } = tools(f)
      const list = await call(plugin.id)
      const references = join(list.data.directory, 'references')
      const outside = join(f.root, 'outside')
      mkdirSync(outside)
      writeFileSync(join(outside, 'input.md'), 'Outside content')
      if (kind === 'directory symlink') {
        rmSync(references, { recursive: true })
        symlinkSync(outside, references, 'dir')
      } else {
        const path = join(references, 'input.md')
        rmSync(path)
        if (kind === 'file symlink')
          symlinkSync(join(outside, 'input.md'), path)
        else linkSync(join(outside, 'input.md'), path)
      }
      const result = await call(plugin.id, 'references/input.md')
      assert.equal(result.code, 'tool_error')
      assert.match(result.content, /符号链接|快照资源已变化/)
      assert.doesNotMatch(result.content, /Outside content/)
    },
  )
}

test('prepare preserves cancellation and reports unavailable resource service', async (t) => {
  const f = fixture(t)
  const { tool, call } = tools(f)
  const controller = new AbortController()
  controller.abort()
  const args = { skillId: 'example-helper' }
  assert.throws(() => tool.execute({ args, signal: controller.signal }), {
    name: 'AbortError',
  })
  await assert.rejects(call(args.skillId, undefined, controller.signal), {
    name: 'AbortError',
  })
  const unavailable = createSkillPrepareTool({ projectId: null, runId: 'run' })
  const result = await unavailable.execute({
    args,
    signal: new AbortController().signal,
  })
  assert.equal(result.code, 'tool_error')
  assert.match(result.content, /Skill 资源服务不可用/)
  const cancelled = createSkillPrepareTool({
    projectId: null,
    runId: 'run',
    skillTools: {
      prepare() {
        throw new DOMException('Aborted', 'AbortError')
      },
    },
  })
  assert.throws(
    () => cancelled.execute({ args, signal: new AbortController().signal }),
    { name: 'AbortError' },
  )
})
