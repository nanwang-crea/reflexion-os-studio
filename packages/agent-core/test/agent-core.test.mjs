import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  ToolRegistry,
  boundMessagesForModel,
  compactMessages,
  estimateMessageTokens,
  estimateTokens,
  runAgentLoop,
} from '../dist/index.js'

function userMessage(content) {
  return { role: 'user', content }
}

test('loop completes a task across multiple tool turns', async () => {
  // 轮次脚本：第一轮请求工具，第二轮再请求一次，第三轮给出最终答复。
  const turns = [
    {
      content: '我先查一下时间',
      toolCalls: [{ id: 'c1', name: 'clock', arguments: '{}' }],
    },
    {
      content: '再确认一下目录',
      toolCalls: [{ id: 'c2', name: 'echo', arguments: '{"text":"hi"}' }],
    },
    { content: '任务完成', toolCalls: [] },
  ]
  const events = []
  const executed = []
  const outcome = await runAgentLoop({
    history: [{ role: 'system', content: 'sys' }, userMessage('帮我完成任务')],
    tools: [],
    signal: new AbortController().signal,
    callModel: async (messages) => {
      // 最后一轮时历史里应包含此前 assistant 工具轮 + tool 结果。
      if (turns.length === 2) {
        assert.equal(messages[messages.length - 1].role, 'tool')
      }
      return turns.shift()
    },
    executeTool: async (request) => {
      executed.push(request.name)
      return { content: `ok:${request.name}`, isError: false }
    },
    onEvent: (event) => events.push(event),
  })

  assert.equal(outcome.status, 'completed')
  assert.equal(outcome.turns, 3)
  assert.equal(outcome.finalTurn.content, '任务完成')
  assert.deepEqual(executed, ['clock', 'echo'])
  assert.deepEqual(
    events.map((event) => event.type),
    [
      'assistant.turn',
      'tool.started',
      'tool.finished',
      'assistant.turn',
      'tool.started',
      'tool.finished',
    ],
  )
  const toolMessages = outcome.messages.filter((m) => m.role === 'tool')
  assert.deepEqual(
    toolMessages.map((m) => m.content),
    ['ok:clock', 'ok:echo'],
  )
})

test('loop stops at max turns and reports exhaustion', async () => {
  let calls = 0
  const outcome = await runAgentLoop({
    history: [userMessage('loop forever')],
    tools: [],
    signal: new AbortController().signal,
    maxTurns: 3,
    callModel: async () => {
      calls += 1
      return {
        content: '',
        toolCalls: [{ id: `c${calls}`, name: 'clock', arguments: '{}' }],
      }
    },
    executeTool: () => ({ content: 'ok', isError: false }),
  })
  assert.equal(outcome.status, 'max_turns_exhausted')
  assert.equal(outcome.turns, 3)
  assert.equal(outcome.finalTurn, null)
  assert.equal(calls, 3)
})

test('loop propagates abort between turns', async () => {
  const controller = new AbortController()
  const pending = runAgentLoop({
    history: [userMessage('hi')],
    tools: [],
    signal: controller.signal,
    callModel: async () => {
      controller.abort()
      return {
        content: 'x',
        toolCalls: [{ id: 'c1', name: 'clock', arguments: '{}' }],
      }
    },
    executeTool: () => ({ content: 'ok', isError: false }),
  })
  await assert.rejects(pending, (error) => error.name === 'AbortError')
})

test('registry folds unknown tool, bad JSON and tool errors into results', async () => {
  const registry = new ToolRegistry()
  registry.register({
    name: 'echo',
    description: '回显文本',
    parameters: { type: 'object', properties: { text: { type: 'string' } } },
    execute: ({ args }) => ({
      content: `echo:${JSON.stringify(args)}`,
      isError: false,
    }),
  })
  registry.register({
    name: 'boom',
    description: '总是抛错',
    parameters: {},
    execute: () => {
      throw new Error('炸了')
    },
  })

  const signal = new AbortController().signal
  const unknown = await registry.call(
    { id: '1', name: 'nope', arguments: '{}' },
    signal,
  )
  assert.equal(unknown.isError, true)
  assert.match(unknown.content, /unknown tool/)

  const badJson = await registry.call(
    { id: '2', name: 'echo', arguments: '{oops' },
    signal,
  )
  assert.equal(badJson.isError, true)
  assert.match(badJson.content, /invalid tool arguments/)

  const ok = await registry.call(
    { id: '3', name: 'echo', arguments: '{"text":"a"}' },
    signal,
  )
  assert.deepEqual(ok, { content: 'echo:{"text":"a"}', isError: false })

  const boom = await registry.call(
    { id: '4', name: 'boom', arguments: '' },
    signal,
  )
  assert.equal(boom.isError, true)
  assert.match(boom.content, /tool failed/)

  // 空参数默认解析为空对象。
  const empty = await registry.call(
    { id: '5', name: 'echo', arguments: '' },
    signal,
  )
  assert.equal(empty.isError, false)

  assert.deepEqual(
    registry.specs().map((spec) => spec.name),
    ['echo', 'boom'],
  )
})

test('compactMessages summarizes old turns only when over budget', async () => {
  const system = { role: 'system', content: 'sys' }
  const old = []
  for (let i = 0; i < 10; i += 1) {
    old.push(userMessage(`旧消息${i}：${'很长'.repeat(200)}`))
  }
  const recent = [userMessage('最近一条')]
  const messages = [system, ...old, ...recent]

  // 预算充足：原样返回。
  const untouched = await compactMessages({
    messages,
    budgetTokens: Number.MAX_SAFE_INTEGER,
    keepRecent: 2,
    summarize: async () => {
      throw new Error('should not summarize')
    },
  })
  assert.equal(untouched.compacted, false)

  // 超预算：旧消息压成一条摘要，system 与最近消息保留。
  let summarized = null
  const result = await compactMessages({
    messages,
    budgetTokens: 100,
    keepRecent: 2,
    summarize: async (oldMessages) => {
      summarized = oldMessages
      return '这是历史摘要'
    },
  })
  assert.equal(result.compacted, true)
  assert.equal(result.summary, '这是历史摘要')
  // system + 摘要 + 最近两条（keepRecent=2）。
  assert.equal(result.messages.length, 4)
  assert.equal(result.messages[0].role, 'system')
  assert.equal(result.messages[1].role, 'user')
  assert.match(result.messages[1].content, /\[历史摘要\]/)
  assert.equal(result.messages[3], recent[0])
  assert.equal(summarized.length, 9)
})

test('estimateTokens counts CJK and ascii differently', () => {
  assert.equal(estimateTokens('一二三四'), 4)
  assert.equal(estimateTokens('abcdefgh'), 2)
})

test('loop executes parallel tool calls and preserves result order', async () => {
  const turn = {
    content: '',
    toolCalls: [
      { id: 'c1', name: 'slow', arguments: '{"ms":80,"tag":"first"}' },
      { id: 'c2', name: 'fast', arguments: '{"ms":5,"tag":"second"}' },
    ],
  }
  const active = new Set()
  const overlaps = []
  let firstCall = true
  const outcome = await runAgentLoop({
    history: [userMessage('并行执行')],
    signal: new AbortController().signal,
    callModel: async () => {
      if (firstCall) {
        firstCall = false
        return turn
      }
      return { content: '完成', toolCalls: [] }
    },
    executeTool: async (request) => {
      const args = JSON.parse(request.arguments)
      if (active.size > 0) overlaps.push([...active])
      active.add(request.name)
      await new Promise((resolve) => setTimeout(resolve, args.ms))
      active.delete(request.name)
      return { content: `ok:${request.id}`, isError: false }
    },
  })

  assert.equal(outcome.status, 'completed')
  // 两个工具真实并行（慢工具执行期间另一个工具已在运行），
  // 且结果消息按原始调用顺序回填。
  assert.equal(overlaps.length > 0, true)
  const toolMessages = outcome.messages.filter((m) => m.role === 'tool')
  assert.deepEqual(
    toolMessages.map((m) => m.content),
    ['ok:c1', 'ok:c2'],
  )
})

test('boundMessagesForModel folds oldest tool rounds to fit budget', () => {
  const system = { role: 'system', content: 'sys' }
  const messages = [
    system,
    userMessage('帮我读两个文件'),
    {
      role: 'assistant',
      content: '',
      toolCalls: [
        { id: 'c1', name: 'read', arguments: '{}' },
        { id: 'c2', name: 'read', arguments: '{}' },
      ],
    },
    {
      role: 'tool',
      toolCallId: 'c1',
      content: 'x'.repeat(4000),
      isError: false,
    },
    {
      role: 'tool',
      toolCallId: 'c2',
      content: 'y'.repeat(4000),
      isError: false,
    },
    userMessage('继续'),
  ]
  const bounded = boundMessagesForModel(messages, 2000)
  // 折叠发生：tool 消息消失，assistant 工具轮变为说明文本。
  assert.equal(
    bounded.some((m) => m.role === 'tool'),
    false,
  )
  const folded = bounded.find(
    (m) => m.role === 'assistant' && m.toolCalls.length === 0,
  )
  assert.ok(folded !== undefined)
  assert.match(folded.content, /已因上下文过长省略/)
  // 剩余消息仍以 system 开头、以最后一条 user 结尾。
  assert.equal(bounded[0], system)
  assert.equal(bounded[bounded.length - 1], messages[messages.length - 1])
  // 发给 provider 的序列合法：不存在悬空 tool 消息。
  assert.ok(estimateMessageTokens(bounded) <= 2000)
})

test('boundMessagesForModel truncates as last resort without dangling tools', () => {
  // 大量正文轮 + 一对最老的工具轮：预算极小时先折叠工具对，再截断正文。
  const messages = [
    { role: 'system', content: 'sys' },
    userMessage('介绍项目'),
    {
      role: 'assistant',
      content: '我看看。',
      toolCalls: [{ id: 'z1', name: 'read', arguments: '{}' }],
    },
    {
      role: 'tool',
      toolCallId: 'z1',
      content: 'z'.repeat(3000),
      isError: false,
    },
  ]
  for (let i = 0; i < 20; i += 1) {
    messages.push(userMessage(`补充${i}：${'长'.repeat(300)}`))
    messages.push({
      role: 'assistant',
      content: `回复${i}`,
      toolCalls: [],
    })
  }
  const bounded = boundMessagesForModel(messages, 500)
  // 序列合法：每条 tool 消息都必须能匹配到前面保留的 assistant.toolCalls。
  const toolIds = new Set()
  for (const message of bounded) {
    if (message.role === 'assistant') {
      for (const call of message.toolCalls) toolIds.add(call.id)
    }
  }
  for (const message of bounded) {
    if (message.role === 'tool') {
      assert.equal(toolIds.has(message.toolCallId), true)
    }
  }
  assert.ok(estimateMessageTokens(bounded) <= 500)
})

test('loop injects reflection message after repeated tool failures', async () => {
  const seenMessages = []
  let failsLeft = 2
  const outcome = await runAgentLoop({
    history: [userMessage('反复失败的任务')],
    signal: new AbortController().signal,
    callModel: async (messages) => {
      seenMessages.push(messages)
      if (failsLeft > 0) {
        failsLeft -= 1
        return {
          content: '',
          toolCalls: [{ id: `f${failsLeft}`, name: 'boom', arguments: '{}' }],
        }
      }
      return { content: '放弃了', toolCalls: [] }
    },
    executeTool: async () => ({
      content: '失败',
      isError: true,
      code: 'tool_error',
    }),
  })

  assert.equal(outcome.status, 'completed')
  const lastMessages = seenMessages[seenMessages.length - 1]
  const reflection = lastMessages.find(
    (message) =>
      message.role === 'user' && message.content.startsWith('[反思]'),
  )
  assert.ok(
    reflection !== undefined,
    'should inject reflection before third turn',
  )
  assert.match(reflection.content, /2 次工具调用失败/)
  assert.match(reflection.content, /boom/)
})

test('reflectionThreshold=0 disables reflection injection', async () => {
  const seenMessages = []
  let calls = 0
  await runAgentLoop({
    history: [userMessage('任务')],
    signal: new AbortController().signal,
    maxTurns: 4,
    reflectionThreshold: 0,
    callModel: async (messages) => {
      seenMessages.push(messages)
      calls += 1
      return {
        content: '',
        toolCalls: [{ id: `c${calls}`, name: 'boom', arguments: '{}' }],
      }
    },
    executeTool: async () => ({
      content: '失败',
      isError: true,
      code: 'tool_error',
    }),
  })

  for (const messages of seenMessages) {
    assert.equal(
      messages.some((message) => message.content?.startsWith('[反思]')),
      false,
    )
  }
})

test('estimateMessageTokens includes assistant tool call arguments', () => {
  const argsText = JSON.stringify({
    content: '编辑内容很长，' + '很长'.repeat(100),
  })
  const messages = [
    {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'c1', name: 'file.edit', arguments: argsText }],
    },
    { role: 'tool', toolCallId: 'c1', content: '', isError: false },
  ]
  // tool 消息 content 为空时,估算也应覆盖 arguments 文本。
  assert.equal(estimateMessageTokens(messages), estimateTokens(argsText))
  // content 与 arguments 都计入:两条相同文本叠加。
  assert.equal(
    estimateMessageTokens([
      { role: 'user', content: '文本' },
      { role: 'assistant', content: '文本', toolCalls: [] },
    ]),
    estimateTokens('文本') * 2,
  )
})
