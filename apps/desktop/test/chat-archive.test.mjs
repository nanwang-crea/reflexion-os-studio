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
import './frontend/styles/sidebar.css';
import {TopBar} from './frontend/components/TopBar';
import {SessionRow} from './frontend/components/SessionRow';
import {ChatsPanel} from './frontend/components/session/ChatsPanel';
import {ChatImportDialog} from './frontend/features/chat/archive/ChatImportDialog';
import {useChatArchiveActions} from './frontend/features/chat/archive/useChatArchiveActions';
window.selections=[];window.imports=[];window.exports=[];window.notices=[];window.allowSwitch=true;window.guardCalls=0;
function App(){const [empty,setEmpty]=React.useState(false);window.showEmpty=()=>setEmpty(true);const [session,setSession]=React.useState(null);const [project,setProject]=React.useState(null);const archive=useChatArchiveActions({activeSessionId:session,activeProjectId:project,setNotice:n=>window.notices.push(n),guardedResetWorkspaceFiles:async()=>{window.guardCalls++;return window.allowSwitch},refreshProjects:async()=>{if(window.refreshFails)throw Error('refresh failed')},refreshSessions:async()=>{},setActiveProjectId:setProject,openSession:id=>{window.opened=id;setSession(id)}});
return <><TopBar contextTitle="聊天" runtimeState="system-ready" statusLabel="" sidebarOpen={true} onToggleSidebar={()=>{}} browserOpen={false} onToggleBrowser={()=>{}} showWorkspaceToggle={false} showTerminalToggle={false} workspaceOpen={false} terminalOpen={false} onToggleWorkspace={()=>{}} onToggleTerminal={()=>{}}/>
{empty?<ChatsPanel projects={[]} allSessions={[]} standaloneSessions={[]} activeProjectId="p1" activeSessionId={null} creatingProject={false} onSelectProject={()=>{}} onSelectProjectSession={()=>{}} onSelectStandaloneSession={()=>{}} onNewSessionInProject={()=>{}} onEnterProjectFiles={()=>{}} onCreateProject={async()=>{}} onNewChat={()=>{}} onDeleteProject={async()=>{}} onRenameSession={async()=>{}} onDeleteSession={async()=>{}} onImportChat={archive.openImport} onExportChat={id=>void archive.exportChat(id)}/>: [{id:'source-standalone',title:'独立会话',projectId:null},{id:'source-project',title:'项目会话',projectId:'p1'}].map(row=><SessionRow key={row.id} session={row} active={session===row.id} archiveBusy={archive.busy} onSelect={()=>{window.selected=row.id;setSession(row.id)}} onRename={async title=>{window.renamed=title}} onDelete={async()=>{window.deleted=row.id}} onImport={()=>archive.openImport(row.projectId)} onExport={()=>void archive.exportChat(row.id)}/>)}
{archive.importOpen&&<ChatImportDialog projectId={archive.importProjectId} projects={[{id:'p1',name:'项目一'}]} onImport={archive.importChat} onClose={archive.closeImport}/>}</>}

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
    const showImport = async (title = '独立会话') => {
      await page
        .getByRole('button', { name: title, exact: true })
        .click({ button: 'right' })
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
    await page
      .getByRole('button', { name: '对话工具菜单', exact: true })
      .click()
    assert.equal(
      await page
        .getByRole('menuitem', { name: '导入聊天记录…', exact: true })
        .count(),
      0,
    )
    await page.keyboard.press('Escape')
    const source = page.getByRole('button', { name: '独立会话', exact: true })
    await source.focus()
    await page.keyboard.press('Shift+F10')
    await page
      .getByRole('menuitem', { name: '导入聊天记录…', exact: true })
      .waitFor()
    await page.keyboard.press('Escape')
    await page.waitForFunction(
      () => document.activeElement?.getAttribute('title') === '独立会话',
    )
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
      .getByRole('button', { name: '项目会话', exact: true })
      .click({ button: 'right' })
    await page
      .getByRole('menuitem', { name: '导出聊天记录…', exact: true })
      .click()
    await page.waitForFunction(() => window.exports.length === 1)
    assert.deepEqual(await page.evaluate(() => window.exports[0]), {
      sessionId: 'source-project',
      directory: '/exports',
    })
    assert.equal(await page.evaluate(() => window.selected), undefined)
    await showImport('项目会话')
    assert.match(
      await page
        .getByRole('combobox', { name: '导入位置', exact: true })
        .textContent(),
      /项目一/,
    )
    await page.keyboard.press('Escape')
    await page
      .getByRole('dialog', { name: '导入聊天记录', exact: true })
      .waitFor({ state: 'detached' })

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
    await page.setViewportSize({ width: 390, height: 844 })
    await source.click({ button: 'right', position: { x: 10, y: 10 } })
    const menu = page.getByRole('menu')
    const bounds = await menu.boundingBox()
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 390)
    assert.ok(bounds.y >= 0 && bounds.y + bounds.height <= 844)
    await page.screenshot({ path: '/tmp/reflexion-session-context-menu.png' })
    await page.keyboard.press('Escape')
    await page.evaluate(() => window.showEmpty())
    await page
      .getByRole('button', { name: '导入聊天记录…', exact: true })
      .click()
    await page
      .getByRole('dialog', { name: '导入聊天记录', exact: true })
      .waitFor()
    assert.match(
      await page
        .getByRole('combobox', { name: '导入位置', exact: true })
        .textContent(),
      /项目一/,
    )
    await page.keyboard.press('Escape')
    assert.deepEqual(errors, [])
  } finally {
    await browser?.close()
    await new Promise((resolve) => server.close(resolve))
    await rm(directory, { recursive: true, force: true })
  }
})
