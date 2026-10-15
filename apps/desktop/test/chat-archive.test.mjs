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

test('chat tools export and import to independent, existing-project and directory sessions', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chat-archive-ui-'))
  const server = createServer()
  let browser
  try {
    await build({
      absWorkingDir: desktop,
      bundle: true,
      format: 'iife',
      jsx: 'automatic',
      outfile: join(directory, 'app.js'),
      plugins: [
        {
          name: 'archive-api',
          setup(build) {
            build.onResolve({ filter: /^@tauri-apps\/plugin-dialog$/ }, () => ({
              path: 'dialog',
              namespace: 'archive',
            }))
            build.onLoad({ filter: /.*/, namespace: 'archive' }, () => ({
              contents:
                'export async function open(){return window.selections.shift()??null}',
              loader: 'js',
            }))
            build.onLoad(
              { filter: /frontend[\\/]api[\\/]chat-archive\.ts$/ },
              () => ({
                contents: `
export async function exportChatArchive(sessionId,directory){window.exports.push({sessionId,directory});return {path:directory+'/chat.reflexion-chat.json',messageCount:2}}
export async function importChatArchive(input){window.imports.push(input);if(window.delayImport)await new Promise(resolve=>window.releaseImport=resolve);return {session:{id:'imported-'+window.imports.length,projectId:input.folderPath?'new-project':input.projectId??null},messageCount:2}}
`,
                loader: 'js',
              }),
            )
          },
        },
      ],
      stdin: {
        resolveDir: desktop,
        loader: 'tsx',
        contents: `
import React from 'react';import {createRoot} from 'react-dom/client';
import './frontend/styles/style.css';
import {TopBar} from './frontend/components/TopBar';
import {ChatImportDialog} from './frontend/features/chat/archive/ChatImportDialog';
import {useChatArchiveActions} from './frontend/features/chat/archive/useChatArchiveActions';
window.selections=[];window.imports=[];window.exports=[];window.notices=[];window.allowSwitch=true;window.guardCalls=0;
function App(){const [session,setSession]=React.useState(null);const [project,setProject]=React.useState(null);const archive=useChatArchiveActions({activeSessionId:session,activeProjectId:project,setNotice:n=>window.notices.push(n),guardedResetWorkspaceFiles:async()=>{window.guardCalls++;return window.allowSwitch},refreshProjects:async()=>{if(window.refreshFails)throw Error('refresh failed')},refreshProjectSessions:async()=>{},refreshStandaloneSessions:async()=>{},setActiveProjectId:setProject,openSession:id=>{window.opened=id;setSession(id)}});
return <><TopBar contextTitle="聊天" runtimeState="system-ready" statusLabel="" sidebarOpen={true} onToggleSidebar={()=>{}} browserOpen={false} onToggleBrowser={()=>{}} showWorkspaceToggle={false} showTerminalToggle={false} workspaceOpen={false} terminalOpen={false} onToggleWorkspace={()=>{}} onToggleTerminal={()=>{}} onImportChat={archive.openImport} onExportChat={session?()=>void archive.exportChat():undefined} archiveBusy={archive.busy}/>{archive.importOpen&&<ChatImportDialog projectId={project} projects={[{id:'p1',name:'项目一'}]} onImport={archive.importChat} onClose={archive.closeImport}/>}</>}
createRoot(document.getElementById('root')).render(<App/>);
`,
      },
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
            : '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script src="/app.js"></script></body></html>',
      )
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    browser = await chromium.launch({ headless: true })
    const page = await browser.newPage({
      viewport: { width: 1000, height: 800 },
    })
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(`http://127.0.0.1:${server.address().port}`)
    const showImport = async () => {
      await page
        .getByRole('button', { name: '对话工具菜单', exact: true })
        .click()
      await page
        .getByRole('menuitem', { name: '导入聊天记录…', exact: true })
        .click()
      await page
        .getByRole('dialog', { name: '导入聊天记录', exact: true })
        .waitFor()
    }
    const chooseBackup = async () => {
      await page.evaluate(() =>
        window.selections.push('/exports/chat.reflexion-chat.json'),
      )
      await page
        .getByRole('button', { name: '选择备份文件…', exact: true })
        .click()
    }
    await showImport()
    await page.keyboard.press('Escape')
    await page
      .getByRole('dialog', { name: '导入聊天记录', exact: true })
      .waitFor({ state: 'detached' })
    assert.equal(await page.evaluate(() => window.imports.length), 0)
    await showImport()
    await chooseBackup()
    await page
      .getByRole('button', { name: '导入为新会话', exact: true })
      .click()
    await page.waitForFunction(() => window.opened === 'imported-1')
    assert.deepEqual(await page.evaluate(() => window.imports[0]), {
      path: '/exports/chat.reflexion-chat.json',
      projectId: null,
    })

    await page.evaluate(() => window.selections.push('/exports'))
    await page
      .getByRole('button', { name: '对话工具菜单', exact: true })
      .click()
    await page
      .getByRole('menuitem', { name: '导出当前聊天记录…', exact: true })
      .click()
    await page.waitForFunction(() => window.exports.length === 1)
    assert.deepEqual(await page.evaluate(() => window.exports[0]), {
      sessionId: 'imported-1',
      directory: '/exports',
    })

    await showImport()
    await chooseBackup()
    await page.getByRole('combobox', { name: '导入位置', exact: true }).click()
    await page
      .getByRole('option', { name: '项目 · 项目一', exact: true })
      .click()
    await page.evaluate(() => {
      window.allowSwitch = false
    })
    await page
      .getByRole('button', { name: '导入为新会话', exact: true })
      .click()
    await page.waitForFunction(() => window.guardCalls === 1)
    assert.equal(await page.evaluate(() => window.imports.length), 1)
    await page.evaluate(() => {
      window.allowSwitch = true
    })
    await page
      .getByRole('button', { name: '导入为新会话', exact: true })
      .click()
    await page.waitForFunction(() => window.opened === 'imported-2')
    assert.equal((await page.evaluate(() => window.imports[1])).projectId, 'p1')

    await showImport()
    await chooseBackup()
    await page.getByRole('combobox', { name: '导入位置', exact: true }).click()
    await page
      .getByRole('option', { name: '选择目录对应的项目…', exact: true })
      .click()
    await page.evaluate(() => window.selections.push('/workspace/new-project'))
    await page
      .getByRole('button', { name: '选择项目目录…', exact: true })
      .click()
    await page.setViewportSize({ width: 390, height: 844 })
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
    )
    await page.screenshot({ path: '/tmp/reflexion-chat-import.png' })
    await page.evaluate(() => {
      window.delayImport = true
      window.refreshFails = true
    })
    await page
      .getByRole('button', { name: '导入为新会话', exact: true })
      .click()
    await page.waitForFunction(() => !!window.releaseImport)
    await page.keyboard.press('Escape')
    assert.equal(
      await page
        .getByRole('dialog', { name: '导入聊天记录', exact: true })
        .count(),
      1,
    )
    assert.equal(
      await page
        .getByRole('button', { name: '导入中…', exact: true })
        .isDisabled(),
      true,
    )
    await page.evaluate(() => window.releaseImport())
    await page.waitForFunction(() => window.opened === 'imported-3')
    await page
      .getByRole('dialog', { name: '导入聊天记录', exact: true })
      .waitFor({ state: 'detached' })
    assert.equal(
      (await page.evaluate(() => window.imports[2])).folderPath,
      '/workspace/new-project',
    )
    assert.equal(await page.evaluate(() => window.imports.length), 3)
    assert.match(
      await page.evaluate(() => window.notices.at(-1)),
      /已导入.*刷新失败/,
    )
    assert.deepEqual(errors, [])
  } finally {
    await browser?.close()
    await new Promise((resolve) => server.close(resolve))
    await rm(directory, { recursive: true, force: true })
  }
})
