import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'

const compiled = await build({
  entryPoints: [
    fileURLToPath(
      new URL(
        '../frontend/features/workspace/git/GitChanges.tsx',
        import.meta.url,
      ),
    ),
  ],
  bundle: true,
  format: 'esm',
  write: false,
  jsx: 'automatic',
  plugins: [
    {
      name: 'git-ui-harness',
      setup(build) {
        build.onResolve(
          {
            filter:
              /^react(\/jsx-runtime)?$|api\/workspace$|^\.\/(GitInstallNotice|BranchPicker|GitChangeList|GitCommitBox|GitSourceTabs|useAgentChanges)$/,
          },
          (args) => ({ path: args.path, namespace: 'mock' }),
        )
        build.onLoad({ filter: /.*/, namespace: 'mock' }, (args) => ({
          contents:
            args.path === 'react'
              ? `export const useState=(v)=>globalThis.gitHarness.state(v); export const useRef=(v)=>globalThis.gitHarness.ref(v); export const useEffect=(f)=>globalThis.gitHarness.effect(f); export const useCallback=f=>f;`
              : args.path === 'react/jsx-runtime'
                ? `export const jsx=(type,props)=>({type,props}); export const jsxs=jsx; export const Fragment='fragment';`
                : args.path.endsWith('api/workspace')
                  ? `export const gitBranches=()=>globalThis.gitHarness.request('branches'); export const gitRemotes=()=>globalThis.gitHarness.request('remotes'); export const gitStage=()=>globalThis.gitHarness.request('stage'); export const gitUnstage=()=>globalThis.gitHarness.request('unstage'); export const gitFetch=()=>globalThis.gitHarness.request('fetch'); export const gitCommit=()=>{}; export const gitPush=()=>{}; export const gitPull=()=>{}; export const gitBranchCreate=()=>{}; export const gitBranchSwitch=()=>{}; export const gitRemoteAdd=()=>{}; export const gitRemoteRemove=()=>{};`
                  : args.path.endsWith('useAgentChanges')
                    ? `export const useAgentChanges=()=>({entries:[],refresh:async()=>{}});`
                    : `export const ${args.path.slice(2)}='${args.path.slice(2)}';`,
        }))
      },
    },
  ],
})
const { GitChanges } = await import(
  'data:text/javascript;base64,' +
    Buffer.from(compiled.outputFiles[0].text).toString('base64')
)
const status = {
  repo: true,
  entries: [{ path: 'file.txt', status: 'modified', staged: false }],
  truncated: false,
  branch: 'main',
  ahead: 0,
  behind: 0,
}
function harness() {
  const slots = []
  let cursor = 0
  let mounted = false
  const effects = []
  const calls = []
  const h = {
    fail: false,
    state(initial) {
      const i = cursor++
      if (!(i in slots)) slots[i] = initial
      return [
        slots[i],
        (v) => {
          slots[i] = typeof v === 'function' ? v(slots[i]) : v
        },
      ]
    },
    ref(initial) {
      const i = cursor++
      return (slots[i] ??= { current: initial })
    },
    effect(f) {
      if (!mounted) effects.push(f)
    },
    async request(kind) {
      calls.push(kind)
      if (kind === 'stage' && h.fail)
        throw new Error('index.lock: permission denied')
      if (kind === 'branches') return { branches: ['main'], remoteBranches: [] }
      if (kind === 'remotes') return { remotes: [] }
      if (kind === 'stage')
        status.entries = [
          { path: 'file.txt', status: 'modified', staged: true },
        ]
      return status
    },
    render() {
      globalThis.gitHarness = h
      cursor = 0
      return GitChanges({
        projectId: 'project',
        activeSessionId: null,
        systemReady: true,
        statusSnapshot: null,
        loadGitStatus: () => h.request('status'),
        guardDirtyBuffersThen: async () => true,
        onOpenFile: () => {},
      })
    },
    async mount() {
      h.render()
      mounted = true
      for (const effect of effects) effect()
      await settle()
    },
    calls,
  }
  return h
}
async function settle() {
  await new Promise((resolve) => setImmediate(resolve))
}
function nodes(tree) {
  if (!tree || typeof tree !== 'object') return []
  const children = tree.props?.children
  return [
    tree,
    ...(Array.isArray(children) ? children : [children]).flatMap(nodes),
  ]
}

test('opening and staging only refresh local status; no implicit network fetch', async () => {
  const h = harness()
  await h.mount()
  assert.deepEqual(h.calls, ['status', 'branches', 'remotes'])
  const list = nodes(h.render()).find((node) => node.type === 'GitChangeList')
  h.calls.length = 0
  list.props.onStagePaths(['file.txt'])
  await settle()
  assert.deepEqual(h.calls, ['stage', 'status'])
  const updated = nodes(h.render()).find(
    (node) => node.type === 'GitChangeList',
  )
  assert.equal(updated.props.entries[0].staged, true)
  assert.equal(updated.props.busy, false)
})
test('stage failure remains visible after refresh, and busy state is released', async () => {
  const h = harness()
  h.fail = true
  await h.mount()
  nodes(h.render())
    .find((node) => node.type === 'GitChangeList')
    .props.onStagePaths(['file.txt'])
  await settle()
  const rendered = nodes(h.render())
  assert.ok(
    rendered.some(
      (node) =>
        node.type === 'strong' &&
        node.props.children === 'index.lock: permission denied',
    ),
  )
  assert.equal(
    rendered.find((node) => node.type === 'GitChangeList').props.busy,
    false,
  )
})

const apiBuild = await build({
  entryPoints: [
    fileURLToPath(new URL('../frontend/api/workspace.ts', import.meta.url)),
  ],
  bundle: true,
  format: 'esm',
  write: false,
  plugins: [
    {
      name: 'capture-transport',
      setup(build) {
        build.onResolve({ filter: /lib\/transport$/ }, (args) => ({
          path: args.path,
          namespace: 'transport',
        }))
        build.onLoad({ filter: /.*/, namespace: 'transport' }, () => ({
          contents: `export const newRequestId=()=> 'request'; export const transport={request:async(...args)=>{globalThis.gitApiCalls.push(args); return {ok:true}},onEvent:()=>()=>{}};`,
        }))
      },
    },
  ],
})
const api = await import(
  'data:text/javascript;base64,' +
    Buffer.from(apiBuild.outputFiles[0].text).toString('base64')
)
test('Git write deadlines reach transport and exceed backend execution deadlines', async () => {
  globalThis.gitApiCalls = []
  await api.gitStage('project', ['file.txt'])
  await api.gitUnstage('project', ['file.txt'])
  await api.gitPush('project')
  await api.gitPull('project')
  await api.gitFetch('project')
  assert.deepEqual(
    globalThis.gitApiCalls.map(([method, , timeout]) => [method, timeout]),
    [
      ['workspace.git_stage', 45000],
      ['workspace.git_unstage', 45000],
      ['workspace.git_push', 140000],
      ['workspace.git_pull', 140000],
      ['workspace.git_fetch', 140000],
    ],
  )
  assert.deepEqual(globalThis.gitApiCalls[0][1], {
    requestId: 'request',
    projectId: 'project',
    paths: ['file.txt'],
  })
  delete globalThis.gitApiCalls
})
