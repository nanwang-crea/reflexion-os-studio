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

test('Workflow components retain failed edits, limit port changes, refresh handles and preserve arbitrary IDs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'workflow-component-ui-'))
  const server = createServer()
  let browser
  try {
    await build({
      absWorkingDir: desktop,
      stdin: {
        contents: `
import React from 'react'; import { createRoot } from 'react-dom/client';
import './frontend/features/automations/workflow.css';
import { JsonField } from './frontend/features/automations/editor/JsonField';
import { NodeInspector } from './frontend/features/automations/editor/NodeInspector';
import { WorkflowCanvas } from './frontend/features/automations/editor/WorkflowCanvas';
import { workflowFixture } from '../../packages/contracts/test/fixtures/workflow.mjs';
const root = createRoot(document.getElementById('root'));
window.showJSON = () => {
  let value = { text: 'base' }; window.applies = 0;
  const render = () => root.render(React.createElement(JsonField, { label: '测试 JSON', value, onApply: async () => {
    window.applies++; await new Promise(resolve => window.release = resolve); throw new Error('synthetic save failure');
  }}));
  window.changeDocument = () => { value = { text: 'new baseline' }; render(); }; render();
};
window.showInspector = () => {
  window.node = workflowFixture().nodes[0]; window.changes = [];
  const render = () => root.render(React.createElement(NodeInspector, { node: window.node, templates: [], providers: [], onChange: value => { window.changes.push(value); window.node = value; render(); } })); render();
};
window.showCanvas = () => {
  let definition = workflowFixture(); const id = 'quoted"\\\\id' + String.fromCharCode(0xd800);
  definition.nodes[0].id = id; definition.bindings[0].to.nodeId = id; definition.edges[0].from.nodeId = id;
  window.originalId = id; window.selected = null; window.canvasChanges = [];
  const render = () => root.render(React.createElement(WorkflowCanvas, { definition, readOnly: true, onSelect: id => window.selected = id, onError: value => { throw new Error(value) }, onChange: value => window.canvasChanges.push(value) }));
  window.renamePort = () => { definition = structuredClone(definition); definition.nodes[0].outputs[0].key = 'renamed'; definition.edges[0].from.portKey = 'renamed'; render(); }; render();
};
window.showJSON();
`,
        resolveDir: desktop,
        loader: 'tsx',
      },
      bundle: true,
      format: 'iife',
      jsx: 'automatic',
      outfile: join(directory, 'app.js'),
    })
    const [script, css] = await Promise.all([
      readFile(join(directory, 'app.js')),
      readFile(join(directory, 'app.css')),
    ])
    server.on('request', (request, response) => {
      response.setHeader(
        'content-type',
        request.url === '/app.js'
          ? 'text/javascript'
          : request.url === '/app.css'
            ? 'text/css'
            : 'text/html',
      )
      response.end(
        request.url === '/app.js'
          ? script
          : request.url === '/app.css'
            ? css
            : '<meta charset="utf-8"><link rel="stylesheet" href="/app.css"><main id="root"></main><script src="/app.js"></script>',
      )
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    browser = await chromium.launch({ channel: 'chromium', headless: true })
    const page = await browser.newPage({
      viewport: { width: 1000, height: 800 },
    })
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(`http://127.0.0.1:${server.address().port}`)

    const json = page.getByRole('textbox', { name: '测试 JSON' })
    await json.fill('{"text":"edited"}')
    await page
      .getByRole('button', { name: '应用 测试 JSON', exact: true })
      .click()
    await page.waitForFunction(() => window.applies === 1)
    assert.equal(await json.isDisabled(), true)
    await page.evaluate(() => window.release())
    await page.getByRole('alert').waitFor()
    assert.match(
      await page.getByRole('alert').textContent(),
      /synthetic save failure/,
    )
    assert.equal(await json.inputValue(), '{"text":"edited"}')
    await page.evaluate(() => window.changeDocument())
    await page
      .getByRole('button', { name: '应用 测试 JSON', exact: true })
      .click()
    assert.match(await page.getByRole('alert').textContent(), /已有新编辑/)
    assert.equal(await page.evaluate(() => window.applies), 1)
    await page.getByRole('button', { name: '放弃 JSON 编辑，刷新配置' }).click()
    assert.deepEqual(JSON.parse(await json.inputValue()), {
      text: 'new baseline',
    })

    await page.evaluate(() => window.showInspector())
    const ports = page.getByRole('textbox', { name: '输入输出端口' })
    await ports.waitFor()
    const portData = await page.evaluate(() => ({
      inputs: window.node.inputs,
      outputs: window.node.outputs,
      taskPrompt: 'unexpected change',
    }))
    await ports.fill(JSON.stringify(portData))
    await page
      .getByRole('button', { name: '应用 输入输出端口', exact: true })
      .click()
    await page.getByRole('alert').waitFor()
    assert.equal(await page.evaluate(() => window.changes.length), 0)
    delete portData.taskPrompt
    portData.outputs[0].key = 'renamed'
    await ports.fill(JSON.stringify(portData))
    await page
      .getByRole('button', { name: '应用 输入输出端口', exact: true })
      .click()
    await page.waitForFunction(() => window.changes.length === 1)
    assert.equal(
      await page.evaluate(() => window.node.outputs[0].key),
      'renamed',
    )
    assert.notEqual(
      await page.evaluate(() => window.node.taskPrompt),
      'unexpected change',
    )

    await page.evaluate(() => window.showCanvas())
    const nodes = page.locator('.react-flow__node')
    await nodes.first().waitFor()
    const id = await nodes.first().getAttribute('data-id')
    assert.match(id, /^[a-z0-9]+$/)
    await nodes.first().click()
    assert.equal(
      await page.evaluate(() => window.selected === window.originalId),
      true,
    )
    assert.equal(
      await page.getByRole('button', { name: 'Toggle Interactivity' }).count(),
      0,
    )
    await page.keyboard.press('Delete')
    assert.equal(await page.evaluate(() => window.canvasChanges.length), 0)
    await page.evaluate(() => window.renamePort())
    await page.waitForFunction(
      () =>
        document
          .querySelector('.react-flow__edge')
          ?.getAttribute('aria-label')
          ?.includes('renamed') &&
        document.querySelectorAll('.react-flow__edge-path').length === 1,
    )
    assert.equal(
      await page
        .locator('.react-flow__handle[data-handleid="renamed"]')
        .count(),
      1,
    )
    assert.deepEqual(errors, [])
  } finally {
    await browser?.close()
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
    await rm(directory, { recursive: true, force: true })
  }
})
