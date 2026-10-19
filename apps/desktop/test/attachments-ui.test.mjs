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

test('composer selects and pastes up to four files, removes files and previews extracted text', async () => {
  const built = await build({
    absWorkingDir: fileURLToPath(new URL('..', import.meta.url)),
    stdin: {
      contents: `import React from 'react'; import {createRoot} from 'react-dom/client';
import {Composer} from './frontend/components/Composer';
import {MessageFile} from './frontend/features/chat/message/MessageFile';
import './frontend/styles/style.css';
createRoot(document.getElementById('root')).render(<><Composer placeholder="输入消息" onSend={async(content,template,files)=>{window.sent={content,files:files.map(file=>file.name)}}}/><MessageFile part={{type:'file',assetId:'document',fileName:'历史代码.ts',mimeType:'text/plain',size:20,extraction:{format:'text',text:'1: const value = 42'}}}/></>);`,
      resolveDir: fileURLToPath(new URL('..', import.meta.url)),
      loader: 'tsx',
    },
    bundle: true,
    format: 'iife',
    jsx: 'automatic',
    write: false,
    outdir: '/tmp/attachment-ui-bundle',
  })
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage({
      viewport: { width: 940, height: 800 },
    })
    // randomUUID requires the secure context supplied by the real desktop host.
    await page.route('https://attachments.test/**', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><meta charset="utf-8"><div id="root"></div>',
      }),
    )
    await page.goto('https://attachments.test/')
    await page.addStyleTag({
      content: built.outputFiles.find((file) => file.path.endsWith('.css'))
        .text,
    })
    await page.addScriptTag({
      content: built.outputFiles.find((file) => file.path.endsWith('.js')).text,
    })
    const files = Array.from({ length: 4 }, (_, index) => ({
      name: `code-${index}.ts`,
      mimeType: 'text/plain',
      buffer: Buffer.from('const x = 1'),
    }))
    const input = page.locator('input[type=file]')
    await input.setInputFiles(files)
    await page.waitForFunction(
      () => document.querySelectorAll('.composer-image').length === 4,
    )
    await input.setInputFiles({
      name: 'fifth.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('fifth'),
    })
    assert.match(await page.getByRole('alert').textContent(), /最多 4 个文件/)
    assert.equal(await page.locator('.composer-image').count(), 4)
    await page
      .getByRole('button', { name: '移除 code-0.ts', exact: true })
      .click()
    await page.locator('textarea').evaluate((element) => {
      const data = new DataTransfer()
      data.items.add(new File(['pasted'], 'pasted.txt', { type: 'text/plain' }))
      element.dispatchEvent(
        new ClipboardEvent('paste', {
          clipboardData: data,
          bubbles: true,
          cancelable: true,
        }),
      )
    })
    await page.waitForFunction(
      () => document.querySelectorAll('.composer-image').length === 4,
    )
    await page.locator('.composer-send').click()
    await page.waitForFunction(() => window.sent?.files.length === 4)
    assert.deepEqual(await page.evaluate(() => window.sent.files), [
      'code-1.ts',
      'code-2.ts',
      'code-3.ts',
      'pasted.txt',
    ])
    await page.waitForFunction(
      () => document.querySelectorAll('.composer-image').length === 0,
    )
    await page.locator('.message-file summary').click()
    assert.equal(
      await page.locator('.message-file pre').textContent(),
      '1: const value = 42',
    )
    const overflow = await page
      .locator('.message-file')
      .evaluate((element) => element.scrollWidth > element.clientWidth)
    assert.equal(overflow, false)
    await page.close()
  } finally {
    await browser.close()
  }
})
