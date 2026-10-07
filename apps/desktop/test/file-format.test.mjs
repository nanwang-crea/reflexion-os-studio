import assert from 'node:assert/strict'
import { test, after } from 'node:test'
import { build } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const directory = mkdtempSync(join(tmpdir(), 'reflexion-file-format-'))
after(() => rmSync(directory, { recursive: true, force: true }))
const outfile = join(directory, 'format.mjs')
await build({
  absWorkingDir: root,
  entryPoints: ['frontend/features/workspace/editor/file-format.ts'],
  bundle: true,
  format: 'esm',
  outfile,
})
const { preserveLineEndings, normalizeLineEndings } = await import(
  pathToFileURL(outfile).href
)

test('混合换行的编辑、插入和删除不改变未修改行的分隔符', () => {
  const original = 'a\r\nb\nc\r\n'
  assert.equal(preserveLineEndings(original, 'a\nB\nc\n'), 'a\r\nB\nc\r\n')
  assert.equal(
    preserveLineEndings(original, 'a\nb\nnew\nc\n'),
    'a\r\nb\nnew\nc\r\n',
  )
  assert.equal(preserveLineEndings(original, 'a\nc\n'), 'a\r\nc\r\n')
  assert.equal(
    preserveLineEndings(original, 'start\na\nb\nc\n'),
    'start\r\na\r\nb\nc\r\n',
  )
})

test('空行、重复行、BOM、无末尾换行与显式删除末尾换行', () => {
  assert.equal(preserveLineEndings('a\r\n\nb\r\n', 'A\n\nb\n'), 'A\r\n\nb\r\n')
  assert.equal(
    preserveLineEndings('a\r\nsame\nsame\r\nend', 'a\nX\nsame\nend'),
    'a\r\nX\nsame\r\nend',
  )
  assert.equal(
    preserveLineEndings('\uFEFFa\r\nb\n', 'A\nb\n'),
    '\uFEFFA\r\nb\n',
  )
  assert.equal(preserveLineEndings('a\r\nb\n', 'a\nb'), 'a\r\nb')
  assert.equal(preserveLineEndings('a\r\nb', 'a\nB'), 'a\r\nB')
  assert.equal(preserveLineEndings('', 'new\n'), 'new\n')
})

test('撤销与重复保存恢复原始换行，不把模型归一化视为内容变化', () => {
  const original = 'a\r\nb\nc\r\n'
  const normalized = normalizeLineEndings(original)
  assert.equal(preserveLineEndings(original, normalized), original)
  const saved = preserveLineEndings(original, 'a\nB\nc\n')
  assert.equal(preserveLineEndings(saved, 'a\nb\nc\n'), original)
  assert.equal(preserveLineEndings(saved, normalizeLineEndings(saved)), saved)
  const deleted = preserveLineEndings(original, 'a\nc\n')
  assert.equal(deleted, 'a\r\nc\r\n')
  // 格式基准随加载固定，不随保存替换，撤销删除可恢复被删行的 LF。
  assert.equal(preserveLineEndings(original, normalized), original)
})

test('过大的混合换行差异拒绝转换，不能静默归一化写入', () => {
  const original = Array.from(
    { length: 1100 },
    (_, index) => `old${index}${index % 2 ? '\n' : '\r\n'}`,
  ).join('')
  const edited = Array.from(
    { length: 1100 },
    (_, index) => `new${index}\n`,
  ).join('')
  assert.throws(
    () => preserveLineEndings(original, edited),
    /无法安全保留混合换行/,
  )
})

test('分次保存超过累计差异预算仍可成功，并保留原始撤销格式', () => {
  const original = Array.from(
    { length: 1100 },
    (_, index) => `old${index}${index % 2 ? '\n' : '\r\n'}`,
  ).join('')
  const edit = (count) =>
    Array.from(
      { length: 1100 },
      (_, index) => `${index < count ? 'new' : 'old'}${index}\n`,
    ).join('')
  const first = preserveLineEndings(original, edit(500), original)
  const second = preserveLineEndings(original, edit(1100), first)
  assert.equal(normalizeLineEndings(second), edit(1100))
  assert.deepEqual(second.match(/\r\n|\n/g), original.match(/\r\n|\n/g))
  assert.equal(
    preserveLineEndings(original, normalizeLineEndings(original), second),
    original,
  )
})
