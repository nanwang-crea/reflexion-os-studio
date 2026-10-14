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
import './frontend/styles/style.css';
import './frontend/features/automations/workflow.css';
import { JsonField } from './frontend/features/automations/editor/JsonField';
import { NodeInspector } from './frontend/features/automations/editor/NodeInspector';
import { DefinitionEditor } from './frontend/features/automations/editor/DefinitionEditor';
import { GenerationPanel } from './frontend/features/automations/generation/GenerationPanel';
import { RunControls } from './frontend/features/automations/run/RunControls';
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
window.showWorkspace = () => {
  function Workspace() {
    const [definition, change] = React.useState(() => workflowFixture());
    const [panel, setPanel] = React.useState(null);
    const [showRun, setShowRun] = React.useState(false);
    const editor = { definition, change, versions: [], drafts: [], draft: null, base: null, busy: false, dirty: true, generation: null, error: null, validation: null, select: async () => {}, saveDraft: async () => {}, save: async () => {}, validate: async () => {}, action: async work => work(), refresh: async () => {}, setError: value => { throw new Error(value) } };
    const generationPanel = React.createElement(GenerationPanel, { value: null, disabled: false, canApply: false, onGenerate: () => {}, onCancel: () => {}, onApply: () => {}, onEdit: () => {} });
    const runPanel = React.createElement(RunControls, { providers: [], definition, disabled: true, modelKey: '', onModel: () => {}, onStart: () => {} });
    return React.createElement('div', { className: 'automations-view' },
      React.createElement('header', { className: 'workflow-page-head' }, React.createElement('div', null, React.createElement('h1', null, '工作流'), React.createElement('p', null, '连接角色，让想法成为可执行的协作流程。'))),
      React.createElement('div', { className: 'workflow-project-surface' }, React.createElement('div', { className: 'workflow-workspace' }, React.createElement(DefinitionEditor, { editor, saved: null, providers: [], templates: [], detail: null, showRun, onShowRun: setShowRun, panel, onPanel: setPanel, confirm: async () => true, generationPanel, runPanel }))));
  }
  root.render(React.createElement(Workspace));
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
            : '<meta charset="utf-8"><link rel="stylesheet" href="/app.css"><main id="root" style="height:100vh"></main><script src="/app.js"></script>',
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
    await page
      .locator('summary')
      .filter({ hasText: /^输入输出端口$/ })
      .click()
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
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.evaluate(() => window.showWorkspace())
    await page.locator('.workflow-stage').waitFor()
    const more = page.getByRole('button', { name: '更多操作', exact: true })
    await more.focus()
    await page.keyboard.press('ArrowDown')
    await page.getByRole('menuitem', { name: '校验', exact: true }).waitFor()
    await page.keyboard.press('Escape')
    assert.equal(
      await more.evaluate((element) => element === document.activeElement),
      true,
    )
    const nodeButton = page.locator('.react-flow__node').first()
    await nodeButton.click()
    await page
      .getByRole('textbox', { name: '节点任务', exact: true })
      .fill('保留这段编辑内容')
    await page.getByRole('button', { name: 'AI 生成', exact: true }).click()
    const description = page.getByRole('textbox', { name: '描述', exact: true })
    await description.fill('生成一个完整的产品开发流程')
    await page.getByRole('button', { name: '流程', exact: true }).click()
    await page
      .getByRole('textbox', { name: '工作流名称', exact: true })
      .fill('产品开发 Builder')
    await page
      .locator('summary')
      .filter({ hasText: /^高级配置/ })
      .click()
    const definitionJSON = page.getByRole('textbox', {
      name: '完整定义 JSON',
      exact: true,
    })
    await definitionJSON.fill('尚未应用的 JSON 编辑')
    await page.getByRole('button', { name: '节点', exact: true }).click()
    assert.equal(
      await page
        .getByRole('textbox', { name: '节点任务', exact: true })
        .inputValue(),
      '保留这段编辑内容',
    )
    await page.getByRole('button', { name: 'AI 生成', exact: true }).click()
    assert.equal(await description.inputValue(), '生成一个完整的产品开发流程')
    await page.getByRole('button', { name: '流程', exact: true }).click()
    assert.equal(await definitionJSON.inputValue(), '尚未应用的 JSON 编辑')
    for (const viewport of [
      { width: 1440, height: 900 },
      { width: 950, height: 700 },
      { width: 600, height: 650 },
    ]) {
      await page.setViewportSize(viewport)
      const bounds = await page.evaluate(() => {
        const page = document.querySelector('.automations-view')
        const stage = document
          .querySelector('.workflow-stage')
          .getBoundingClientRect()
        const panel = document
          .querySelector('.workflow-side-panel')
          .getBoundingClientRect()
        return {
          scroll: page.scrollHeight,
          client: page.clientHeight,
          bodyWidth: document.body.scrollWidth,
          stageBottom: stage.bottom,
          panelRight: panel.right,
          width: innerWidth,
          height: innerHeight,
        }
      })
      assert.ok(bounds.scroll <= bounds.client + 1, JSON.stringify(bounds))
      assert.ok(bounds.bodyWidth <= bounds.width, JSON.stringify(bounds))
      assert.ok(bounds.stageBottom <= bounds.height, JSON.stringify(bounds))
      assert.ok(bounds.panelRight <= bounds.width, JSON.stringify(bounds))
    }
    await page.keyboard.press('Escape')
    assert.equal(await page.locator('.workflow-side-panel').isVisible(), false)
    assert.equal(
      await page
        .getByRole('button', { name: '流程', exact: true })
        .evaluate((element) => element === document.activeElement),
      true,
    )
    await page.getByRole('button', { name: '运行', exact: true }).click()
    await page
      .getByRole('textbox', { name: '运行输入 JSON', exact: true })
      .fill('{"text":{"type":"text","value":"任务"}}')
    await page.getByRole('button', { name: 'AI 生成', exact: true }).click()
    await page.getByRole('button', { name: '运行', exact: true }).click()
    assert.match(
      await page
        .getByRole('textbox', { name: '运行输入 JSON', exact: true })
        .inputValue(),
      /任务/,
    )
    await page.setViewportSize({ width: 1440, height: 900 })
    await page
      .getByRole('button', { name: '收起配置面板', exact: true })
      .click()
    await page.screenshot({ path: '/tmp/reflexion-workflow-layout-wide.png' })
    await page.locator('.react-flow__node').first().click()
    await page.screenshot({ path: '/tmp/reflexion-workflow-layout-node.png' })
    assert.deepEqual(errors, [])
  } finally {
    await browser?.close()
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
    await rm(directory, { recursive: true, force: true })
  }
})
