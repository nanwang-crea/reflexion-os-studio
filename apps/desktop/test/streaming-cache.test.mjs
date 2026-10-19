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

test('stream cleanup removes body and reasoning together without pruning a newer run', async () => {
  const root = fileURLToPath(new URL('..', import.meta.url))
  const built = await build({
    absWorkingDir: root,
    stdin: {
      contents: `import React from 'react'; import {createRoot} from 'react-dom/client';
import {useStreamingCache} from './frontend/hooks/session/useStreamingCache';
function App(){window.cache=useStreamingCache();return null}
createRoot(document.getElementById('root')).render(<App/>);`,
      resolveDir: root,
      loader: 'tsx',
    },
    bundle: true,
    format: 'iife',
    jsx: 'automatic',
    write: false,
  })
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    await page.setContent('<!doctype html><main id="root"></main>')
    await page.addScriptTag({ content: built.outputFiles[0].text })
    await page.waitForFunction(() => window.cache)
    await page.evaluate(() => {
      cache.applyDelta('old', 'run1', 'answer')
      cache.applyReasoningDelta('old', 'run1', 'thought')
      cache.applyDelta('other', 'run2', 'unrelated')
      cache.applyReasoningDelta('other', 'run2', 'other thought')
    })
    await page.waitForFunction(() => cache.streamingReasoning.old === 'thought')
    await page.evaluate(() => cache.collectStalePrune('run1')())
    await page.waitForFunction(() => !cache.streaming.old)
    assert.deepEqual(
      await page.evaluate(() => ({
        body: cache.streaming,
        reasoning: cache.streamingReasoning,
      })),
      { body: { other: 'unrelated' }, reasoning: { other: 'other thought' } },
    )

    // A delayed refresh from an old run must not clear a reused message id.
    await page.evaluate(() => {
      cache.applyDelta('reused', 'old-run', 'old body')
      cache.applyReasoningDelta('reused', 'old-run', 'old thought')
      window.prune = cache.collectStalePrune('old-run', 'reused')
      cache.applyReset('reused')
      cache.applyDelta('reused', 'new-run', 'new body')
      cache.applyReasoningDelta('reused', 'new-run', 'new thought')
      window.prune()
    })
    await page.waitForFunction(() => cache.streaming.reused === 'new body')
    assert.equal(
      await page.evaluate(() => cache.streamingReasoning.reused),
      'new thought',
    )
    await page.evaluate(() => cache.collectStalePrune('new-run', 'reused')())
    await page.waitForFunction(() => !cache.streamingReasoning.reused)
  } finally {
    await browser.close()
  }
})

test('failed history refresh retains final streamed content until a successful refresh', async () => {
  const root = fileURLToPath(new URL('..', import.meta.url))
  const built = await build({
    absWorkingDir: root,
    stdin: {
      contents: `import React from 'react'; import {createRoot} from 'react-dom/client';
import {useAppBootstrap} from './frontend/hooks/useAppBootstrap';
window.failRefresh=true;window.refreshes=0;
const noop=async()=>{};
const deps={activeSessionRef:{current:'session'},activeProjectRef:{current:null},refreshProfiles:noop,refreshProjects:noop,refreshSessions:noop,refreshDelegations:noop,setNotice:()=>{},onDangerChanged:()=>{},refreshSessionData:async()=>{window.refreshes++;if(window.failRefresh)throw Error('fixture disconnected')}};
function App(){window.state=useAppBootstrap(deps);return null}
createRoot(document.getElementById('root')).render(<App/>);`,
      resolveDir: root,
      loader: 'tsx',
    },
    bundle: true,
    format: 'iife',
    jsx: 'automatic',
    write: false,
    plugins: [
      {
        name: 'bootstrap-boundaries',
        setup(build) {
          build.onResolve(
            {
              filter:
                /lib\/transport$|api\/chat$|^@tauri-apps\/api\/(core|event)$/,
            },
            ({ path }) => ({ path, namespace: 'fixture' }),
          )
          build.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({
            contents: path.endsWith('/transport')
              ? `export const transport={attach:async()=>{},onEvent:fn=>{window.emitEvent=fn;return ()=>{}}}`
              : path.endsWith('/chat')
                ? `export const listPendingInteractions=async()=>({interactions:[]})`
                : path.endsWith('/core')
                  ? `export const invoke=async()=>({state:'ready',runtimeReady:true,systemReady:true})`
                  : `export const listen=async()=>()=>{}`,
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
    await page.waitForFunction(() => window.emitEvent && window.state)
    await page.evaluate(() => {
      emitEvent({
        type: 'message.reasoning_delta',
        scope: 'run',
        runId: 'run',
        messageId: 'message',
        delta: 'thought',
      })
      emitEvent({
        type: 'message.completed',
        scope: 'run',
        runId: 'run',
        messageId: 'message',
        content: 'final answer',
      })
    })
    await page.waitForFunction(
      () => state.streaming.message === 'final answer' && refreshes === 1,
    )
    assert.equal(
      await page.evaluate(() => state.streamingReasoning.message),
      'thought',
    )
    await page.evaluate(() => {
      window.failRefresh = false
      emitEvent({ type: 'run.completed', scope: 'run', runId: 'run' })
    })
    await page.waitForFunction(
      () =>
        refreshes === 2 &&
        !state.streaming.message &&
        !state.streamingReasoning.message,
    )
    assert.deepEqual(await page.evaluate(() => state.runActivities), {})
  } finally {
    await browser.close()
  }
})
