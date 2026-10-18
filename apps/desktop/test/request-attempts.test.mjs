import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from 'esbuild'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { browserWorkerPaths } from '../../runtime/dist/browser/agent/paths.js'

const desktop = fileURLToPath(new URL('..', import.meta.url))
const require = createRequire(
  new URL('../../runtime/package.json', import.meta.url),
)
process.env.PLAYWRIGHT_BROWSERS_PATH = browserWorkerPaths().browsers
const { chromium } = require('playwright')

test('request history keeps interrupted previews distinct, expandable and keyboard accessible', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'attempt-ui-'))
  const server = createServer()
  let browser
  try {
    await build({
      absWorkingDir: desktop,
      stdin: {
        loader: 'tsx',
        contents: `
          import React from 'react';
          import {createRoot} from 'react-dom/client';
          import {RequestAttempts} from './frontend/features/chat/message/RequestAttempts';
          import './frontend/styles/style.css';
          const message={requestAttempts:[{
            id:'a',attempt:1,status:'failed',phase:'stream',durationMs:5000,receivedBytes:100,
            maxIdleMs:4000,firstDataMs:500,firstTextMs:1000,responseStatus:200,
            providerRequestId:'test-request',errorMessage:'连接在传输期间关闭',
            content:'先前的未完成正文',reasoning:'之前的思考'
          },{id:'b',attempt:2,status:'completed',phase:'stream',durationMs:2000,receivedBytes:200,maxIdleMs:500}]};
          document.body.style.padding='24px';
          createRoot(document.getElementById('root')).render(<><p>当前完整答案</p><RequestAttempts message={message}/></>);
        `,
        resolveDir: desktop,
      },
      bundle: true,
      format: 'iife',
      jsx: 'automatic',
      outfile: join(directory, 'app.js'),
    })
    server.on('request', async (request, response) => {
      if (request.url === '/app.js' || request.url === '/app.css') {
        response.setHeader(
          'Content-Type',
          request.url.endsWith('.js') ? 'application/javascript' : 'text/css',
        )
        response.end(await readFile(join(directory, request.url.slice(1))))
      } else
        response.end(
          '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/app.css"><div id="root"></div><script src="/app.js"></script>',
        )
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    browser = await chromium.launch({ headless: true })
    const page = await browser.newPage({
      viewport: { width: 600, height: 700 },
    })
    await page.goto(`http://127.0.0.1:${server.address().port}`)
    const history = page.getByText('请求记录（2 次）', { exact: true })
    await history.waitFor()
    assert.equal(await page.getByText('先前的未完成正文').count(), 0)
    await history.focus()
    await page.keyboard.press('Enter')
    const failed = page.getByText('第 1 次 · 已中断 · 5.0 秒', { exact: true })
    await failed.focus()
    await page.keyboard.press('Enter')
    await page.getByText('先前的未完成正文', { exact: true }).waitFor()
    await page.getByText('请求 ID：test-request', { exact: true }).waitFor()
    assert.equal(
      await page.getByRole('button', { name: '复制', exact: true }).count(),
      1,
    )
    assert.equal(
      await page.getByText('当前完整答案', { exact: true }).isVisible(),
      true,
    )
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
    )
    await failed.click()
    await page.getByText('先前的未完成正文').waitFor({ state: 'detached' })
    assert.equal(await page.getByText('当前完整答案').isVisible(), true)
  } finally {
    await browser?.close()
    if (server.listening) await new Promise((resolve) => server.close(resolve))
    await rm(directory, { recursive: true, force: true })
  }
})
