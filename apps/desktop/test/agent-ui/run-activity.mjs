import { verifyDelegationLayout } from './delegation-layout.mjs'
import assert from 'node:assert/strict'

export const activityFixture = `
import {RunBlock} from './frontend/features/chat/run/RunBlock';
window.showRunActivity=()=>{function Activity(){const [state,setState]=React.useState({phase:'preparing_tool',toolName:'task',taskName:'编剧撰稿',children:0,active:true});window.updateRunActivity=patch=>setState(previous=>({...previous,...patch}));const children=Array.from({length:state.children},(_,i)=>({...window.tree[0],id:'activity-'+i,status:state.statuses?.[i]??(i===0?'running':'pending')}));return <React.Profiler id="activity" onRender={()=>window.activityCommits++}><RunBlock processItems={[]} finalItem={{message:{id:'activity-message',runId:'root-run',status:'pending',content:'现在开始写作。',reasoning:'',parts:[]},toolCalls:[]}} delegations={children} runActive={state.active} runActivity={{phase:state.phase,toolName:state.toolName,taskName:state.taskName}} streaming={{'activity-message':'现在开始写作。'}} streamingReasoning={{}} runDurationMs={null} runUsage={null} runFailed={false} canRetry={false} onRetry={()=>{}} projectId="project"/></React.Profiler>};window.activityCommits=0;root.render(<Activity/>)};
`

export async function verifyRunLayouts(page) {
  await page.evaluate(() => window.showRunActivity())
  await page
    .getByText('正在准备子任务：编剧撰稿（参数接收中）', { exact: true })
    .waitFor()
  assert.equal(await page.locator('.typing-dots').count(), 0)
  await page.evaluate(() => window.updateRunActivity({ taskName: undefined }))
  await page
    .getByText('正在准备子任务（参数接收中）', { exact: true })
    .waitFor()
  await page.evaluate(() =>
    window.updateRunActivity({ phase: 'tool', children: 2 }),
  )
  const waiting = page.getByRole('button', {
    name: '等待 2 个子 Agent 完成 · 查看执行过程',
    exact: true,
  })
  await waiting.waitFor()
  await waiting.focus()
  await page.keyboard.press('Enter')
  await page
    .getByRole('dialog', { name: '子 Agent 执行轨迹', exact: true })
    .waitFor()
  await page
    .getByRole('button', { name: '关闭子 Agent 执行轨迹', exact: true })
    .click()
  await page.evaluate(() =>
    window.updateRunActivity({ statuses: ['completed', 'pending'] }),
  )
  await page
    .getByRole('button', {
      name: '等待 1 个子 Agent 完成 · 查看执行过程',
      exact: true,
    })
    .waitFor()
  await page
    .getByRole('button', {
      name: '等待 1 个子 Agent 完成 · 查看执行过程',
      exact: true,
    })
    .click()
  await page
    .getByRole('dialog', { name: '子 Agent 执行轨迹', exact: true })
    .waitFor()
  await page.evaluate(() => window.updateRunActivity({ active: false }))
  assert.equal(
    await page
      .getByRole('dialog', { name: '子 Agent 执行轨迹', exact: true })
      .isVisible(),
    true,
  )
  await page
    .getByRole('button', { name: '关闭子 Agent 执行轨迹', exact: true })
    .click()
  await page.evaluate(() => window.updateRunActivity({ active: true }))
  await page.evaluate(() =>
    window.updateRunActivity({
      statuses: ['failed', 'cancelled'],
      phase: 'waiting',
    }),
  )
  await page.getByText('等待模型响应', { exact: true }).waitFor()
  assert.equal(await page.locator('.typing-dots').count(), 0)
  await page.setViewportSize({ width: 320, height: 700 })
  assert.equal(
    await page.evaluate(() => document.body.scrollWidth > innerWidth),
    false,
  )
  await page.waitForTimeout(100)
  const commits = await page.evaluate(() => window.activityCommits)
  await page.waitForTimeout(300)
  assert.equal(await page.evaluate(() => window.activityCommits), commits)
  await page.evaluate(() => window.updateRunActivity({ active: false }))
  await page.waitForFunction(
    () => !document.querySelector('.run-activity-status'),
  )
  await page.evaluate(() => window.clearUI())
  await verifyDelegationLayout(page)
}
