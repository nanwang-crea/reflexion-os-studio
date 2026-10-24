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
const desktop = fileURLToPath(new URL('..', import.meta.url))
const built = await build({
  absWorkingDir: desktop,
  stdin: {
    resolveDir: desktop,
    loader: 'tsx',
    contents: `
import React, {StrictMode} from 'react';import {createRoot} from 'react-dom/client';
import {useAppBootstrap} from './frontend/hooks/useAppBootstrap';
import {usePendingApprovals} from './frontend/hooks/permissions/usePendingApprovals';
import {usePendingInteractions} from './frontend/hooks/interactions/usePendingInteractions';
import {useApprovalResolution} from './frontend/hooks/permissions/useApprovalResolution';
import {ApprovalQueue} from './frontend/features/chat/approvals/ApprovalQueue';
window.notices=[];window.initialLoads=0;window.commits=0;
const noop=async()=>{};
const deps={activeSessionRef:{current:'session'},activeProjectRef:{current:null},refreshProfiles:async()=>{window.initialLoads++},refreshProjects:noop,refreshSessions:noop,refreshDelegations:noop,setNotice:notice=>window.notices.push(notice),onDangerChanged:()=>{},refreshSessionData:noop};
function App(){const approvals=usePendingApprovals();window.approvals=approvals;window.interactions=usePendingInteractions();window.app=useAppBootstrap(deps);const choose=useApprovalResolution({pendingApprovals:approvals.pendingApprovals,clearPendingApproval:approvals.removePending,restorePendingApproval:approvals.restorePending,setNotice:deps.setNotice});return <ApprovalQueue approvals={approvals.pendingApprovals} onChoose={(id,choice)=>void choose(id,choice)}/>}
const root=createRoot(document.getElementById('root'));window.unmount=()=>root.unmount();root.render(<StrictMode><React.Profiler id="pending" onRender={()=>window.commits++}><App/></React.Profiler></StrictMode>);
`,
  },
  bundle: true,
  format: 'iife',
  jsx: 'automatic',
  write: false,
  plugins: [
    {
      name: 'pending-boundaries',
      setup(build) {
        build.onResolve(
          {
            filter:
              /lib\/transport$|api\/chat$|^@tauri-apps\/api\/(core|event)$/,
          },
          ({ path }) => ({ path, namespace: 'fixture' }),
        )
        build.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({
          contents: path.endsWith('/transport')
            ? `const listeners=new Set();window.emitEvent=event=>listeners.forEach(fn=>fn(event));window.listenerCount=()=>listeners.size;export const transport={attach:async()=>{},onEvent:fn=>{listeners.add(fn);return()=>listeners.delete(fn)}}`
            : path.endsWith('/chat')
              ? `window.approvalCalls=0;export const resolveApproval=async()=>{window.approvalCalls++;throw Error('fixture approval request failed')};export const listPendingInteractions=()=>new Promise((resolve,reject)=>{window.resolvePending=interactions=>resolve({interactions});window.rejectPending=reject})`
              : path.endsWith('/core')
                ? `export const invoke=async()=>({state:'system-ready',runtimeReady:true,systemReady:true})`
                : `export const listen=async()=>()=>{}`,
        }))
      },
    },
  ],
})

async function withPage(run) {
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    page.setDefaultTimeout(5000)
    await page.setContent('<!doctype html><main id="root"></main>')
    await page.addScriptTag({ content: built.outputFiles[0].text })
    await page.waitForFunction(() => window.resolvePending && window.app)
    await run(page)
  } finally {
    await browser.close()
  }
}

const approval = (id) => ({
  toolCallId: id,
  runId: 'run',
  sessionId: 'session',
  operation: 'file.edit',
  summary: id,
})
const interaction = (id) => ({
  id,
  interactionId: id,
  toolCallId: id,
  sessionId: 'session',
  runId: 'run',
  kind: 'user_question',
  questions: [],
})

test('message and plan updates retain pending cards; only Run terminal events clear them', async () => {
  await withPage(async (page) => {
    await page.evaluate(() => window.resolvePending([]))
    await page.waitForFunction(() => window.initialLoads > 0)
    await page.evaluate(
      ({ approval, interaction }) => {
        emitEvent({ ...approval, type: 'approval.required', scope: 'run' })
        emitEvent({
          ...interaction,
          type: 'interaction.required',
          scope: 'run',
        })
      },
      { approval: approval('approval'), interaction: interaction('question') },
    )
    await page.waitForFunction(
      () =>
        app.pendingApprovals.length === 1 &&
        app.pendingInteractions.length === 1,
    )
    for (const type of [
      'message.completed',
      'plan.created',
      'plan.step.updated',
      'plan.updated',
    ]) {
      await page.evaluate(
        (type) =>
          emitEvent({
            type,
            scope: 'run',
            runId: 'run',
            messageId: 'message',
            content: 'done',
          }),
        type,
      )
      await page.waitForTimeout(30)
      assert.equal(
        await page.evaluate(() => app.pendingApprovals.length),
        1,
        type,
      )
      assert.equal(
        await page.evaluate(() => app.pendingInteractions.length),
        1,
        type,
      )
    }
    await page.evaluate(() =>
      emitEvent({ type: 'run.cancelled', scope: 'run', runId: 'run' }),
    )
    await page.waitForFunction(
      () => !app.pendingApprovals.length && !app.pendingInteractions.length,
    )
    assert.equal(await page.evaluate(() => listenerCount()), 1)
    const commits = await page.evaluate(() => window.commits)
    await page.waitForTimeout(100)
    assert.equal(
      await page.evaluate(() => window.commits),
      commits,
      'idle does not re-render',
    )
    await page.evaluate(() => window.unmount())
    assert.equal(await page.evaluate(() => listenerCount()), 0)
  })
})

test('initial pending snapshot cannot drop new questions or revive resolved and cancelled questions', async () => {
  await withPage(async (page) => {
    await page.evaluate(
      ({ newQuestion, stale }) => {
        emitEvent({
          ...newQuestion,
          type: 'interaction.required',
          scope: 'run',
        })
        emitEvent({
          type: 'interaction.resolved',
          scope: 'run',
          runId: 'run',
          interactionId: stale.id,
        })
        emitEvent({
          type: 'run.cancelled',
          scope: 'run',
          runId: 'cancelled-run',
        })
        window.resolvePending([
          stale,
          { ...stale, id: 'cancelled', runId: 'cancelled-run' },
          { ...stale, id: 'older' },
        ])
      },
      { newQuestion: interaction('new'), stale: interaction('resolved') },
    )
    await page.waitForFunction(() => window.initialLoads > 0)
    assert.deepEqual(
      await page.evaluate(() =>
        app.pendingInteractions.map((x) => x.interactionId),
      ),
      ['older', 'new'],
    )
  })
})

test('a failed pending read preserves Chat readiness and still loads initial data', async () => {
  await withPage(async (page) => {
    await page.evaluate(() =>
      window.rejectPending(Error('fixture pending read failed')),
    )
    await page.waitForTimeout(50)
    assert.equal(await page.evaluate(() => app.bootstrap.runtimeReady), true)
    assert.equal(await page.evaluate(() => app.bootstrap.state), 'system-ready')
    assert.equal(await page.evaluate(() => window.initialLoads), 1)
    assert.match(
      await page.evaluate(() => window.notices.join(' ')),
      /fixture pending read failed/,
    )
  })
})

test('late approval failures cannot restore resolved or cancelled cards; retries retain queue order', async () => {
  await withPage(async (page) => {
    await page.evaluate(
      (entries) =>
        entries.forEach((entry) => approvals.onApprovalRequired(entry)),
      [approval('first'), approval('second')],
    )
    await page.waitForFunction(() => approvals.pendingApprovals.length === 2)
    await page.evaluate((entry) => {
      approvals.removePending(entry.toolCallId)
      approvals.restorePending(entry)
    }, approval('first'))
    await page.waitForTimeout(20)
    assert.deepEqual(
      await page.evaluate(() =>
        approvals.pendingApprovals.map((x) => x.toolCallId),
      ),
      ['first', 'second'],
    )
    await page.evaluate((entry) => {
      approvals.removePending(entry.toolCallId)
      approvals.onApprovalResolved(entry.toolCallId)
      approvals.restorePending(entry)
    }, approval('first'))
    await page.waitForTimeout(20)
    assert.deepEqual(
      await page.evaluate(() =>
        approvals.pendingApprovals.map((x) => x.toolCallId),
      ),
      ['second'],
    )
    await page.evaluate((entry) => {
      approvals.removePending(entry.toolCallId)
      approvals.clearForRun(entry.runId)
      approvals.restorePending(entry)
    }, approval('second'))
    await page.waitForTimeout(20)
    assert.equal(
      await page.evaluate(() => approvals.pendingApprovals.length),
      0,
    )
  })
})

test('duplicate required events update a card without moving it behind later requests', async () => {
  await withPage(async (page) => {
    await page.evaluate(
      ({ approvalsData, questions }) => {
        approvalsData.forEach((entry) => approvals.onApprovalRequired(entry))
        approvals.onApprovalRequired({
          ...approvalsData[0],
          summary: 'updated',
        })
        questions.forEach((entry) => interactions.onRequired(entry))
        interactions.onRequired({ ...questions[0], questions: [] })
      },
      {
        approvalsData: [approval('first'), approval('second')],
        questions: [interaction('first'), interaction('second')],
      },
    )
    await page.waitForTimeout(30)
    assert.deepEqual(
      await page.evaluate(() =>
        approvals.pendingApprovals.map((x) => x.toolCallId),
      ),
      ['first', 'second'],
    )
    assert.deepEqual(
      await page.evaluate(() =>
        interactions.pendingInteractions.map((x) => x.interactionId),
      ),
      ['first', 'second'],
    )
  })
})

test('concurrent approval failures retain original order regardless of response order', async () => {
  await withPage(async (page) => {
    await page.evaluate(
      (entries) => {
        entries.forEach((entry) => approvals.onApprovalRequired(entry))
        approvals.removePending('first')
        approvals.removePending('second')
        approvals.restorePending(entries[0])
        approvals.restorePending(entries[1])
      },
      [approval('first'), approval('second'), approval('third')],
    )
    await page.waitForFunction(() => approvals.pendingApprovals.length === 3)
    assert.deepEqual(
      await page.evaluate(() =>
        approvals.pendingApprovals.map((x) => x.toolCallId),
      ),
      ['first', 'second', 'third'],
    )
  })
})

test('immediately rejected approval commands leave the card usable for retry', async () => {
  await withPage(async (page) => {
    await page.evaluate(
      (entry) => approvals.onApprovalRequired(entry),
      approval('retry'),
    )
    const allow = page.getByRole('button', { name: '允许一次', exact: true })
    await allow.click()
    await page.waitForFunction(
      () => window.approvalCalls === 1 && window.notices.length > 0,
    )
    assert.equal(await page.getByRole('alertdialog').count(), 1)
    assert.equal(await allow.isEnabled(), true)
    await allow.click()
    await page.waitForFunction(() => window.approvalCalls === 2)
    assert.equal(await allow.isEnabled(), true)
  })
})
