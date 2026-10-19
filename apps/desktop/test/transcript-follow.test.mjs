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

test('transcript follows resizing replies, pauses for reading, and resumes at the bottom', async () => {
  const root = fileURLToPath(new URL('..', import.meta.url))
  const built = await build({
    stdin: {
      resolveDir: root,
      loader: 'tsx',
      contents: `import React,{useRef,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {VirtualTranscript} from './frontend/features/chat/transcript/VirtualTranscript';
import {useTranscriptFollow} from './frontend/features/chat/transcript/useTranscriptFollow';
const initial=Array.from({length:50},(_,i)=>({kind:'plain',item:{message:{id:String(i)}}}));
function Fixture(){
 const ref=useRef(null);const [session,setSession]=useState('a');
 const follow=useTranscriptFollow(ref,session);
 const [blocks,setBlocks]=useState(initial);const [height,setHeight]=useState(800);
 window.fixture={grow:()=>setHeight(h=>h+300),collapse:()=>setHeight(100),
 prepend:()=>setBlocks(b=>[{kind:'plain',item:{message:{id:'older'}}},...b]),
 switch:()=>setSession('b')};
 return <><button onClick={follow.scrollToBottom}>Bottom</button>
 <output>{String(follow.pinned)}</output>
 <div id="scroll" ref={ref} onScroll={follow.handleScroll} onWheel={follow.handleWheel}
 tabIndex={0} style={{height:400,width:600,overflow:'auto',overflowAnchor:'none'}}>
 <VirtualTranscript key={session} blocks={blocks} scrollRef={ref} pinned={follow.pinned}
 onScrollPositioned={follow.recordPosition}
 renderBlock={b=><div style={{height:b.item.message.id==='49'?height:150}}>{b.item.message.id}</div>}/>
 </div></>
}
createRoot(document.getElementById('root')).render(<Fixture/>);`,
    },
    bundle: true,
    format: 'iife',
    jsx: 'automatic',
    write: false,
  })
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    await page.setContent('<div id="root"></div>')
    await page.addScriptTag({ content: built.outputFiles[0].text })
    const bottom = async () => {
      await page.evaluate(
        () =>
          new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
          ),
      )
      return page.waitForFunction(() => {
        const el = document.querySelector('#scroll')
        return (
          el.scrollHeight - el.scrollTop - el.clientHeight <= 1 &&
          document.querySelector('output').textContent === 'true'
        )
      })
    }
    await bottom()
    for (let i = 0; i < 4; i++) {
      await page.evaluate(() => window.fixture.grow())
      await bottom()
    }
    await page.evaluate(() => window.fixture.collapse())
    await bottom()
    await page.evaluate(() => window.fixture.grow())
    await bottom()

    // ResizeObserver must also follow DOM growth without a React/stream update.
    await page.evaluate(() => {
      document.querySelector('[data-block-id="49"] > div').style.height =
        '1500px'
    })
    await bottom()
    await page.locator('#scroll').hover()
    await page.mouse.wheel(0, -500)
    await page.waitForFunction(
      () => document.querySelector('output').textContent === 'false',
    )
    await page.waitForFunction(() => {
      const el = document.querySelector('#scroll')
      return el.scrollHeight - el.scrollTop - el.clientHeight > 300
    })
    const readingTop = await page
      .locator('#scroll')
      .evaluate((el) => el.scrollTop)
    await page.evaluate(() => {
      document.querySelector('[data-block-id="49"] > div').style.height =
        '1800px'
    })
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    )
    assert.equal(await page.locator('output').textContent(), 'false')
    assert.ok(
      Math.abs(
        (await page.locator('#scroll').evaluate((el) => el.scrollTop)) -
          readingTop,
      ) < 2,
    )
    await page.getByText('Bottom', { exact: true }).click()
    await bottom()

    // A scrollbar position change, without wheel input, also pauses.
    await page.locator('#scroll').focus()
    await page.locator('#scroll').evaluate((el) => {
      el.scrollTop -= 300
    })
    await page.waitForFunction(
      () => document.querySelector('output').textContent === 'false',
    )
    await page.locator('#scroll').evaluate((el) => {
      el.scrollTop = el.scrollHeight
    })
    await bottom()
    await page.locator('#scroll').evaluate((el) => {
      el.scrollTop = 2000
    })
    await page.waitForFunction(
      () => document.querySelector('output').textContent === 'false',
    )
    const anchor = await page.locator('#scroll').evaluate((el) => {
      const row = [...el.querySelectorAll('[data-block-id]')].find(
        (row) =>
          row.getBoundingClientRect().bottom > el.getBoundingClientRect().top,
      )
      return { id: row.dataset.blockId, top: row.getBoundingClientRect().top }
    })
    await page.evaluate(() => window.fixture.prepend())
    await page.waitForFunction(({ id, top }) => {
      const row = document.querySelector('[data-block-id="' + id + '"]')
      return row && Math.abs(row.getBoundingClientRect().top - top) < 2
    }, anchor)
    await page.evaluate(() => window.fixture.switch())
    await bottom()
  } finally {
    await browser.close()
  }
})
