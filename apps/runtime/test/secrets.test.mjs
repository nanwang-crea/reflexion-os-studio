import assert from 'node:assert/strict'
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { SecretStore, SecretStoreError } from '../dist/secrets.js'

function freshDir() {
  return mkdtempSync(join(tmpdir(), 'reflexion-secrets-'))
}

test('secret store round-trips and atomically replaces the file', () => {
  const dir = freshDir()
  const store = new SecretStore(dir)

  store.save('local:first', 'first-secret')
  store.save('local:second', 'second-secret')

  assert.equal(store.load('local:first'), 'first-secret')
  assert.equal(store.load('local:second'), 'second-secret')
  assert.equal(
    readFileSync(join(dir, 'secrets.json'), 'utf8').endsWith('\n'),
    true,
  )
  assert.deepEqual(
    readdirSync(dir).filter((name) => name.endsWith('.tmp')),
    [],
  )
})

test(
  'secret store preserves 0600 mode on POSIX',
  { skip: process.platform === 'win32' },
  () => {
    const dir = freshDir()
    const store = new SecretStore(dir)
    store.save('local:key', 'secret')

    assert.equal(statSync(join(dir, 'secrets.json')).mode & 0o777, 0o600)
  },
)

test('corrupt JSON produces stable non-leaking error', () => {
  const dir = freshDir()
  const leakedSecret = 'do-not-leak-this-secret'
  writeFileSync(
    join(dir, 'secrets.json'),
    `{"local:key":"${leakedSecret}",`,
    'utf8',
  )
  const store = new SecretStore(dir)

  assert.throws(
    () => store.load('local:key'),
    (error) => {
      assert.ok(error instanceof SecretStoreError)
      assert.equal(error.code, 'secrets_corrupted')
      assert.equal(error.message, '密钥文件损坏或格式非法，拒绝读取')
      assert.equal(error.message.includes(leakedSecret), false)
      return true
    },
  )
})

test('non-object JSON is treated as corruption', () => {
  const dir = freshDir()
  writeFileSync(join(dir, 'secrets.json'), '["secret"]', 'utf8')
  const store = new SecretStore(dir)

  assert.throws(() => store.load('local:key'), {
    code: 'secrets_corrupted',
    message: '密钥文件损坏或格式非法，拒绝读取',
  })
})

test('deleting an unknown reference is a no-op', () => {
  const store = new SecretStore(freshDir())
  assert.equal(store.delete('local:missing'), false)
})
