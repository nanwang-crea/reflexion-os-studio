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
const desktop = fileURLToPath(new URL('..', import.meta.url))

const built = await build({
  absWorkingDir: desktop,
  stdin: {
    resolveDir: desktop,
    loader: 'tsx',
    contents: `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {useDataRefreshers} from './frontend/hooks/useDataRefreshers';
const noop=()=>{};
function Harness(){
  const [activeSessionId,setActiveSessionId]=React.useState(null);
  const [sessionData,setSessionData]=React.useState(null);
  const sessionRequestRef=React.useRef(0);
  const refreshers=useDataRefreshers({activeSessionId,sessionRequestRef,setSessionData,setProfiles:noop,setProjects:noop,setAllSessions:noop,setDelegations:noop});
  window.setActiveSessionId=setActiveSessionId;
  window.refreshSessionData=refreshers.refreshSessionData;
  window.currentSessionData=()=>sessionData;
  return null;
}
const root=createRoot(document.getElementById('root'));
window.unmount=()=>root.unmount();
root.render(<Harness/>);
`,
  },
  bundle: true,
  format: 'iife',
  jsx: 'automatic',
  write: false,
  plugins: [
    {
      name: 'data-refresher-fixture',
      setup(build) {
        build.onResolve(
          { filter: /api\/(sessions|providers|projects|agents)$/ },
          ({ path }) => ({ path, namespace: 'fixture' }),
        )
        build.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({
          contents: path.endsWith('/sessions')
            ? `export const getSessionData = async (sessionId) => {
                 window.fetchCount = (window.fetchCount ?? 0) + 1;
                 if (window.fetchDelay) await new Promise((resolve) => setTimeout(resolve, window.fetchDelay));
                 return { session: { id: sessionId }, messages: [], runs: [], toolCalls: [], plans: [], runEvents: [], positions: {}, nextBefore: null };
               };
               export const listSessions = async () => ({ sessions: [] });`
            : path.endsWith('/providers')
              ? `export const listProviders = async () => ({ profiles: [] });`
              : path.endsWith('/projects')
                ? `export const listProjects = async () => ({ projects: [] });`
                : `export const listDelegations = async () => [];`,
        }))
      },
    },
  ],
})

async function withPage(run) {
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    page.setDefaultTimeout(5000)
    await page.setContent('<!doctype html><main id="root"></main>')
    await page.addScriptTag({ content: built.outputFiles[0].text })
    await page.waitForFunction(() => window.refreshSessionData)
    await run(page)
  } finally {
    await browser.close()
  }
}

// 回归：openSession 先 setActiveSessionId 再同一拍调用 refreshSessionData，
// 此刻 hook 里的 active ref 还是旧会话；首拉不能被这个同步检查挡掉。
test('opening a session fetches before React commits the new active id', async () => {
  await withPage(async (page) => {
    await page.evaluate(() => {
      window.setActiveSessionId('s-open')
      void window.refreshSessionData('s-open')
    })
    await page.waitForFunction(
      () => window.currentSessionData()?.session?.id === 's-open',
    )
    assert.equal(await page.evaluate(() => window.fetchCount), 1)
  })
})

test('a burst of refreshes collapses into one in-flight plus one trailing fetch', async () => {
  await withPage(async (page) => {
    await page.evaluate(() => {
      window.fetchDelay = 30
      window.setActiveSessionId('s-burst')
      window.burstDone = false
      const first = window.refreshSessionData('s-burst')
      const second = window.refreshSessionData('s-burst')
      void Promise.all([first, second]).then(() => {
        window.burstDone = true
      })
    })
    await page.waitForFunction(() => window.burstDone === true)
    assert.equal(await page.evaluate(() => window.fetchCount), 2)
  })
})

test('a late response for a session the user left never lands on the page', async () => {
  await withPage(async (page) => {
    await page.evaluate(async () => {
      window.fetchDelay = 60
      window.setActiveSessionId('s-left')
      const pending = window.refreshSessionData('s-left')
      window.setActiveSessionId('s-right')
      await pending
    })
    await page.waitForTimeout(50)
    assert.equal(await page.evaluate(() => window.currentSessionData()), null)
  })
})
