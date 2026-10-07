import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'

const result = await build({
  stdin: {
    contents: `export { useWorkspacePanel } from './frontend/hooks/workspace/useWorkspacePanel.ts'
      export { useDataRefreshers } from './frontend/hooks/useDataRefreshers.ts'
      export { FileViewerPanel } from './frontend/features/workspace/files/FileViewerPanel.tsx'`,
    resolveDir: fileURLToPath(new URL('..', import.meta.url)),
  },
  bundle: true,
  format: 'esm',
  write: false,
  jsx: 'automatic',
  plugins: [
    {
      name: 'controlled-ui',
      setup(build) {
        build.onResolve(
          {
            filter:
              /^react(\/jsx-runtime)?$|lib\/transport$|api\/(sessions|providers|projects|agents)$|ui\/icons$|\.\/(ContentView|FileTabs)$|\/git\/DiffViewer$|\/preview\/(MarkdownFilePreview|BinaryFilePreview)$/,
          },
          (args) => ({ path: args.path, namespace: 'mock' }),
        )
        build.onLoad({ filter: /.*/, namespace: 'mock' }, (args) => ({
          contents:
            args.path === 'react'
              ? `export const useState=(...a)=>globalThis.uiHarness.state(...a); export const useRef=(...a)=>globalThis.uiHarness.ref(...a); export const useCallback=f=>f; export const useEffect=()=>{}; export const useImperativeHandle=()=>{};`
              : args.path === 'react/jsx-runtime'
                ? `export const jsx=(type,props,key)=>({type,props,key}); export const jsxs=jsx;`
                : args.path.endsWith('transport')
                  ? `export const transport={onEvent:()=>()=>{}};`
                  : args.path.includes('/api/')
                    ? `export const listSessions=id=>globalThis.uiHarness.request('project',id); export const listDelegations=id=>globalThis.uiHarness.request('delegation',id); export const getSessionData=id=>globalThis.uiHarness.request('session',id); export const listProviders=()=>{}; export const listProjects=()=>{};`
                    : `export const ContentView='content'; export const FileTabs='tabs'; export const DiffViewer='diff'; export const MarkdownFilePreview='markdown'; export const BinaryFilePreview='binary'; export const FolderIcon='folder';`,
        }))
      },
    },
  ],
})
const { useWorkspacePanel, useDataRefreshers, FileViewerPanel } = await import(
  'data:text/javascript;base64,' +
    Buffer.from(result.outputFiles[0].text).toString('base64')
)
function harness() {
  const slots = []
  let cursor = 0
  const pending = []
  const h = {
    state(initial) {
      const index = cursor++
      if (!(index in slots))
        slots[index] = typeof initial === 'function' ? initial() : initial
      return [
        slots[index],
        (value) => {
          slots[index] =
            typeof value === 'function' ? value(slots[index]) : value
        },
      ]
    },
    ref(initial) {
      const index = cursor++
      return (slots[index] ??= { current: initial })
    },
    request(kind, id) {
      return new Promise((resolve) => pending.push({ kind, id, resolve }))
    },
    render(callback) {
      globalThis.uiHarness = h
      cursor = 0
      return callback()
    },
    pending,
  }
  return h
}
function pageKey(tree) {
  for (const node of [tree.props.children].flat(Infinity)) {
    if (node?.props?.className === 'workspace-tab-page') return node.key
  }
}
test('脏文件行号跳转保持挂载 key，只有显式重载更新 key', () => {
  globalThis.localStorage = { getItem: () => null }
  const h = harness()
  const render = () => h.render(() => useWorkspacePanel('project-a'))
  const key = (state) =>
    pageKey(
      FileViewerPanel({
        project: { id: 'project-a' },
        openTabs: state.openTabs,
        activeTabId: 'a.ts',
        dirtyPaths: state.dirtyPaths,
        systemReady: true,
      }),
    )
  let state = render()
  state.openFile('a.ts')
  state = render()
  state.setTabDirty('a.ts', true)
  state = render()
  const originalKey = key(state)
  state.openFile('a.ts', 12)
  state = render()
  assert.equal(key(state), originalKey)
  assert.equal(state.openTabs[0].line, 12)
  assert.equal(state.dirtyPaths.has('a.ts'), true)
  state.reloadAllTextTabs()
  state = render()
  assert.notEqual(key(state), originalKey)
})

test('项目和委派乱序响应、清空会话后的旧响应不会覆盖当前状态', async () => {
  const h = harness()
  const shown = {}
  const noop = () => {}
  const deps = {
    activeProjectId: 'A',
    activeSessionId: 'a',
    sessionRequestRef: { current: 0 },
    setSessionData: (v) => {
      shown.session = v
    },
    setProjectSessions: (v) => {
      shown.project = v
    },
    setDelegations: (v) => {
      shown.delegation = v
    },
    setProfiles: noop,
    setProjects: noop,
    setStandaloneSessions: noop,
  }
  let refresh = h.render(() => useDataRefreshers(deps))
  const oldProject = refresh.refreshProjectSessions('A')
  const oldDelegation = refresh.refreshDelegations('a')
  deps.activeProjectId = 'B'
  deps.activeSessionId = 'b'
  refresh = h.render(() => useDataRefreshers(deps))
  const newProject = refresh.refreshProjectSessions('B')
  const newDelegation = refresh.refreshDelegations('b')
  h.pending.find((p) => p.id === 'B').resolve({ sessions: ['B'] })
  h.pending.find((p) => p.id === 'b').resolve(['b'])
  await Promise.all([newProject, newDelegation])
  h.pending.find((p) => p.id === 'A').resolve({ sessions: ['A'] })
  h.pending.find((p) => p.id === 'a').resolve(['a'])
  await Promise.all([oldProject, oldDelegation])
  assert.deepEqual(shown.project, ['B'])
  assert.deepEqual(shown.delegation, ['b'])
  const oldSession = refresh.refreshSessionData('b')
  deps.activeSessionId = null
  h.render(() => useDataRefreshers(deps))
  h.pending.find((p) => p.kind === 'session').resolve('old session')
  await oldSession
  assert.equal(shown.session, undefined)
})
