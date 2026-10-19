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

/**
 * 输入框拖入文件：DOM 通道行为验证。
 *
 * Tauri 原生通道（onDragDropEvent + asset.read_dropped_file）由 runtime 侧
 * asset-drop.test.mjs 与 PluginInstaller 既有用例覆盖；浏览器里跑不到原生
 * 事件，这里验证 DOM 通道本身：文件真的入列、非文件拖拽不误触、超限与
 * 不支持类型有明确反馈、离开后高亮收起。
 */
test('composer drop zone accepts dropped files and reports rejections', async () => {
  const built = await build({
    absWorkingDir: fileURLToPath(new URL('..', import.meta.url)),
    stdin: {
      contents: `import React from 'react'; import {createRoot} from 'react-dom/client';
import {Composer} from './frontend/components/Composer';
import './frontend/styles/style.css';
createRoot(document.getElementById('root')).render(<Composer placeholder="输入消息" onSend={async(content, template, files)=>{window.sent={content,files:files.map(file=>file.name)}}}/>);`,
      resolveDir: fileURLToPath(new URL('..', import.meta.url)),
      loader: 'tsx',
    },
    bundle: true,
    format: 'iife',
    jsx: 'automatic',
    write: false,
    outdir: '/tmp/composer-drop-bundle',
  })

  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage({
      viewport: { width: 940, height: 800 },
    })
    await page.setContent(
      '<!doctype html><meta charset="utf-8"><div id="root"></div>',
    )
    await page.addStyleTag({
      content:
        ':root{--bg-elevated:#1a1a1a;--border:#333;--accent-border:#4a7;--text-secondary:#ddd;--text-muted:#888;--chat-col:720px}',
    })
    // about:blank 不是安全上下文：补最小 randomUUID/createObjectURL 实现，
    // 否则附件入列（既有链路）会在这里抛错，掩盖真正要验证的拖拽行为。
    await page.addScriptTag({
      content: `(() => {
  if (typeof crypto.randomUUID !== 'function') {
    Object.defineProperty(Crypto.prototype, 'randomUUID', {
      configurable: true,
      value: () => 'test-' + Math.random().toString(16).slice(2),
    })
  }
  if (typeof URL.createObjectURL !== 'function') {
    URL.createObjectURL = () => 'blob:test'
    URL.revokeObjectURL = () => {}
  }
})()`,
    })
    await page.addScriptTag({ content: built.outputFiles[0].text })

    const zone = page.locator('.composer')
    await zone.waitFor()

    // 选择器的 accept 覆盖需求里点名的类型（图片/PDF/DOCX/XLSX/文本）。
    const accept = await page.locator('input[type=file]').getAttribute('accept')
    const accepted = accept.split(',')
    for (const token of [
      'image/png',
      '.pdf',
      '.docx',
      '.xlsx',
      '.md',
      '.txt',
    ]) {
      assert.ok(
        accepted.includes(token),
        `file picker accept must include ${token}, got ${accept}`,
      )
    }

    /** 在页面内构造 DataTransfer 并派发 drag 事件。 */
    const dispatch = async (type, files) => {
      await page.evaluate(
        ({ type, files }) => {
          const zone = document.querySelector('.composer')
          const dataTransfer = new DataTransfer()
          for (const file of files) {
            dataTransfer.items.add(
              new File([new Uint8Array(file.bytes)], file.name, {
                type: file.mimeType,
              }),
            )
          }
          zone.dispatchEvent(
            new DragEvent(type, {
              bubbles: true,
              cancelable: true,
              dataTransfer,
            }),
          )
        },
        { type, files },
      )
    }

    // 非文件拖拽（如拖一段文字）不应点亮高亮，也不应添加附件。
    await dispatch('dragover', [])
    await page.waitForTimeout(50)
    assert.equal(await page.locator('.composer-drop-overlay').count(), 0)

    // 拖入文件时高亮出现，松手后消失。
    await dispatch('dragover', [
      { name: 'note.md', mimeType: 'text/markdown', bytes: [35, 32] },
    ])
    await page.waitForTimeout(50)
    assert.equal(
      await page.locator('.composer-drop-overlay').count(),
      1,
      'dragging a file over the composer shows the drop overlay',
    )
    await dispatch('dragleave', [])
    await page.waitForTimeout(50)
    assert.equal(
      await page.locator('.composer-drop-overlay').count(),
      0,
      'leaving the zone clears the overlay',
    )

    // 真正的 drop：文件进入待发送附件列。
    await dispatch('drop', [
      { name: 'note.md', mimeType: 'text/markdown', bytes: [35, 32] },
    ])
    await page.waitForTimeout(50)
    assert.equal(await page.locator('.composer-image').count(), 1)
    assert.match(await page.locator('.composer-images').innerText(), /note\.md/)

    // 不支持的类型给出可读错误，而不是静默丢弃。
    await dispatch('drop', [
      { name: 'setup.exe', mimeType: 'application/octet-stream', bytes: [77] },
    ])
    await page.waitForTimeout(50)
    const alert = page.locator('.composer-image-error')
    await alert.waitFor()
    assert.match(await alert.innerText(), /不支持/)
    assert.equal(
      await page.locator('.composer-image').count(),
      1,
      'rejected file must not be added',
    )

    // 超过 4 个上限：多出的不进入，且提示上限。
    await dispatch('drop', [
      { name: 'a.md', mimeType: 'text/markdown', bytes: [97] },
      { name: 'b.md', mimeType: 'text/markdown', bytes: [98] },
      { name: 'c.md', mimeType: 'text/markdown', bytes: [99] },
      { name: 'd.md', mimeType: 'text/markdown', bytes: [100] },
    ])
    await page.waitForTimeout(50)
    assert.match(await alert.innerText(), /最多 4 个文件/)
    assert.equal(
      await page.locator('.composer-image').count(),
      1,
      'batch over the limit must be rejected as a whole',
    )
  } finally {
    await browser.close()
  }
})
