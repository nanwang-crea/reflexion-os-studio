import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  parseEnvDump,
  mergeUserEnv,
  probeUserShellEnv,
} from '../dist/user-shell-env.js'

test('parseEnvDump 解析 NUL 分隔并过滤 rc 噪声段', () => {
  const nul = '\u0000'
  const dump = `noise line\nPATH=/opt/homebrew/bin:/usr/bin${nul}NVM_DIR=/Users/x/.nvm${nul}123BAD=v${nul}=nokey${nul}`
  const env = parseEnvDump(dump)
  assert.equal(env.PATH, '/opt/homebrew/bin:/usr/bin')
  assert.equal(env.NVM_DIR, '/Users/x/.nvm')
  assert.equal(env['123BAD'], undefined)
  assert.equal(env[''], undefined)
})

test('parseEnvDump 无 NUL 时退化为按行解析', () => {
  const env = parseEnvDump('FOO=bar\nPATH=/a:/b\n')
  assert.equal(env.FOO, 'bar')
  assert.equal(env.PATH, '/a:/b')
})

test('mergeUserEnv PATH 快照在前、现值在后去重，其余只补缺失', () => {
  const target = {
    PATH: '/usr/bin:/bin',
    REFLEXION_DATA_DIR: '/app-data',
  }
  const { added, pathPrepended } = mergeUserEnv(target, {
    PATH: '/opt/homebrew/bin:/usr/bin:/Users/x/.nvm/bin',
    NVM_DIR: '/Users/x/.nvm',
    REFLEXION_DATA_DIR: '/should-not-win',
    TERM: 'xterm-256color',
    SHLVL: '2',
    EMPTY_VAR: '',
  })
  assert.equal(target.PATH, '/opt/homebrew/bin:/Users/x/.nvm/bin:/usr/bin:/bin')
  assert.equal(pathPrepended, 2)
  assert.deepEqual(added, ['NVM_DIR'])
  assert.equal(target.REFLEXION_DATA_DIR, '/app-data')
  assert.equal(target.TERM, undefined)
  assert.equal(target.SHLVL, undefined)
  assert.equal(target.EMPTY_VAR, undefined)
})

test('probeUserShellEnv 无可用 shell 时跳过', async () => {
  for (const shell of [null, '', '/nonexistent/shell']) {
    const probe = await probeUserShellEnv({ shell })
    assert.equal(probe.status, shell ? 'failed' : 'skipped-shell')
    assert.deepEqual(probe.env, {})
  }
})

test(
  'probeUserShellEnv 用真实 sh 探测能拿到 PATH',
  { skip: process.platform === 'win32' },
  async () => {
    const probe = await probeUserShellEnv({
      shell: '/bin/sh',
      timeoutMs: 5_000,
    })
    assert.equal(probe.status, 'ok')
    assert.ok((probe.env.PATH ?? '').includes('/bin'))
  },
)

test('probeUserShellEnv 超时不悬挂', async () => {
  const sleeper = process.platform === 'win32' ? null : '/bin/sh'
  if (!sleeper) return
  // 通过一个必然超时的场景验证：把 timeout 压到 1ms。
  const probe = await probeUserShellEnv({ shell: sleeper, timeoutMs: 1 })
  assert.equal(probe.status, 'timeout')
})
