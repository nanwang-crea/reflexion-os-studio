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
const source = Array.from(
  { length: 150 },
  (_, index) => `// source line ${index + 1}`,
).join('\n')
const links =
  '[省略项目](workspace://apps/src/a.ts#L47) [标准引用](workspace://p/apps/src/a.ts#L47) [另一个位置](workspace://p/apps/src/a.ts#L80) [其他项目](workspace://other/apps/src/a.ts#L2) [未知项目](workspace://00000000-0000-0000-0000-000000000000/apps/src/a.ts#L2) [Markdown](workspace://p/docs/guide.md)'

test('file citations open the real Monaco viewer, repeat line jumps, preserve drafts and activate the file surface', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'workspace-navigation-'))
  const server = createServer()
  let browser
  try {
    await build({
      absWorkingDir: desktop,
      entryPoints: ['test/fixtures/workspace-navigation.tsx'],
      bundle: true,
      format: 'iife',
      jsx: 'automatic',
      loader: { '.ttf': 'file' },
      define: { 'import.meta.env.VITE_TERMINAL_DISABLED': '"1"' },
      outfile: join(directory, 'app.js'),
      plugins: [
        {
          name: 'isolated-workspace',
          setup(build) {
            build.onLoad(
              { filter: /frontend[/\\]lib[/\\]transport\.ts$/ },
              () => ({
                contents: `
          window.directoryChecks=[]; window.reads=[]; const listeners=new Set(); let id=0;
          export const newRequestId=()=>String(++id);
          export const transport={onEvent:(listener)=>{listeners.add(listener);return()=>listeners.delete(listener)},request:async(method,params)=>{
            if(method==='workspace.list_dir'){
              window.directoryChecks.push([params.projectId,params.path]);
              if(window.holdDirectory)return new Promise(resolve=>window.resolveDirectory=()=>resolve({entries:[],truncated:false,returnedCount:0}));
              if(params.path!=='apps')throw new Error('Directory not found');
              return {entries:[],truncated:false,returnedCount:0};
            }
            if(method==='workspace.read_file'){
              window.reads.push(params.path);
              const content=params.path==='docs/guide.md'?'[打开源码](../apps/src/a.ts#L51)':${JSON.stringify(source)};
              const lines=content.split('\\n'); const offset=params.offset??0; const selected=lines.slice(offset,offset+(params.limit??200));
              return {content:selected.join('\\n'),sizeBytes:content.length,totalLines:lines.length,offset,readComplete:offset===0&&selected.length===lines.length,readToken:'synthetic'};
            }
            if(method==='workspace.watch_dir')return {watchId:'synthetic'};
            if(method==='workspace.unwatch_dir')return {removed:true};
            throw new Error('Unexpected fixture request: '+method);
          }};
        `,
                loader: 'js',
              }),
            )
            build.onLoad({ filter: /ChatView\.tsx$/ }, () => ({
              contents: `import {MarkdownCore} from '../../components/markdown/md-core'; export function ChatView(props){return <div className="chat-view"><MarkdownCore text={${JSON.stringify(links)}} onResourceClick={props.onResourceClick}/></div>}`,
              loader: 'tsx',
            }))
            build.onLoad(
              { filter: /(?:BrowserSurfacePanel|CollaborationPanel)\.tsx$/ },
              ({ path }) => {
                const name = path.split('/').at(-1).replace('.tsx', '')
                return {
                  contents: `export function ${name}(){return <div>${name}</div>}`,
                  loader: 'tsx',
                }
              },
            )
          },
        },
      ],
    })
    server.on('request', async (request, response) => {
      const path = new URL(request.url, 'http://fixture').pathname
      if (path === '/favicon.ico') {
        response.statusCode = 204
        response.end()
        return
      }
      response.setHeader(
        'content-type',
        path.endsWith('.js')
          ? 'text/javascript'
          : path.endsWith('.css')
            ? 'text/css'
            : path.endsWith('.ttf')
              ? 'font/ttf'
              : 'text/html',
      )
      response.end(
        path === '/'
          ? '<meta charset="utf-8"><style>#root{height:100vh}.main-pane{height:100%}</style><link rel="stylesheet" href="/app.css"><div id="root"></div><script src="/app.js"></script>'
          : await readFile(join(directory, path.slice(1))),
      )
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    browser = await chromium.launch({
      channel: 'chromium',
      headless: true,
      chromiumSandbox: true,
    })
    const page = await browser.newPage({
      viewport: { width: 1400, height: 850 },
    })
    page.setDefaultTimeout(10000)
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    const url = `http://127.0.0.1:${server.address().port}`
    await page.goto(url)
    const click = (name) =>
      page.getByRole('button', { name, exact: true }).click()
    const position = (line) =>
      page.waitForFunction(
        (line) =>
          window.editors.some(
            (editor) =>
              !editor.getModel()?.isDisposed() &&
              editor.getPosition()?.lineNumber === line &&
              editor
                .getVisibleRanges()
                .some(
                  (range) =>
                    range.startLineNumber <= line &&
                    range.endLineNumber >= line,
                ),
          ),
        line,
      )
    await click('省略项目')
    await page.locator('.monaco-editor-instance').waitFor()
    await position(47).catch(async (error) => {
      await page.screenshot({
        path: '/tmp/reflexion-file-navigation-failure.png',
      })
      console.log(
        await page.evaluate(() => ({
          editors: window.editors.map((editor) => ({
            position: editor.getPosition(),
            ranges: editor.getVisibleRanges(),
            layout: editor.getLayoutInfo(),
          })),
          containers: [
            ...document.querySelectorAll(
              '.right-surface,.workspace-panel,.workspace-tab-page,.monaco-body,.monaco-editor-instance',
            ),
          ].map((el) => ({
            class: el.className,
            rect: el.getBoundingClientRect().toJSON(),
          })),
        })),
      )
      throw error
    })
    assert.deepEqual(await page.evaluate(() => window.directoryChecks), [
      ['p', 'apps'],
    ])
    assert.equal(
      await page.evaluate(() => window.navigationState.tabs[0].path),
      'apps/src/a.ts',
    )
    await page.evaluate(() =>
      window.editors[0].setPosition({ lineNumber: 3, column: 1 }),
    )
    await click('标准引用')
    await position(47)
    await click('另一个位置')
    await position(80)
    const edited = source + '\n// unsaved draft'
    await page.evaluate((value) => window.editors[0].setValue(value), edited)
    await page.getByText('未保存', { exact: true }).waitFor()
    for (const surface of ['网页浏览', '任务与 Agent 协作']) {
      await click('对话工具菜单')
      await page
        .getByRole('menuitemcheckbox', { name: surface, exact: true })
        .click()
      await page.locator('.monaco-editor-instance').waitFor({ state: 'hidden' })
      await click('标准引用')
      await page
        .locator('.monaco-editor-instance')
        .waitFor({ state: 'visible' })
      await position(47)
      assert.equal(
        await page.evaluate(() => window.editors[0].getValue()),
        edited,
      )
      assert.equal(await page.evaluate(() => window.editors.length), 1)
    }
    await click('其他项目')
    await page.getByText('资源不属于当前项目', { exact: true }).waitFor()
    await click('关闭')
    await click('未知项目')
    await page.getByText('资源不属于当前项目', { exact: true }).waitFor()
    assert.equal(await page.evaluate(() => window.directoryChecks.length), 1)
    await click('Markdown')
    await page.getByRole('link', { name: '打开源码', exact: true }).waitFor()
    await page.getByRole('link', { name: '打开源码', exact: true }).click()
    await position(51)
    assert.equal(
      await page.evaluate(() => window.editors[0].getValue()),
      edited,
    )
    await page.waitForTimeout(200)
    const commits = await page.evaluate(() => window.commits)
    await page.waitForTimeout(400)
    assert.equal(await page.evaluate(() => window.commits), commits)
    assert.deepEqual(errors, [])

    await page.goto(url)
    await page.evaluate(() => {
      window.holdDirectory = true
    })
    await click('省略项目')
    await page.waitForFunction(() => window.resolveDirectory !== undefined)
    await click('另一个位置')
    await position(80)
    await page.evaluate(() => window.resolveDirectory())
    await page.waitForTimeout(100)
    assert.equal(
      await page.evaluate(() => window.editors[0].getPosition().lineNumber),
      80,
    )

    await page.goto(url)
    await page.evaluate(() => {
      window.holdDirectory = true
    })
    await click('省略项目')
    await page.waitForFunction(() => window.resolveDirectory !== undefined)
    await page.evaluate(() => window.switchProject())
    await page.evaluate(() => window.resolveDirectory())
    await page.waitForTimeout(100)
    assert.equal(
      await page.evaluate(() => window.navigationState.tabs.length),
      0,
    )
  } finally {
    await browser?.close()
    await new Promise((resolve) => server.close(resolve))
    await rm(directory, { recursive: true, force: true })
  }
})
