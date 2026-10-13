import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  canTransitionWorkflowRun,
  canTransitionWorkflowAttempt,
} from '../../dist/workflow/execution/state.js'

test('cancelled runs cannot publish success and interrupted attempts cannot revive', () => {
  assert.equal(canTransitionWorkflowRun('running', 'cancelling'), true)
  assert.equal(canTransitionWorkflowRun('cancelling', 'succeeded'), false)
  assert.equal(canTransitionWorkflowRun('cancelled', 'running'), false)
  assert.equal(canTransitionWorkflowRun('interrupted', 'running'), true)
  assert.equal(canTransitionWorkflowAttempt('running', 'interrupted'), true)
  assert.equal(canTransitionWorkflowAttempt('interrupted', 'running'), false)
  assert.equal(canTransitionWorkflowAttempt('succeeded', 'failed'), false)
})

test('human rejection is terminal and confirmations cannot begin Agent execution', () => {
  assert.equal(canTransitionWorkflowAttempt('pending', 'waiting_user'), true)
  assert.equal(canTransitionWorkflowAttempt('waiting_user', 'running'), false)
  assert.equal(canTransitionWorkflowAttempt('waiting_user', 'rejected'), true)
  assert.equal(canTransitionWorkflowAttempt('rejected', 'succeeded'), false)
})
