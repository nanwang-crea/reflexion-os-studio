import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { build } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const output = mkdtempSync(join(tmpdir(), 'tool-groups-'))
after(() => rmSync(output, { recursive: true, force: true }))
const outfile = join(output, 'groups.mjs')
await build({
  absWorkingDir: root,
  stdin: {
    contents: `
      import { createElement } from 'react'
      import { renderToStaticMarkup } from 'react-dom/server'
      import { RunBlock } from './frontend/features/chat/run/RunBlock'
      export { buildChatBlocks } from './frontend/features/chat/chat-blocks'
      export const renderRun = props => renderToStaticMarkup(createElement(RunBlock, props))
      import { RunProcess } from './frontend/features/chat/run/RunProcess'
      export { groupToolCalls, describeToolGroup } from './frontend/features/chat/message/tool-groups'
      export const render = props => renderToStaticMarkup(createElement(RunProcess, props))
    `,
    resolveDir: root,
  },
  bundle: true,
  jsx: 'automatic',
  format: 'esm',
  platform: 'node',
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
  outfile,
})
const {
  groupToolCalls,
  describeToolGroup,
  render,
  renderRun,
  buildChatBlocks,
} = await import(pathToFileURL(outfile).href)
const call = (id, toolName, path, status = 'completed', errorCode = null) => ({
  id,
  toolName,
  args: { path },
  status,
  errorCode,
  output: null,
  result: null,
})

test('active, failed, approval and cancelled calls stay outside groups', () => {
  for (const status of [
    'running',
    'pending',
    'awaiting_approval',
    'awaiting_user_input',
    'failed',
    'cancelled',
  ]) {
    const groups = groupToolCalls([
      call('1', 'file.read', 'a'),
      call('2', 'file.read', 'b'),
      call('3', 'file.read', 'c', status),
      call('4', 'file.read', 'd'),
    ])
    assert.deepEqual(
      groups.map((group) => group.kind),
      ['read', 'single', 'single'],
    )
  }
  assert.equal(
    groupToolCalls([call('1', 'file.read', 'a', 'completed', 'ERROR')])[0].kind,
    'single',
  )
})

test('summaries count unique files and repeated edits', () => {
  const reads = groupToolCalls([
    call('1', 'file.read', 'a'),
    call('2', 'file.read', 'a'),
    call('3', 'file.grep', 'b'),
  ])
  assert.equal(describeToolGroup(reads[0]), '查看了 1 个文件 · 搜索了 1 次')
  const edits = groupToolCalls([
    call('1', 'file.edit', 'a'),
    call('2', 'file.edit', 'a'),
  ])
  assert.equal(describeToolGroup(edits[0]), '已修改 a · 2 次操作')
})

test('invisible message boundaries merge but commentary separates groups', () => {
  const item = (id, content, calls) => ({
    message: { id, content, reasoning: '' },
    toolCalls: calls,
  })
  const props = { streaming: {}, streamingReasoning: {}, runActive: false }
  const first = item('1', '', [call('1', 'file.read', 'a')])
  const last = item('3', '', [call('3', 'file.read', 'b')])
  assert.match(render({ ...props, items: [first, last] }), /查看了 2 个文件/)
  const separated = render({
    ...props,
    items: [first, item('2', '调查完成', []), last],
  })
  assert.doesNotMatch(separated, /查看了 2 个文件/)
  assert.match(separated, /调查完成/)
})

test('consecutive commands, web, directories and skills collapse without inferring outcomes', () => {
  for (const [tool, kind, label] of [
    ['shell.execute', 'command', '执行了 2 条命令'],
    ['web.fetch', 'web', '抓取了 2 次网页'],
    ['file.mkdir', 'directory', '完成了 2 次目录创建'],
    ['skill.use', 'skill', '加载了 2 次技能'],
  ]) {
    const groups = groupToolCalls([call('1', tool, 'a'), call('2', tool, 'b')])
    assert.equal(groups.length, 1)
    assert.equal(groups[0].kind, kind)
    assert.equal(describeToolGroup(groups[0]), label)
    assert.equal(groupToolCalls([call('1', tool, 'a')])[0].kind, 'single')
    for (const status of [
      'running',
      'failed',
      'cancelled',
      'awaiting_approval',
    ]) {
      const interrupted = groupToolCalls([
        call('1', tool, 'a'),
        call('2', tool, 'b', status),
        call('3', tool, 'c'),
      ])
      assert.deepEqual(
        interrupted.map((group) => group.kind),
        ['single', 'single', 'single'],
      )
    }
  }
})

test('operation changes, deletions and moves break aggregation', () => {
  const groups = groupToolCalls([
    call('1', 'shell.execute', 'a'),
    call('2', 'shell.execute', 'b'),
    call('3', 'file.delete', 'c'),
    call('4', 'file.move', 'd'),
    call('5', 'web.fetch', 'e'),
    call('6', 'web.fetch', 'f'),
    call('7', 'file.write', 'g'),
    call('8', 'file.edit', 'g'),
  ])
  assert.deepEqual(
    groups.map((group) => group.kind),
    ['command', 'single', 'single', 'web', 'edit'],
  )
  assert.equal(describeToolGroup(groups.at(-1)), '已修改 g · 2 次操作')
})

test('successful time lookup is kept in collapsed auxiliary details', () => {
  const props = {
    streaming: {},
    streamingReasoning: {},
    runActive: false,
    items: [
      {
        message: { id: 'm', content: '', reasoning: '' },
        toolCalls: [call('1', 'get_current_time', '')],
      },
    ],
  }
  const html = render(props)
  assert.match(html, /<details class="tool-trace-group time"/)
  assert.match(html, /辅助操作/)
  assert.match(html, /获取时间/)
  assert.equal(
    groupToolCalls([call('1', 'get_current_time', '', 'failed')])[0].kind,
    'single',
  )
})

test('final answer remains unique while completed message streaming buffers are retained', () => {
  const finalMessage = {
    id: 'final',
    role: 'assistant',
    runId: 'r',
    status: 'completed',
    content: 'UniqueAnswer',
    reasoning: 'UniqueThought',
    parts: [],
  }
  const messages = [
    { id: 'tool', role: 'assistant', runId: 'r', content: '', reasoning: '' },
    finalMessage,
  ]
  const blocks = buildChatBlocks(
    messages,
    new Map([['tool', [call('read', 'file.read', 'a')]]]),
  )
  assert.equal(blocks.length, 1)
  const block = blocks[0]
  assert.equal(block.finalItem.message.id, 'final')
  assert.deepEqual(
    block.processItems.map((item) => item.message.id),
    ['tool'],
  )
  for (const streaming of [{}, { final: 'UniqueAnswer' }]) {
    const html = renderRun({
      ...block,
      delegations: [],
      runActive: true,
      streaming,
      streamingReasoning: { final: 'UniqueThought' },
      runDurationMs: null,
      runUsage: null,
      runFailed: false,
      canRetry: false,
      onRetry() {},
      projectId: 'p',
    })
    assert.equal((html.match(/UniqueAnswer/g) ?? []).length, 1)
    assert.equal((html.match(/UniqueThought/g) ?? []).length, 1)
  }
})

test('process commentary resource links use the same controlled file routing as final answers', () => {
  const html = renderRun({
    processItems: [
      {
        message: {
          id: 'process',
          content: '[file](workspace:///src/a.ts#L3)',
          reasoning: '',
        },
        toolCalls: [],
      },
    ],
    finalItem: null,
    delegations: [],
    runActive: true,
    streaming: {},
    streamingReasoning: {},
    runDurationMs: null,
    runUsage: null,
    runFailed: false,
    canRetry: false,
    onRetry() {},
    onResourceClick() {},
    projectId: 'p',
  })
  assert.match(
    html,
    /<button[^>]*class="md-resource md-resource-workspaceFile"/,
  )
  assert.doesNotMatch(html, /href="workspace:/)
})

test('historical final messages repair proven line fragments during rendering', () => {
  for (const [source, expected] of [
    ['src/a.ts#L3-L5', 'workspace://p/src/a.ts#L3'],
    ['src/a.ts%23L3-L5', 'workspace://p/src/a.ts%23L3-L5'],
  ]) {
    const html = renderRun({
      processItems: [],
      finalItem: {
        message: {
          id: 'final',
          status: 'completed',
          reasoning: '',
          content: `[file](${source})`,
          parts: [
            {
              type: 'resource_link',
              label: 'file',
              link: {
                kind: 'workspaceFile',
                projectId: 'p',
                path: 'src/a.ts#L3-L5',
                uri: 'workspace://p/src/a.ts%23L3-L5',
              },
            },
          ],
        },
        toolCalls: [],
      },
      delegations: [],
      runActive: false,
      streaming: {},
      streamingReasoning: {},
      runDurationMs: null,
      runUsage: null,
      runFailed: false,
      canRetry: false,
      onRetry() {},
      onResourceClick() {},
      projectId: 'p',
    })
    assert.ok(html.includes(`title="${expected}"`))
    assert.match(html, /class="md-resource md-resource-workspaceFile"/)
  }
})
