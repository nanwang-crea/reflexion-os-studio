import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { browserWorkerPaths } from '../../runtime/dist/browser/agent/paths.js'
const require = createRequire(
  new URL('../../runtime/package.json', import.meta.url),
)
process.env.PLAYWRIGHT_BROWSERS_PATH = browserWorkerPaths().browsers
const { chromium } = require('playwright')

test('Git status discards obsolete responses and cancels queued refreshes on scope changes', async () => {
  const root = fileURLToPath(new URL('..', import.meta.url))
  const built = await build({
    absWorkingDir: root,
    stdin: {
      contents: `import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
import {useWorkspaceGitStatus} from './frontend/hooks/workspace/useWorkspaceGitStatus';
window.requests=[];window.events=new Set();
function App(){const [scope,setScope]=useState({projectId:'a',systemReady:true});window.selectScope=setScope;window.scope=scope;window.gitState=useWorkspaceGitStatus(scope.projectId,scope.systemReady);return null}
window.root=createRoot(document.getElementById('root'));root.render(<App/>);`,
      resolveDir: root,
      loader: 'tsx',
    },
    bundle: true,
    format: 'iife',
    jsx: 'automatic',
    write: false,
    plugins: [
      {
        name: 'scope-boundaries',
        setup(build) {
          build.onResolve(
            { filter: /api\/workspace$|lib\/transport$/ },
            ({ path }) => ({ path, namespace: 'fixture' }),
          )
          build.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({
            contents: path.endsWith('/workspace')
              ? `export const gitStatus=projectId=>new Promise(resolve=>requests.push({projectId,resolve}))`
              : `export const transport={onEvent:fn=>{events.add(fn);return ()=>events.delete(fn)}}`,
          }))
        },
      },
    ],
  })
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    await page.setContent('<!doctype html><main id="root"></main>')
    await page.addScriptTag({ content: built.outputFiles[0].text })
    await page.waitForFunction(() => requests.length === 1)
    await page.evaluate(() => {
      window.oldRefresh = gitState.refresh
      selectScope({ projectId: null, systemReady: true })
    })
    await page.waitForFunction(() => window.scope.projectId === null)
    await page.evaluate(async () => {
      requests[0].resolve({ branch: 'stale-a' })
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    assert.equal(await page.evaluate(() => gitState.snapshot), null)
    await page.evaluate(() =>
      selectScope({ projectId: 'b', systemReady: true }),
    )
    await page.waitForFunction(() => requests.length === 2)
    await page.evaluate(() => {
      for (const fn of events) fn({ type: 'workspace.changed', projectId: 'b' })
      selectScope({ projectId: 'b', systemReady: false })
    })
    await page.waitForFunction(() => gitState.snapshot === null)
    await page.evaluate(async () => {
      requests[1].resolve({ branch: 'stale-b' })
      await new Promise((resolve) => setTimeout(resolve, 350))
    })
    assert.equal(
      await page.evaluate(() => requests.length),
      2,
      'pending debounce must not start a stale request',
    )
    assert.equal(await page.evaluate(() => gitState.snapshot), null)
    await page.evaluate(() =>
      selectScope({ projectId: 'c', systemReady: true }),
    )
    await page.waitForFunction(() => requests.length === 3)
    assert.equal(
      await page.evaluate(async () => {
        try {
          await window.oldRefresh()
          return false
        } catch {
          return true
        }
      }),
      true,
      'an old action callback must not invalidate the current request',
    )
    assert.equal(await page.evaluate(() => requests.length), 3)
    await page.evaluate(() => requests[2].resolve({ branch: 'current-c' }))
    await page.waitForFunction(() => gitState.snapshot?.branch === 'current-c')
    assert.equal(await page.evaluate(() => events.size), 1)
    await page.evaluate(() => root.unmount())
    assert.equal(await page.evaluate(() => events.size), 0)
  } finally {
    await browser.close()
  }
})
