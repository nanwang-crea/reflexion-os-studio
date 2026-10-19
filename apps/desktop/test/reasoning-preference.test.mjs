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

test('composer reasoning restores after a page restart and when switching models', async () => {
  const root = fileURLToPath(new URL('..', import.meta.url))
  const built = await build({
    stdin: {
      resolveDir: root,
      loader: 'tsx',
      contents: `import React from 'react';import {createRoot} from 'react-dom/client';
import {useModelSelection} from './frontend/hooks/useModelSelection';
const profiles=[{id:'p',name:'Test',enabled:true,models:['a','b'],apiFormat:'openai-responses',reasoningEffort:'high'}];
function Fixture(){const state=useModelSelection(profiles,null,null);
window.fixture={model:state.setSelectedModelKey,effort:state.reasoningSelection.onChange};
return <output>{JSON.stringify({key:state.selectedModelKey,value:state.reasoningSelection.value,requested:state.requestedReasoningEffort,loading:state.reasoningSelection.loading})}</output>}
createRoot(document.getElementById('root')).render(<Fixture/>);`,
    },
    plugins: [
      {
        name: 'fixture-provider',
        setup(builder) {
          builder.onLoad({ filter: /frontend\/api\/providers\.ts$/ }, () => ({
            contents: `export async function listProviderModels(){return {models:['a','b'].map(model=>({providerId:'p',model,reasoningEffortSupported:true,reasoningEffort:'high'}))}}`,
            loader: 'js',
          }))
        },
      },
    ],
    bundle: true,
    format: 'iife',
    jsx: 'automatic',
    write: false,
  })
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    // A routed origin provides real persistent localStorage without a test server.
    await page.route('http://reasoning.test/**', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: '<div id="root"></div>',
      }),
    )
    const start = async () => {
      await page.goto('http://reasoning.test/')
      await page.addScriptTag({ content: built.outputFiles[0].text })
      await page.waitForFunction(() => {
        const value = document.querySelector('output')?.textContent
        return value && !JSON.parse(value).loading
      })
    }
    const check = async (key, value) => {
      await page.waitForFunction(
        ({ key, value }) => {
          const state = JSON.parse(document.querySelector('output').textContent)
          return (
            state.key === key &&
            state.value === value &&
            state.requested === value &&
            !state.loading
          )
        },
        { key, value },
      )
    }
    await start()
    await check('p::a', 'high')
    await page.evaluate(() => window.fixture.effort('low'))
    await check('p::a', 'low')
    await page.evaluate(() => window.fixture.model('p::b'))
    await check('p::b', 'high')
    await page.evaluate(() => window.fixture.effort(null))
    await check('p::b', null)
    await start()
    await check('p::a', 'low')
    await page.evaluate(() => window.fixture.model('p::b'))
    await check('p::b', null)
    assert.equal(await page.evaluate(() => localStorage.length), 2)
  } finally {
    await browser.close()
  }
})
