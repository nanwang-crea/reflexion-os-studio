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

test('shared surface expands files, retains drafts across browser switches and restores split width', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'surface-layout-'))
  const server = createServer()
  let browser
  try {
    await build({
      absWorkingDir: desktop,
      stdin: {
        contents: `
          import React, { useState } from 'react';
          import { createRoot } from 'react-dom/client';
          import { AppMain } from './frontend/AppMain';
          import './frontend/features/browser/browser.css';
          import './frontend/features/workspace/workspace.css';
          function Fixture() {
            const [open, setOpen] = useState(true);
            const [width, setWidth] = useState(460);
            const [session, setSession] = useState('s1');
            window.changeSession = () => setSession('s2');
            return <AppMain view="chat" activeSessionId={session} topBar={{}}
              notice={null} onDismissNotice={() => {}} chat={{}} landing={{}} settings={{}} instructions={{}} onUseSkill={() => {}}
              workspace={{open, setOpen, width, setWidth, panel: { activeTabId: 'a.md' }}}
              terminal={{open: false, onToggle() {}, activeProjectId: null, confirm: async () => true}} />;
          }
          createRoot(document.getElementById('root')).render(<Fixture />);
        `,
        resolveDir: desktop,
        loader: 'tsx',
      },
      bundle: true,
      format: 'iife',
      define: { 'import.meta.env.VITE_TERMINAL_DISABLED': '"0"' },
      jsx: 'automatic',
      outfile: join(directory, 'app.js'),
      plugins: [
        {
          name: 'surface-fixtures',
          setup(build) {
            build.onLoad(
              {
                filter:
                  /(?:TopBar|ChatView|LandingView|SkillsView|SettingsView|InstructionsView|AgentRolesView|CollaborationPanel|TerminalPanel|FileViewerPanel|BrowserSurfacePanel)\.tsx$/,
              },
              ({ path }) => {
                const name = path.split('/').at(-1).replace('.tsx', '')
                let body = '<div />'
                if (name === 'TopBar')
                  body =
                    '<button onClick={props.onToggleWorkspace}>打开工作区</button>'
                if (name === 'FileViewerPanel')
                  body =
                    '<div className="workspace-panel"><textarea aria-label="文件草稿" defaultValue="原文" /></div>'
                if (name === 'BrowserSurfacePanel')
                  body =
                    '<div className="browser-surface-panel"><p>浏览器内容</p></div>'
                return {
                  contents:
                    'import React from "react"; export function ' +
                    name +
                    '(props) { return ' +
                    body +
                    ' }',
                  loader: 'tsx',
                }
              },
            )
          },
        },
      ],
    })
    const script = await readFile(join(directory, 'app.js'))
    const css = await readFile(join(directory, 'app.css'))
    server.on('request', (request, response) => {
      const asset =
        request.url === '/app.js'
          ? script
          : request.url === '/app.css'
            ? css
            : null
      response.setHeader(
        'content-type',
        request.url === '/app.js'
          ? 'text/javascript'
          : request.url === '/app.css'
            ? 'text/css'
            : 'text/html',
      )
      response.end(
        asset ??
          '<meta charset="utf-8"><link rel="stylesheet" href="/app.css"><style>body{margin:0} .main-pane{display:flex;height:100vh}.right-surface{display:flex}</style><main id="root"></main><script src="/app.js"></script>',
      )
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    browser = await chromium.launch({
      channel: 'chromium',
      headless: true,
      chromiumSandbox: true,
    })
    const page = await browser.newPage({
      viewport: { width: 1200, height: 800 },
    })
    await page.goto(`http://127.0.0.1:${server.address().port}`)
    const nav = page.getByRole('navigation', { name: '右侧面板', exact: true })
    const draft = page.getByRole('textbox', { name: '文件草稿' })
    await draft.fill('未保存草稿')
    await nav.getByRole('button', { name: '放大右侧面板', exact: true }).click()
    assert.equal(await page.locator('.main-chat-column').isVisible(), false)
    assert.equal(
      Math.round((await page.locator('.workspace-panel').boundingBox()).width),
      1200,
    )
    await nav.getByRole('button', { name: '浏览器', exact: true }).click()
    assert.equal(await draft.isVisible(), false)
    assert.equal(
      await nav.getByRole('button', { name: '还原分栏' }).isVisible(),
      true,
    )
    await nav.getByRole('button', { name: '工作区', exact: true }).click()
    assert.equal(await draft.inputValue(), '未保存草稿')
    assert.equal(
      Math.round((await page.locator('.workspace-panel').boundingBox()).width),
      1200,
    )
    await nav.getByRole('button', { name: '还原分栏' }).click()
    assert.equal(
      Math.round((await page.locator('.right-surface').boundingBox()).width),
      460,
    )
    assert.equal(await page.locator('.main-chat-column').isVisible(), true)
    await nav.getByRole('button', { name: '放大右侧面板' }).click()
    await page.evaluate(() => window.changeSession())
    await nav.getByRole('button', { name: '放大右侧面板' }).waitFor()
    await nav.getByRole('button', { name: '放大右侧面板' }).click()
    await nav.getByRole('button', { name: '收起右侧面板' }).click()
    await page.getByRole('button', { name: '打开工作区' }).click()
    await nav.getByRole('button', { name: '放大右侧面板' }).waitFor()
    assert.equal(await draft.inputValue(), '未保存草稿')
    await page.setViewportSize({ width: 600, height: 700 })
    await nav.getByRole('button', { name: '放大右侧面板' }).click()
    assert.equal(
      Math.round((await page.locator('.workspace-panel').boundingBox()).width),
      600,
    )
  } finally {
    await browser?.close()
    await new Promise((resolve) => server.close(resolve))
    await rm(directory, { recursive: true, force: true })
  }
})
