import assert from 'node:assert/strict'
import { test } from 'node:test'
import { verifyCrtDependencies } from '../windows/crt-dependencies.mjs'

test('Windows system DLL imports are allowed independent of dumpbin language', () => {
  assert.deepEqual(
    verifyCrtDependencies(
      'Image dependencies:\r\n KERNEL32.dll\r\n ADVAPI32.dll\r\n',
    ),
    ['KERNEL32.dll', 'ADVAPI32.dll'],
  )
})
test('VC runtime, debug runtime and UCRT imports fail distribution checks', () => {
  for (const name of [
    'VCRUNTIME140.dll',
    'vcruntime140_1.dll',
    'VCRUNTIME140D.dll',
    'MSVCP140.dll',
    'MSVCR120.dll',
    'CONCRT140.dll',
    'ucrtbase.dll',
    'api-ms-win-crt-runtime-l1-1-0.dll',
  ]) {
    assert.throws(
      () => verifyCrtDependencies(`KERNEL32.dll\n${name}`),
      /dynamic CRT/,
    )
  }
})
test('empty or failed tool output never silently passes', () => {
  assert.throws(
    () => verifyCrtDependencies('error: cannot open executable'),
    /did not report/,
  )
})
