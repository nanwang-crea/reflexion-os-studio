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

test('performance and partial edit results remain collapsible and readable in a narrow panel', async () => {
  const root = fileURLToPath(new URL('..', import.meta.url))
  const built = await build({
    absWorkingDir: root,
    stdin: {
      contents: `import React from 'react'; import {createRoot} from 'react-dom/client';
import {RunPerformanceDetails} from './frontend/features/chat/run/RunPerformanceDetails';
import {FileEditBatchDetails} from './frontend/features/chat/tools/FileEditBatchDetails';
import './frontend/styles/style.css'; import './frontend/features/chat/chat.css';
const metrics={version:1,elapsedMs:10000,modelMs:7000,modelCalls:2,requestAttempts:3,requestRetries:1,firstDataWaitMs:500,firstDataSamples:2,approvalWaitMs:100,mutationWaitMs:10,toolExecutionMs:1000,shellExecutionMs:500,toolBatchMs:800,toolCalls:3,toolFailures:1,editFailures:1,streamedReads:1};
const output={type:'tool_output',version:1,content:'已保留成功修改',data:null,resourceLinks:[],changedFiles:[],provenance:null};
createRoot(document.getElementById('root')).render(<><RunPerformanceDetails metrics={metrics}/><FileEditBatchDetails call={{output:{data:{atomicAcrossFiles:false,results:[{path:'src/a.ts',toolCallId:'a',status:'completed',output},{path:'src/b.ts',toolCallId:'b',status:'failed',output:{...output,content:'revision 冲突'}},{path:'src/c.ts',toolCallId:'c',status:'not_executed',output:null}]}}}}/></>);`,
      resolveDir: root,
      loader: 'tsx',
    },
    bundle: true,
    format: 'iife',
    jsx: 'automatic',
    write: false,
    outdir: '/tmp/reflexion-performance-ui',
  })
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage({
      viewport: { width: 400, height: 740 },
    })
    await page.setContent(
      '<!doctype html><meta charset="utf-8"><main id="root" style="padding:16px;overflow-wrap:anywhere"></main>',
    )
    await page.addStyleTag({
      content: built.outputFiles.find((file) => file.path.endsWith('.css'))
        .text,
    })
    await page.addScriptTag({
      content: built.outputFiles.find((file) => file.path.endsWith('.js')).text,
    })
    await page.locator('.run-performance summary').click()
    assert.match(
      await page.locator('.run-performance').innerText(),
      /2 轮 · 7.0 秒/,
    )
    assert.match(
      await page.locator('.run-performance').innerText(),
      /不能直接相加/,
    )
    assert.equal(await page.locator('.trace-detail details').count(), 3)
    await page.getByText('src/b.ts · 失败', { exact: true }).click()
    assert.match(
      await page.locator('.trace-detail').innerText(),
      /revision 冲突/,
    )
    await page.locator('.run-performance summary').focus()
    await page.keyboard.press('Enter')
    assert.equal(
      await page.locator('.run-performance').getAttribute('open'),
      null,
    )
    await page.keyboard.press('Enter')
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
    )
    await page.screenshot({
      path: '/tmp/reflexion-agent-performance-ui.png',
      fullPage: true,
    })
    await page.close()
  } finally {
    await browser.close()
  }
})
