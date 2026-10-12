import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

const source = readFileSync(
  new URL(
    '../src-tauri/src/browser/platform/macos/initial-position.js',
    import.meta.url,
  ),
  'utf8',
)

function page({
  width = 1000,
  viewport = 400,
  left = 0,
  hash = '',
  loading = false,
  direction = 'ltr',
} = {}) {
  const calls = []
  let ready
  const root = { scrollWidth: width, clientWidth: viewport, scrollLeft: left }
  runInNewContext(source, {
    document: {
      scrollingElement: root,
      readyState: loading ? 'loading' : 'complete',
      addEventListener(name, callback, options) {
        assert.equal(name, 'DOMContentLoaded')
        assert.equal(options.once, true)
        ready = callback
      },
    },
    location: { hash },
    getComputedStyle: () => ({ direction }),
    window: {
      scrollY: 120,
      scrollTo(options) {
        calls.push({ ...options })
        root.scrollLeft = options.left
      },
    },
  })
  return { calls, root, ready: () => ready?.() }
}

test('wide pages center horizontally without moving vertically', () => {
  assert.deepEqual(page().calls, [{ left: 300, top: 120, behavior: 'instant' }])
})

test('responsive pages and anchor targets retain their normal position', () => {
  assert.deepEqual(page({ width: 400 }).calls, [])
  assert.deepEqual(page({ hash: '#result' }).calls, [])
})

test('centering waits for DOM readiness and does not override user scrolling', () => {
  const normal = page({ loading: true })
  assert.equal(normal.calls.length, 0)
  normal.ready()
  assert.equal(normal.calls.length, 1)
  const moved = page({ loading: true })
  moved.root.scrollLeft = 50
  moved.ready()
  assert.equal(moved.calls.length, 0)
})

test('right-to-left overflow centers in its native scroll direction', () => {
  assert.equal(page({ direction: 'rtl' }).calls[0].left, -300)
})
