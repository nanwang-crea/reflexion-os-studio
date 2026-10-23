import { build } from 'esbuild'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { browserWorkerPaths } from '../../../runtime/dist/browser/agent/paths.js'
const require = createRequire(
  new URL('../../../runtime/package.json', import.meta.url),
)
process.env.PLAYWRIGHT_BROWSERS_PATH = browserWorkerPaths().browsers
const { chromium } = require('playwright')
const desktop = fileURLToPath(new URL('../..', import.meta.url))
export async function openDeveloperPage() {
  const built = await build({
    absWorkingDir: desktop,
    bundle: true,
    format: 'iife',
    jsx: 'automatic',
    write: false,
    outdir: '/tmp/reflexion-developer-test',
    plugins: [
      {
        name: 'developer-api',
        setup(build) {
          build.onLoad(
            { filter: /frontend[\\/]api[\\/]developer\.ts$/ },
            async () => ({
              contents: await readFile(
                new URL('./developer-api.mjs', import.meta.url),
                'utf8',
              ),
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
import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
import {SettingsView} from './frontend/features/settings/SettingsView';import './frontend/features/settings/settings.css';
import {Sidebar} from './frontend/components/Sidebar';import './frontend/styles/style.css';import './frontend/styles/sidebar.css';
window.calls=[];window.listeners=new Set();window.opened=[];
const root=createRoot(document.getElementById('root'));window.unmount=()=>root.unmount();
function App(){const [view,setView]=useState('chat');return <>
<Sidebar open width={220} mode="chat" projects={[]} allSessions={[]} standaloneSessions={[]} view={view} systemReady={false} onSelectView={setView}/>
<main style={{display:'flex',flex:1,minWidth:0}}>{view==='settings'&&<SettingsView profiles={[]} onSaved={async()=>{}} onBackToChat={()=>setView('chat')} confirm={async()=>true} developer={{projects:[{id:'project',name:'测试项目'}],profiles:[{id:'provider',name:'测试供应商'}],onConversation:(sessionId,projectId)=>window.opened.push({sessionId,projectId})}}/>}</main></>}
root.render(<App/>);`,
    },
  })
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage({
      viewport: { width: 1280, height: 900 },
      timezoneId: 'Asia/Shanghai',
    })
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.setContent(
      '<!doctype html><meta charset="utf-8"><div id="root" style="display:flex;height:100vh;min-width:0"></div>',
    )
    await page.addStyleTag({
      content:
        built.outputFiles.find((file) => file.path.endsWith('.css')).text +
        '@media(max-width:700px){.sidebar{display:none}}',
    })
    await page.addScriptTag({
      content: built.outputFiles.find((file) => file.path.endsWith('.js')).text,
    })
    return { browser, page, errors }
  } catch (error) {
    await browser.close()
    throw error
  }
}
