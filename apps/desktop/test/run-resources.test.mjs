import assert from 'node:assert/strict'
import { test, after } from 'node:test'
import { build } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const output = mkdtempSync(join(tmpdir(), 'run-resources-'))
after(() => rmSync(output, { recursive: true, force: true }))
const outfile = join(output, 'resources.mjs')
await build({
  absWorkingDir: root,
  stdin: {
    contents: `
      import { createElement } from 'react'
      import { renderToStaticMarkup } from 'react-dom/server'
      import { ChangedFiles, aggregateChangedFiles } from './frontend/features/chat/run/ChangedFiles'
      export { ChangedFiles, aggregateChangedFiles }
      export const renderChanges = props => renderToStaticMarkup(createElement(ChangedFiles, {
        ...props, files: aggregateChangedFiles(props.items, props.finalItem),
      }))
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
const { aggregateChangedFiles, renderChanges, ChangedFiles } = await import(
  pathToFileURL(outfile).href
)

const item = (toolCalls = [], parts = [], status = 'completed') => ({
  message: { parts, content: '', status },
  toolCalls,
})
const change = (id, path, action = 'modified', extra = {}) => ({
  id,
  toolName: 'file.write',
  status: 'completed',
  output: { changedFiles: [{ path, action, ...extra }], resourceLinks: [] },
})
const reference = (path) => ({
  type: 'resource_link',
  label: path,
  link: {
    kind: 'workspaceFile',
    projectId: 'project',
    path,
    uri: `workspace://project/${path}`,
  },
})

function buttonsIn(node) {
  if (!node || typeof node !== 'object') return []
  return [
    ...(node.type === 'button' ? [node] : []),
    ...[node.props?.children].flat(Infinity).flatMap(buttonsIn),
  ]
}

test('one file list retains every changed document, image and source despite answer references', () => {
  const paths = [
    'report.md',
    'result.pdf',
    'chart.png',
    'data.csv',
    'slides.pptx',
    'main.ts',
  ]
  const props = {
    projectId: 'project',
    items: [item(paths.map((path) => change(path, path)))],
    finalItem: item([], paths.map(reference)),
  }
  const files = aggregateChangedFiles(props.items, props.finalItem)
  assert.deepEqual(
    files.map((file) => file.path),
    paths,
  )
  const html = renderChanges(props)
  assert.match(html, /变更了 6 个文件/)
  assert.equal((html.match(/class="changed-file"/g) ?? []).length, 6)
  assert.doesNotMatch(html, /<details[^>]*\sopen/)
})

test('ordinary file and asset references alone never create a changed file list', () => {
  const finalItem = item(
    [],
    [
      reference('existing.pdf'),
      {
        type: 'resource_link',
        label: '图片',
        link: { kind: 'asset', assetId: 'image', uri: 'asset://image' },
      },
    ],
  )
  assert.deepEqual(aggregateChangedFiles([], finalItem), [])
  assert.equal(
    renderChanges({ projectId: 'project', items: [], finalItem }),
    '',
  )
})

test('repeated tool occurrences and cross-platform path aliases have one latest entry', () => {
  const first = change('first', 'reports\\report.md')
  const last = change('last', './reports/report.md', 'modified', {
    after: 'latest',
  })
  const files = aggregateChangedFiles([item([first, last])], item([last]))
  assert.equal(files.length, 1)
  assert.equal(files[0].after, 'latest')
})

test('canonical changes from other tools are kept, failed calls are excluded', () => {
  const files = aggregateChangedFiles(
    [
      item([
        { ...change('shell', 'report.pdf'), toolName: 'shell.execute' },
        { ...change('failed', 'failed.pdf'), status: 'failed' },
      ]),
    ],
    null,
  )
  assert.deepEqual(
    files.map((file) => file.path),
    ['report.pdf'],
  )
})

test('moves are one entry, deleted files remain reviewable, and recreated old paths return', () => {
  const calls = [
    change('first', 'old.md'),
    change('move', 'new.md', 'moved', { oldPath: 'old.md' }),
    change('delete', 'deleted.pdf', 'deleted'),
  ]
  assert.deepEqual(
    aggregateChangedFiles([item(calls)], null).map((file) => file.path),
    ['new.md', 'deleted.pdf'],
  )
  calls.push(change('recreate', 'old.md', 'created'))
  assert.deepEqual(
    aggregateChangedFiles([item(calls)], null).map((file) => file.path),
    ['new.md', 'deleted.pdf', 'old.md'],
  )
})

test('historical results and successful partial changes survive interrupted or failed replies', () => {
  const legacy = {
    id: 'legacy',
    toolName: 'file.write',
    status: 'completed',
    args: { path: 'report.md' },
    result: { ok: true },
  }
  for (const status of ['streaming', 'failed', 'interrupted']) {
    const files = aggregateChangedFiles(
      [item([legacy])],
      item([], [reference('report.md')], status),
    )
    assert.equal(files.length, 1)
    assert.equal(files[0].path, 'report.md')
  }
})

test('changed files open snapshot or Git Diff on click, with file fallback only without a handler', () => {
  const file = {
    path: 'report.md',
    action: 'moved',
    oldPath: 'old.md',
    before: 'before',
    after: 'after',
  }
  const gitFile = { path: 'src/main.ts', action: 'modified' }
  const clicked = []
  const props = {
    projectId: 'project',
    files: [file],
    onResourceClick: (link) => clicked.push(link),
    onOpenDiff: (path, options) => clicked.push({ path, options }),
  }
  buttonsIn(ChangedFiles(props))[0].props.onClick()
  buttonsIn(ChangedFiles({ ...props, files: [gitFile] }))[0].props.onClick()
  buttonsIn(
    ChangedFiles({ ...props, onOpenDiff: undefined }),
  )[0].props.onClick()
  assert.deepEqual(clicked, [
    {
      path: 'report.md',
      options: {
        source: 'chat',
        oldPath: 'old.md',
        before: 'before',
        after: 'after',
      },
    },
    {
      path: 'src/main.ts',
      options: {
        source: 'chat',
      },
    },
    reference('report.md').link,
  ])
})
