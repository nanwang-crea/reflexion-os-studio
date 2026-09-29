import assert from 'node:assert/strict'
import { test } from 'node:test'
import { homedir, tmpdir } from 'node:os'
import { join, normalize } from 'node:path'
import {
  validateEscalationTargets,
  touchesSensitive,
} from '../dist/agent/permissions/index.js'

test('explicit scopes preserve spaces, deduplicate, and need not occur in shell text', () => {
  const root = join(tmpdir(), 'export with spaces')
  assert.deepEqual(validateEscalationTargets([root, root]), {
    roots: [normalize(root)],
    rejected: [],
  })
})
test('reject credential scopes, their ancestors, relative paths and traversal', () => {
  for (const path of [
    homedir(),
    join(homedir(), '.ssh'),
    join(tmpdir(), '.env.local'),
    join(tmpdir(), 'secrets.json'),
    'relative',
    '~/notes',
    '$HOME/notes',
    '/',
    '/tmp/x/../y',
  ]) {
    assert.deepEqual(
      validateEscalationTargets([path]),
      { roots: [], rejected: [path] },
      path,
    )
  }
  assert.equal(touchesSensitive(join(homedir(), '.aws')), true)
})
test('Windows backslash paths are preserved on Windows; foreign paths fail closed', () => {
  const root = String.raw`C:\Users\dev\My Notes`
  const result = validateEscalationTargets([root])
  assert.equal(result.roots.length, process.platform === 'win32' ? 1 : 0)
})
