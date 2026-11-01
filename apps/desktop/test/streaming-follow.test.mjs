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

// 真实 Markdown：标题/长段落/列表/代码块/表格，混入 CJK 与 emoji。
// 重复长段落制造持续的高度增长，逼近真实长回复。
const PARAGRAPH =
  '这一段包含足够多的中文文字，用来制造持续的高度增长：权限模型、审批队列、沙箱边界、虚拟列表与渲染层的双缓冲实现都需要在这条链路上被反复验证，因此段落会在客户端里持续换行并让转录块不断变高，直到正文超出可见视口数倍。'
const MARKDOWN = [
  '# 流式跟随验收',
  '',
  PARAGRAPH,
  '',
  '## 列表',
  '',
  '- 第一项：验证自动贴底 🎉',
  '- 第二项：验证 Markdown 结构不被拆坏',
  '- 第三项：验证旧内容不会重复动画',
  '- 第四项：`inline code` 与 **bold** 与 [link](https://example.com)',
  '',
  '## 代码',
  '',
  '```ts',
  'export function useTranscriptFollow(scrollRef, sessionId) {',
  '  const [pinned, setPinned] = useState(true)',
  '  return { pinned, handleScroll, handleWheel, scrollToBottom }',
  '}',
  '```',
  '',
  '## 表格',
  '',
  '| 平台 | 沙箱 | 状态 |',
  '| --- | --- | --- |',
  '| macOS | Seatbelt | 已验收 |',
  '| Linux | bwrap | 待真机 |',
  '| Windows | 受限令牌 | 待真机 |',
  '',
  '## 结论',
  '',
  PARAGRAPH,
  PARAGRAPH,
  '',
  '最后一句话。',
].join('\n')

async function buildFixtureBundle(options) {
  const root = fileURLToPath(new URL('..', import.meta.url))
  const built = await build({
    stdin: {
      resolveDir: root,
      loader: 'tsx',
      contents: `import React,{useEffect,useRef,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {VirtualTranscript} from './frontend/features/chat/transcript/VirtualTranscript';
import {useTranscriptFollow} from './frontend/features/chat/transcript/useTranscriptFollow';
import {AssistantMessage} from './frontend/features/chat/message/AssistantMessage';
const MARKDOWN_TEXT = ${JSON.stringify(MARKDOWN)};
const CHUNK = ${options.chunk};
const INTERVAL = ${options.intervalMs};
const PRIOR = ${options.prior};
const PRIOR_HEIGHT = ${options.priorHeight};
const VIEWPORT = ${options.viewportHeight};
function Fixture(){
  const ref = useRef(null);
  const follow = useTranscriptFollow(ref, 's1');
  const [chars, setChars] = useState(0);
  const streaming = chars > 0 ? {a1: MARKDOWN_TEXT.slice(0, chars)} : {};
  const done = chars >= MARKDOWN_TEXT.length;
  const message = {
    id: 'a1', role: 'assistant', content: '', parts: [], status: 'streaming',
    reasoning: '', runId: null, createdAt: 1, completedAt: null,
    tokenCount: null, modelMeta: null, sessionVersionAt: 1,
  };
  const blocks = [
    ...Array.from({length: PRIOR}, (_, i) => ({
      kind: 'plain', item: {message: {id: 'p' + i}, prior: true},
    })),
    {kind: 'plain', item: {message, prior: false}},
  ];
  useEffect(() => {
    const timer = setInterval(() => {
      setChars((current) => {
        if (current >= MARKDOWN_TEXT.length) { clearInterval(timer); return current }
        return current + CHUNK
      });
    }, INTERVAL);
    return () => clearInterval(timer);
  }, []);
  window.fixture = {
    state: () => {
      const el = document.querySelector('#scroll');
      return {
        chars, total: MARKDOWN_TEXT.length, done, pinned: follow.pinned,
        scrollable: el.scrollHeight > el.clientHeight + 40,
      };
    },
  };
  return <>
    <output>{String(follow.pinned)}</output>
    <div id="scroll" ref={ref} onScroll={follow.handleScroll}
      onWheel={follow.handleWheel}
      style={{height:VIEWPORT,width:640,overflow:'auto',overflowAnchor:'none'}}>
      <VirtualTranscript blocks={blocks} scrollRef={ref} pinned={follow.pinned}
        onScrollPositioned={follow.recordPosition}
        renderBlock={(b) => b.item.prior
          ? <div style={{height: PRIOR_HEIGHT}}>{b.item.message.id}</div>
          : <AssistantMessage message={b.item.message} toolCalls={[]}
              runActive streamingText={streaming.a1}
              streamingReasoning={undefined} runDurationMs={null}
              runUsage={null} canRetry={false} onRetry={() => {}} />}/>
    </div>
  </>
}
createRoot(document.getElementById('root')).render(<Fixture/>);`,
    },
    bundle: true,
    format: 'iife',
    jsx: 'automatic',
    loader: { '.css': 'empty' },
    write: false,
  })
  return built.outputFiles[0].text
}

async function openFixture(page, script) {
  await page.setContent('<div id="root"></div>')
  page.on('pageerror', (error) => console.log('[pageerror]', error.message))
  await page.addScriptTag({ content: script })
}

async function distanceFromBottom(page) {
  return page.evaluate(() => {
    const el = document.querySelector('#scroll')
    return el.scrollHeight - el.scrollTop - el.clientHeight
  })
}

async function nextFrames(page) {
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  )
}

/**
 * 跑一轮流式跟随：逐帧采样离底距离，断言全程贴底、结束后收敛到底。
 * maxGap 给虚拟列表未测量块（estimate 160px）的瞬时误差留余量。
 */
async function watchStreaming(page, { maxGap, label }) {
  let worst = 0
  let sawOverflow = false
  let unpinned = false
  let frames = 0
  const trace = []
  for (let frame = 0; frame < 900; frame += 1) {
    await nextFrames(page)
    frames += 1
    const gap = await distanceFromBottom(page)
    const state = await page.evaluate(() => window.fixture.state())
    if (gap > worst) worst = gap
    if (state.scrollable) sawOverflow = true
    if (!state.pinned) unpinned = true
    if (frame % 15 === 0) trace.push(`${state.chars}:${Math.round(gap)}`)
    if (state.done) break
  }
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 220)))
  const finalGap = await distanceFromBottom(page)
  console.log(
    `[streaming-follow:${label}] worst=${Math.round(worst)} final=${Math.round(finalGap)} overflow=${sawOverflow} frames=${frames} trace=${trace.slice(0, 5).join(' ')}`,
  )
  assert.equal(
    unpinned,
    false,
    `[${label}] 流式期间跟随状态被误判为用户上翻，自动贴底中断`,
  )
  assert.ok(sawOverflow, `[${label}] fixture 未产生溢出，测试无效`)
  assert.ok(
    finalGap <= 1,
    `[${label}] 流式结束后未贴底，距底 ${finalGap}px（旧版本停在半路）`,
  )
  assert.ok(
    worst <= maxGap,
    `[${label}] 流式过程中离底 ${Math.round(worst)}px 超过 ${maxGap}px，正文会跑出视口`,
  )
}

test('长会话中的流式长回复持续贴底', async () => {
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage()
  try {
    await openFixture(
      page,
      await buildFixtureBundle({
        chunk: 40,
        intervalMs: 16,
        prior: 40,
        priorHeight: 120,
        viewportHeight: 420,
      }),
    )
    await watchStreaming(page, { maxGap: 90, label: 'long-session' })
  } finally {
    await browser.close()
  }
})

test('单条超长回复高频增量仍然贴底', async () => {
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage()
  try {
    await openFixture(
      page,
      await buildFixtureBundle({
        chunk: 80,
        intervalMs: 10,
        prior: 0,
        priorHeight: 120,
        viewportHeight: 320,
      }),
    )
    await watchStreaming(page, { maxGap: 90, label: 'fast-single' })
  } finally {
    await browser.close()
  }
})

test('流式 Markdown 结构完整且不留控制符', async () => {
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage()
  try {
    await openFixture(
      page,
      await buildFixtureBundle({
        chunk: 24,
        intervalMs: 12,
        prior: 2,
        priorHeight: 100,
        viewportHeight: 380,
      }),
    )
    await watchStreaming(page, { maxGap: 90, label: 'markdown' })
    const structure = await page.evaluate(() => {
      const body = document.querySelector('.assistant-content .md')
      if (!body) return null
      return {
        h1: body.querySelectorAll('h1').length,
        h2: body.querySelectorAll('h2').length,
        li: body.querySelectorAll('ul > li').length,
        pre: body.querySelectorAll('pre').length,
        tableRows: body.querySelectorAll('table tbody tr').length,
        text: body.textContent,
        streamingTailCount: body.querySelectorAll(
          '[data-streaming-tail="true"]',
        ).length,
      }
    })
    assert.ok(structure, '流式结束后 Markdown 容器丢失')
    assert.equal(
      structure.streamingTailCount,
      0,
      '流式结束后不应残留新增块动画标记',
    )
    assert.equal(structure.h1, 1, '一级标题数量错误，说明标题被拆坏')
    assert.equal(structure.h2, 4, '二级标题数量错误，说明小节被拆坏')
    assert.equal(structure.li, 4, '列表项数量错误，说明列表被拆坏')
    assert.equal(structure.pre, 1, '代码块数量错误，说明围栏被拆坏')
    assert.equal(structure.tableRows, 3, '表格行数错误，说明表格被拆坏')
    assert.ok(
      structure.text.includes('最后一句话。'),
      '流式结束仍缺尾部内容，说明增量丢失',
    )
    for (const marker of ['```', '# ', '**', '| ---']) {
      assert.ok(
        !structure.text.includes(marker),
        `正文残留 Markdown 控制符「${marker}」，说明结构未被正确渲染`,
      )
    }
  } finally {
    await browser.close()
  }
})
