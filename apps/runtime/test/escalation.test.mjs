import assert from 'node:assert/strict'
import { test } from 'node:test'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  extractEscalationTargets,
  touchesSensitive,
} from '../dist/agent/permissions/index.js'

test('touchesSensitive：凭据目录、双向重叠与数据目录', () => {
  const home = homedir()
  assert.equal(touchesSensitive(join(home, '.ssh', 'id_ed25519')), true)
  assert.equal(touchesSensitive(join(home, '.ssh')), true)
  assert.equal(touchesSensitive(join(home, '.aws', 'credentials')), true)
  assert.equal(touchesSensitive('/etc/shadow'), true)
  assert.equal(touchesSensitive('/Users/dev/projects/app'), false)
  // 祖先覆盖同样拒绝（粗根不得吞掉凭据目录）。
  assert.equal(touchesSensitive(home), true)
  assert.equal(touchesSensitive('/'), false) // '/' 由深度规则处理，非敏感规则
})

test('extractEscalationTargets：取引号剥离后的绝对路径参数', () => {
  const home = homedir()
  const target = join(home, 'notes', 'config')
  const { roots, rejected } = extractEscalationTargets(
    `git config --global core.editor "nano" ${target}/file`,
  )
  assert.equal(rejected.length, 0)
  assert.equal(roots.length, 1)
  assert.equal(roots[0], `${target}/file`)
})

test('提权根上限与去重；越限进 rejected', () => {
  const command = '/a/one /a/two /a/three /a/four /a/five /a/six /a/one'
    .split(' ')
    .join(' ')
  const { roots, rejected } = extractEscalationTargets(command)
  assert.equal(roots.length, 4)
  assert.ok(rejected.length >= 1)
})

test('敏感目标必须被拒绝（no-read 红线不进候选）', () => {
  const home = homedir()
  const { roots, rejected } = extractEscalationTargets(
    `cp x ${home}/.ssh/config`,
  )
  assert.equal(roots.length, 0)
  assert.equal(rejected.includes(`${home}/.ssh/config`), true)
})

test('裸根与一级系统目录过浅被拒；相对路径忽略', () => {
  const { roots, rejected } = extractEscalationTargets('rm -r / /etc /tmp')
  assert.equal(roots.length, 0)
  assert.deepEqual(rejected, ['/', '/etc', '/tmp'])
  const rel = extractEscalationTargets('cat README.md docs/a.md')
  assert.equal(rel.roots.length, 0)
  assert.equal(rel.rejected.length, 0)
})

test('含展开/转义形态的 token 不视为路径（保守丢弃）', () => {
  const { roots, rejected } = extractEscalationTargets(
    'touch "/tmp/$(id -u)/x" `echo /a/b`',
  )
  assert.equal(roots.length, 0)
  assert.equal(rejected.length, 0)
})
