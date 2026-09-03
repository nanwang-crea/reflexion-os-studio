import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import { Store } from '../dist/store/index.js'
import { normalizeContent } from '../dist/resources/resource-link-normalizer.js'

test('normalizes explicit and filesystem resource links', () => {
  const root = mkdtempSync(join(tmpdir(), 'resource-normalizer-'))
  const repo = join(root, 'repo')
  const workspace = join(repo, 'apps', 'runtime')
  const nested = join(workspace, 'src', 'agent')
  mkdirSync(nested, { recursive: true })
  writeFileSync(join(nested, 'runner.ts'), 'x\n')
  const store = new Store(join(root, 'db'))
  const project = store.projects.create({ name: 'p', folderPath: workspace })
  const session = store.sessions.create(project.id)
  const result = normalizeContent(
    '[read](workspace:///src/a.ts#L3) [asset](asset://a) [web](https://example.com) [relative](src/a.ts) [absolute](' +
      join(workspace, 'src', 'a.ts') +
      ')',
    session,
    store,
  )
  assert.deepEqual(
    result.parts.map((part) => part.type),
    [
      'resource_link',
      'text',
      'resource_link',
      'text',
      'resource_link',
      'text',
      'resource_link',
      'text',
      'resource_link',
    ],
  )
  assert.equal(result.parts[0].label, 'read')
  assert.equal(result.parts[0].link.path, 'src/a.ts')
  assert.equal(result.parts[0].link.line, 3)
  assert.equal(result.parts[6].link.path, 'src/a.ts')
  const repoStyle = normalizeContent(
    '[runner](workspace:///apps/runtime/src/agent/runner.ts#L1)',
    session,
    store,
  )
  assert.equal(repoStyle.parts[0].link.path, 'src/agent/runner.ts')
  // Windows-style single backslashes normalize to forward slashes.
  const backslash = normalizeContent(
    '[bs](workspace:///src\\agent\\runner.ts#L1)',
    session,
    store,
  )
  assert.equal(backslash.parts[0].type, 'resource_link')
  assert.equal(backslash.parts[0].link.path, 'src/agent/runner.ts')
  // Backslash-encoded traversal is rejected, not treated as a literal name.
  const traversal = normalizeContent(
    '[bt](workspace:///src\\..\\secret)',
    session,
    store,
  )
  assert.equal(traversal.parts[0].type, 'text')
  store.close()
})

test('rejects unsupported, escaping, and standalone-session links', () => {
  const root = mkdtempSync(join(tmpdir(), 'resource-normalizer-'))
  const store = new Store(join(root, 'db'))
  const project = store.projects.create({
    name: 'p',
    folderPath: join(root, 'workspace'),
  })
  const session = store.sessions.create(project.id)
  const standalone = store.sessions.create(null)
  for (const target of [
    '../secret',
    'src\\..\\secret',
    'C:\\Users\\foo',
    'C:/Users/foo',
    '\\\\server\\share',
    'file:///tmp/a',
    'http://example.com',
    'foo://bar',
  ]) {
    const result = normalizeContent(`[x](${target})`, session, store)
    assert.equal(result.parts[0].type, 'text')
  }
  assert.equal(
    normalizeContent('[x](file.txt)', standalone, store).parts[0].type,
    'text',
  )
  store.close()
})
