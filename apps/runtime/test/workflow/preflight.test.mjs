import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  effectiveNodePolicy,
  preflightWorkflow,
} from '../../dist/workflow/execution/preflight.js'
import { workflowFixture } from '../../../../packages/contracts/test/fixtures/workflow.mjs'

const provider = {
  id: 'provider',
  enabled: true,
  capabilities: ['chat'],
  models: ['text-model'],
}
const input = {
  providers: [provider],
  defaultModel: { providerId: 'provider', model: 'text-model' },
  availableTools: new Set([
    'file.read',
    'file.write',
    'task',
    'memory.remember',
  ]),
}

test('resolves mixed default/explicit models and rejects media-only profiles', () => {
  const flow = workflowFixture()
  flow.nodes[1].model = {
    mode: 'explicit',
    providerId: 'other',
    model: 'review-model',
  }
  const result = preflightWorkflow(flow, {
    ...input,
    providers: [
      provider,
      { ...provider, id: 'other', models: ['review-model'] },
    ],
  })
  assert.equal(result.issues.length, 0)
  assert.deepEqual(
    result.models.map((model) => model.model),
    ['text-model', 'review-model'],
  )
  assert.equal(preflightWorkflow(flow, input).models.length, 0)
  assert.equal(
    preflightWorkflow(workflowFixture(), {
      ...input,
      providers: [{ ...provider, capabilities: ['image'] }],
    }).issues.length,
    2,
  )
})

test('effective node policy intersects tools/preset and excludes delegation/management', () => {
  const node = workflowFixture().nodes[0]
  node.role.policy.allowedTools = [
    'file.read',
    'file.write',
    'task',
    'memory.remember',
    'missing/tool',
  ]
  assert.deepEqual(
    effectiveNodePolicy(node, 'workspace-full', input.availableTools),
    {
      permissionPreset: 'workspace-read',
      allowedTools: ['file.read', 'file.write'],
      canDelegate: false,
    },
  )
  node.role.policy.permissionCeiling = 'workspace-full'
  assert.equal(
    effectiveNodePolicy(node, 'workspace-read', input.availableTools)
      .permissionPreset,
    'workspace-read',
  )
  const flow = workflowFixture()
  flow.nodes[0] = node
  const codes = preflightWorkflow(flow, input).issues.map((issue) => issue.code)
  assert.ok(codes.includes('tool_unavailable'))
})
