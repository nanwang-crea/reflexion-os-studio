import assert from 'node:assert/strict'
import { test } from 'node:test'
import { InteractionGateway } from '../dist/agent/interactions/index.js'
import { RunEventEmitter } from '../dist/events.js'

const questions = [
  {
    id: 'storage',
    header: '存储方式',
    question: '选择一种存储方式',
    multiSelect: false,
    options: [
      { id: 'sqlite', label: 'SQLite', description: '本地持久化' },
      { id: 'memory', label: '内存', description: '仅当前进程' },
    ],
  },
]

function createGateway() {
  const runStatuses = []
  const toolStatuses = []
  const events = []
  const interactions = new Map()
  const gateway = new InteractionGateway({
    transaction: (fn) => fn(),
    interactions: {
      create: (entry) => {
        const stored = {
          ...entry,
          answers: null,
          status: 'pending',
          createdAt: new Date().toISOString(),
          resolvedAt: null,
        }
        interactions.set(entry.id, stored)
        return stored
      },
      get: (id) => interactions.get(id) ?? null,
      resolve: (id, answers) => {
        interactions.set(id, {
          ...interactions.get(id),
          answers,
          status: 'resolved',
        })
      },
      removePending: (id) => interactions.delete(id),
      listPending: () =>
        [...interactions.values()].filter((item) => item.status === 'pending'),
    },
    runs: {
      setIntermediateStatus: (id, status) => runStatuses.push({ id, status }),
    },
    toolCalls: {
      markStatus: (id, status) => toolStatuses.push({ id, status }),
    },
  })
  const emitter = new RunEventEmitter('run-1', (event) => events.push(event))
  return { gateway, emitter, events, runStatuses, toolStatuses }
}

test('structured question pauses the run and resumes with stable ids', async () => {
  const context = createGateway()
  const pending = context.gateway.requestQuestions({
    sessionId: 'session-1',
    runId: 'run-1',
    toolCallId: 'call-1',
    questions,
    emitter: context.emitter,
    signal: new AbortController().signal,
  })
  const required = context.events[0]
  assert.equal(required.type, 'interaction.required')
  assert.equal(required.toolCallId, 'call-1')
  assert.equal(context.gateway.hasPendingRun('run-1'), true)

  const answers = [
    {
      questionId: 'storage',
      selectedOptionIds: ['sqlite'],
    },
  ]
  assert.deepEqual(context.gateway.respond(required.interactionId, answers), {
    accepted: true,
    recovered: null,
  })
  assert.deepEqual(await pending, answers)
  assert.equal(context.gateway.hasPendingRun('run-1'), false)
  assert.deepEqual(context.runStatuses, [
    { id: 'run-1', status: 'awaiting_user_input' },
    { id: 'run-1', status: 'running' },
  ])
  assert.deepEqual(context.toolStatuses, [
    { id: 'call-1', status: 'awaiting_user_input' },
    { id: 'call-1', status: 'running' },
  ])
  assert.equal(context.events[1].type, 'interaction.resolved')
})

test('structured question rejects unknown and duplicate answer ids', async () => {
  const context = createGateway()
  const controller = new AbortController()
  const pending = context.gateway.requestQuestions({
    sessionId: 'session-1',
    runId: 'run-1',
    toolCallId: 'call-1',
    questions,
    emitter: context.emitter,
    signal: controller.signal,
  })
  const interactionId = context.events[0].interactionId
  assert.deepEqual(
    context.gateway.respond(interactionId, [
      { questionId: 'missing', selectedOptionIds: ['sqlite'] },
    ]),
    { accepted: false },
  )
  assert.deepEqual(
    context.gateway.respond(interactionId, [
      { questionId: 'storage', selectedOptionIds: ['missing'] },
    ]),
    { accepted: false },
  )
  controller.abort()
  await assert.rejects(pending, { name: 'AbortError' })
})
