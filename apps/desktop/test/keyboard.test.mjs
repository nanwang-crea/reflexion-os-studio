import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const directory = mkdtempSync(join(tmpdir(), 'reflexion-keyboard-'))
const outfile = join(directory, 'keyboard.mjs')
let isComposing
try {
  await build({
    entryPoints: [join(root, 'frontend/lib/keyboard.ts')],
    bundle: true,
    format: 'esm',
    outfile,
  })
  ;({ isComposing } = await import(pathToFileURL(outfile).href))
} finally {
  rmSync(directory, { recursive: true, force: true })
}

test('中文候选词确认不能提交；Safari 229 兼容组合状态提前结束', () => {
  assert.equal(isComposing({ isComposing: true, keyCode: 13 }), true)
  assert.equal(isComposing({ isComposing: false, keyCode: 229 }), true)
  assert.equal(isComposing({ isComposing: false, keyCode: 13 }), false)
  assert.equal(isComposing({ isComposing: false, keyCode: 27 }), false)
})
