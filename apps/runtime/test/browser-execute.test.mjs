import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { compileBrowserExecution } from '../dist/browser/agent/automation/script.js'
import { browserAutomationFixture } from './fixtures/browser-automation.mjs'
import {
  validBrowserArgs,
  redactBrowserCalls,
} from '../dist/agent/run/browser-admission.js'

const page = {
  tabId: randomUUID(),
  origin: 'https://example.com',
  pageVersion: randomUUID(),
}
test('scripts compile Playwright locators, constants and bounded loops to exact plans without evaluating code', () => {
  const script = `const query = page.getByRole('searchbox', {name:'Query'});
    await query.fill('公开搜索'); await query.press('Enter');
    for (const delta of [100, -100]) { await page.mouse.wheel(0, delta); }
    await page.getByRole('heading', {name:'Footer',exact:true}).scrollIntoViewIfNeeded();
    await page.screenshot({ fullPage:false });`
  const plan = compileBrowserExecution({ mode: 'script', page, script })
  assert.deepEqual(
    plan.steps.map((step) => step.action),
    ['type', 'press', 'scroll', 'scroll', 'reveal', 'screenshot'],
  )
  assert.equal(plan.steps[0].text, '公开搜索')
  assert.equal(plan.steps[3].deltaY, -100)
  for (const script of [
    `await page.evaluate('document.cookie')`,
    `process.exit(0)`,
    `await fetch('https://example.com')`,
    `await page.context().cookies()`,
    `const x = globalThis; await x.read()`,
    `while(true){}`,
    `await page['screenshot']()`,
    `await page.screenshot({path:'/tmp/forbidden'})`,
    `for(const i of [1,2,3,4,5]){await page.screenshot();}`,
  ]) {
    const args = { mode: 'script', page, script }
    assert.throws(
      () => compileBrowserExecution(args),
      /browser_script_invalid|Invalid/,
    )
    assert.equal(validBrowserArgs('browser.execute', args), false)
    assert.equal(
      redactBrowserCalls([
        { id: 'x', name: 'browser.execute', arguments: JSON.stringify(args) },
      ])[0].arguments,
      JSON.stringify(args),
    )
  }
})

for (const display of ['headless', 'headed'])
  test(
    `${display}: generic Playwright plan fills, selects, presses, drags, scrolls and captures`,
    {
      skip:
        display === 'headed' && process.platform !== 'darwin'
          ? 'Windows/Linux GUI pending'
          : false,
    },
    async (t) => {
      const f = await browserAutomationFixture(t, display)
      const target = (role, name) => ({ role, name })
      const result = await f.backend.execute({
        mode: 'actions',
        page: f.metadata.page,
        steps: [
          {
            action: 'type',
            target: target('searchbox', 'Query'),
            text: '普通搜索',
          },
          {
            action: 'select',
            target: target('combobox', 'Choice'),
            values: ['b'],
          },
          {
            action: 'press',
            target: target('searchbox', 'Query'),
            key: 'ControlOrMeta+A',
          },
          {
            action: 'type',
            target: target('searchbox', 'Query'),
            text: 'hello',
          },
          { action: 'hover', target: target('button', 'Hover target') },
          { action: 'click', target: target('button', 'Expand') },
          { action: 'click', target: target('button', 'Counter'), count: 2 },
          {
            action: 'drag',
            source: target('button', 'Drag source'),
            target: target('button', 'Drop target'),
          },
          { action: 'scroll', deltaY: 600 },
          { action: 'screenshot' },
          { action: 'reveal', target: target('heading', 'Footer') },
          { action: 'screenshot' },
          { action: 'read' },
        ],
      })
      assert.equal(result.error, null)
      assert.equal(result.completed, 13)
      assert.equal(result.screenshots.length, 2)
      assert.notEqual(
        result.screenshots[0].image.base64,
        result.screenshots[1].image.base64,
      )
      assert.match(result.document.snapshot, /Expanded detail/)
      assert.equal(
        await f.backend.context.pages()[0].evaluate(() => window.clicks),
        2,
      )
      assert.equal(
        await f.backend.context.pages()[0].evaluate(() => window.drops),
        1,
      )
      assert.equal(f.writes(), 0)
      const script = `await page.getByRole('button',{name:'Counter'}).click();await page.mouse.wheel(0,-300);await page.screenshot();`
      const next = await f.backend.execute(
        compileBrowserExecution({
          mode: 'script',
          page: result.document.page,
          script,
        }),
      )
      assert.equal(next.error, null)
      assert.equal(next.completed, 3)
      assert.equal(
        await f.backend.context.pages()[0].evaluate(() => window.clicks),
        3,
      )
    },
  )

test('partial failure stops remaining steps, keeps window, and timeout prevents background actions', async (t) => {
  const f = await browserAutomationFixture(t)
  const result = await f.backend.execute({
    mode: 'actions',
    page: f.metadata.page,
    steps: [
      { action: 'click', target: { role: 'button', name: 'Counter' } },
      {
        action: 'click',
        target: { role: 'button', name: 'Missing fixture control' },
      },
      { action: 'click', target: { role: 'button', name: 'Counter' } },
    ],
  })
  assert.equal(result.completed, 1)
  assert.equal(result.failedStep, 1)
  assert.equal(result.error, 'browser_target_missing')
  assert.equal(
    await f.backend.context.pages()[0].evaluate(() => window.clicks),
    1,
  )
  assert.equal(f.writes(), 0)
  assert.equal(f.backend.browser.isConnected(), true)
  const current = await f.backend.navigate(f.origin + '/')
  const timeout = await f.backend.execute({
    mode: 'actions',
    page: current.page,
    timeoutMs: 1000,
    steps: [
      { action: 'wait', milliseconds: 2000 },
      { action: 'click', target: { role: 'button', name: 'Counter' } },
    ],
  })
  assert.equal(timeout.error, 'browser_plan_timeout')
  // Under scheduling delays the wait may finish before the timeout callback runs.
  // Its completion is valid accounting; the following click must never begin.
  assert.ok(timeout.completed <= 1)
  assert.equal(timeout.failedStep, 0)
  assert.equal(f.backend.context === null, true)
})

test('deadline observed before its timer still closes the context exactly once', async () => {
  const { executeBrowserPlan } =
    await import('../dist/browser/agent/worker/automation/execute.js')
  const realNow = Date.now
  let closed = 0
  try {
    const result = await executeBrowserPlan(
      { timeoutMs: 1000, steps: [{ action: 'read' }] },
      {
        capture: async () => {
          Date.now = () => realNow() + 2000
          return {}
        },
        page: () => ({ url: () => 'https://example.com/' }),
        current: () => true,
        blocked: () => false,
        invalidate: () => {},
        navigate: async () => {},
        close: async () => {
          closed++
        },
      },
    )
    assert.equal(result.error, 'browser_plan_timeout')
    assert.equal(result.completed, 0)
    assert.equal(closed, 1)
  } finally {
    Date.now = realNow
  }
})

test('timer timeout awaits one asynchronous close before returning', async () => {
  const { executeBrowserPlan } =
    await import('../dist/browser/agent/worker/automation/execute.js')
  let calls = 0
  let closed = false
  const result = await executeBrowserPlan(
    { timeoutMs: 10, steps: [{ action: 'read' }] },
    {
      capture: () => new Promise(() => {}),
      page: () => ({ url: () => 'https://example.com/' }),
      current: () => true,
      blocked: () => false,
      invalidate: () => {},
      navigate: async () => {},
      close: async () => {
        calls++
        await new Promise((resolve) => setTimeout(resolve, 10))
        closed = true
      },
    },
  )
  assert.equal(result.error, 'browser_plan_timeout')
  assert.equal(closed, true)
  assert.equal(calls, 1)
})

test('screenshots preserve the visible page including editable controls and frames', async (t) => {
  const { captureBrowserImage } =
    await import('../dist/browser/agent/worker/automation/screenshot.js')
  const f = await browserAutomationFixture(t)
  try {
    const page = f.backend.context.pages()[0]
    await page.setContent(
      '<input type="text" value="synthetic fixture"><textarea>fixture</textarea><select><option>fixture</option></select><div contenteditable>fixture</div><iframe></iframe>',
    )
    const screenshot = page.screenshot.bind(page)
    let masked
    page.screenshot = async (options) => {
      masked = options.mask
      return screenshot(options)
    }
    const image = await captureBrowserImage(page, false)
    assert.equal(masked, undefined)
    assert.equal(image.mimeType, 'image/jpeg')
    await page.setContent(
      '<div style="width:100000px;height:10px">Public</div>',
    )
    await assert.rejects(
      captureBrowserImage(page, true),
      /browser_interaction_denied/,
    )
  } finally {
    await f.backend.close()
  }
})

test('post-action observation failures preserve the performed step count without replay', async () => {
  const { executeBrowserPlan } =
    await import('../dist/browser/agent/worker/automation/execute.js')
  let captures = 0
  const result = await executeBrowserPlan(
    { timeoutMs: 1000, steps: [{ action: 'wait', milliseconds: 0 }] },
    {
      page: () => ({ url: () => 'https://example.com/' }),
      capture: async () => {
        captures++
        throw new Error('browser_page_loading')
      },
      current: () => true,
      blocked: () => false,
      invalidate: () => {},
      navigate: async () =>
        assert.fail('an observation failure must not navigate'),
      close: async () =>
        assert.fail('a recoverable observation failure must retain the page'),
    },
  )
  assert.equal(result.completed, 1)
  assert.equal(result.failedStep, 0)
  assert.equal(result.failurePhase, 'after-action')
  assert.equal(result.error, 'browser_page_loading')
  assert.equal(captures, 1)
})
