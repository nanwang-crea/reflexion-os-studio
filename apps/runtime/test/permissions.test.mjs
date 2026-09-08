import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PermissionGate } from '../dist/agent/permissions.js'

test('trusted gate auto-approves workspace write and shell operations', () => {
  const gate = new PermissionGate('workspace', true, true)
  for (const operation of [
    'file.write',
    'file.edit',
    'file.delete',
    'file.move',
    'file.mkdir',
    'shell.execute',
  ]) {
    assert.equal(gate.decisionFor(operation), 'automatic', operation)
  }
  // 读取类与纯计算工具不受影响。
  assert.equal(gate.decisionFor('file.read'), 'automatic')
  assert.equal(gate.decisionFor('get_current_time'), 'automatic')
})

test('trusted gate keeps MCP and unknown tools on ask', () => {
  const gate = new PermissionGate('workspace', true, true)
  assert.equal(gate.decisionFor('some-server/some-tool'), 'ask')
  assert.equal(gate.decisionFor('totally_unknown'), 'ask')
})

test('trusted has no effect under read-only profile', () => {
  const gate = new PermissionGate('read-only', true, true)
  assert.equal(gate.decisionFor('file.write'), 'denied')
  assert.equal(gate.decisionFor('shell.execute'), 'denied')
  assert.equal(gate.decisionFor('file.read'), 'automatic')
})

test('trusted has no effect without workspace', () => {
  const gate = new PermissionGate('workspace', false, true)
  assert.equal(gate.decisionFor('file.write'), 'denied')
  assert.equal(gate.decisionFor('shell.execute'), 'denied')
})

test('default gate without trusted keeps ask decisions', () => {
  const gate = new PermissionGate('workspace', true)
  assert.equal(gate.decisionFor('file.write'), 'ask')
  assert.equal(gate.decisionFor('shell.execute'), 'ask')
})
