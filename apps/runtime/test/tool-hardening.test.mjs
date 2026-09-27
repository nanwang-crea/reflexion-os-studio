import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  decodeSearchCursor,
  encodeSearchCursor,
} from '../dist/agent/tools/search-cursor.js'
import { ShellOutputStore } from '../dist/agent/tools/shell-output.js'
import { isPublicIp } from '../dist/agent/tools/web-security.js'

test('web address filter rejects local and reserved networks', () => {
  for (const address of [
    '127.0.0.1',
    '10.0.0.1',
    '169.254.169.254',
    '192.168.1.1',
    '::1',
    'fe80::1',
    'fc00::1',
    '::ffff:127.0.0.1',
  ]) {
    assert.equal(isPublicIp(address), false, address)
  }
  assert.equal(isPublicIp('8.8.8.8'), true)
  assert.equal(isPublicIp('2606:4700:4700::1111'), true)
})

test('search cursor is opaque, resumable and query-bound', () => {
  const cursor = encodeSearchCursor('grep', 'fingerprint-a', 42)
  assert.equal(decodeSearchCursor(cursor, 'grep', 'fingerprint-a'), 42)
  assert.throws(
    () => decodeSearchCursor(cursor, 'glob', 'fingerprint-a'),
    /does not match/,
  )
  assert.throws(
    () => decodeSearchCursor(cursor, 'grep', 'fingerprint-b'),
    /does not match/,
  )
})

test('shell output store keeps full output behind chunk reads', () => {
  const store = new ShellOutputStore()
  const stdout = 'x'.repeat(20_000)
  const captured = store.capture({
    content: JSON.stringify({ stdout, stderr: 'warning' }),
    isError: false,
  })
  const preview = JSON.parse(captured.content)
  assert.equal(preview.stdout.length, 12_000)
  assert.equal(preview.stdoutTruncated, true)
  const tail = store.read(preview.outputId, 'stdout', 12_000, 10_000)
  assert.equal(tail.content.length, 8_000)
  assert.equal(tail.truncated, false)
})
