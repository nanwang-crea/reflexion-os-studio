import assert from 'node:assert/strict'
import { test, after } from 'node:test'
import { build } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const directory = mkdtempSync(join(tmpdir(), 'reflexion-md-read-'))
after(() => rmSync(directory, { recursive: true, force: true }))
const outfile = join(directory, 'read-lines.mjs')
await build({
  absWorkingDir: root,
  stdin: {
    contents: `export { messageResourceUri } from './frontend/features/chat/message/resource-links'
      export { relativeWorkspaceResource } from './frontend/features/workspace/preview/links'
      export { parseResourceLink } from './frontend/components/markdown/md-core-types'
      export { splitReadLines } from './frontend/features/workspace/preview/read-lines'
      export { createMdChunkerState, feedMdLines, flushMdChunks } from './frontend/features/workspace/preview/md-chunks'`,
    resolveDir: root,
  },
  bundle: true,
  format: 'esm',
  outfile,
})
const {
  parseResourceLink,
  relativeWorkspaceResource,
  messageResourceUri,
  splitReadLines,
  createMdChunkerState,
  feedMdLines,
  flushMdChunks,
} = await import(pathToFileURL(outfile).href)

test('原文分页不把末尾分隔符算作额外一行，保留真实空行', () => {
  for (const separator of ['\n', '\r\n']) {
    assert.deepEqual(splitReadLines(`a${separator}b${separator}`), ['a', 'b'])
    assert.deepEqual(splitReadLines(separator), [''])
    assert.deepEqual(splitReadLines(`a${separator}${separator}`), ['a', ''])
  }
  assert.deepEqual(splitReadLines(''), [])
  assert.deepEqual(splitReadLines('tail'), ['tail'])
})

test('围栏跨分页时不跳过代码或闭合行', () => {
  for (const separator of ['\n', '\r\n']) {
    const logical = [
      '# 标题',
      '',
      '```ts',
      'const a = 1',
      'const b = 2',
      '```',
      '',
      '尾段',
    ]
    const chunker = createMdChunkerState()
    const blocks = []
    let nextLine = 0
    while (nextLine < logical.length) {
      const selected = logical.slice(nextLine, nextLine + 3)
      const lines = splitReadLines(selected.join(separator) + separator)
      nextLine += lines.length
      blocks.push(...feedMdLines(chunker, lines))
    }
    blocks.push(...flushMdChunks(chunker))
    assert.equal(nextLine, logical.length)
    const rendered = blocks.join('\n')
    assert.match(rendered, /const a = 1\nconst b = 2\n```/)
    assert.match(rendered, /尾段/)
  }
})

test('message links recover only line fragments proven by the original Markdown', () => {
  const path = 'apps/desktop/frontend/features/chat/ChatView.tsx'
  for (const suffix of ['#L197-L217', '#L197-217', '#L197']) {
    const uri = `workspace://project/${path}${suffix.replace('#', '%23')}`
    const oldLink = parseResourceLink(uri)
    for (const target of [
      `${path}${suffix}`,
      `./${path}${suffix}`,
      `/repo/${path}${suffix}`,
      `${path.replaceAll('/', '\\')}${suffix}`,
    ]) {
      const repaired = parseResourceLink(
        messageResourceUri(oldLink, 'file', `[file](${target})`),
      )
      assert.equal(repaired.path, path)
      assert.equal(repaired.line, 197)
    }
    for (const content of [
      `[file](${path}${suffix.replace('#', '%23')})`,
      `[other](${path}${suffix})`,
      `\`[file](${path}${suffix})\``,
      `\`\`\`\n[file](${path}${suffix})\n\`\`\``,
      '',
    ]) {
      assert.equal(messageResourceUri(oldLink, 'file', content), uri)
    }
    assert.equal(parseResourceLink(uri).path, `${path}${suffix}`)
  }
  assert.equal(
    parseResourceLink('workspace://project/file%23L197').path,
    'file#L197',
  )
  assert.equal(
    parseResourceLink('https://example.com/file%23L197').uri,
    'https://example.com/file%23L197',
  )
})

test('Markdown relative references preserve line fragments and decode path characters once', () => {
  for (const [target, path, line] of [
    ['../src/a.ts#L47-L51', 'src/a.ts', 47],
    ['../src/a%20b.ts#L8', 'src/a b.ts', 8],
    ['../src/%20a%20.ts#L8', 'src/ a .ts', 8],
    ['../src/file%23L197.ts', 'src/file#L197.ts', undefined],
    ['/src/a.ts#L12', 'src/a.ts', 12],
    ['notes.md#heading', 'docs/notes.md', undefined],
  ]) {
    const resource = relativeWorkspaceResource('p', 'docs/guide.md', target)
    assert.equal(resource.path, path)
    assert.equal(resource.line, line)
    assert.equal(parseResourceLink(resource.uri).path, path)
  }
  for (const target of [
    '../../outside.ts',
    '/%2e%2e/outside.ts',
    'file:///tmp/a.ts',
    'https://example.com/a.ts',
    '//server/share/a.ts',
    '%',
  ]) {
    assert.equal(relativeWorkspaceResource('p', 'docs/guide.md', target), null)
  }
})
