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
    contents: `export { splitReadLines } from './frontend/features/workspace/preview/read-lines'
      export { createMdChunkerState, feedMdLines, flushMdChunks } from './frontend/features/workspace/preview/md-chunks'`,
    resolveDir: root,
  },
  bundle: true,
  format: 'esm',
  outfile,
})
const { splitReadLines, createMdChunkerState, feedMdLines, flushMdChunks } =
  await import(pathToFileURL(outfile).href)

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
