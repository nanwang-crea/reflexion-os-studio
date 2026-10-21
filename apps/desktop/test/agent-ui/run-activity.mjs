import { verifyDelegationLayout } from './delegation-layout.mjs'
import assert from 'node:assert/strict'

export const activityFixture = `
import {RunBlock} from './frontend/features/chat/run/RunBlock';
window.showRunActivity = () => {
  function Activity() {
    const [state, setState] = React.useState({
      phase: 'preparing_tool', toolName: 'task', taskName: '编剧撰稿',
      children: 0, active: true, calls: [], processText: '', final: true,
    });
    window.updateRunActivity = patch => setState(previous => ({...previous, ...patch}));
    const children = Array.from({length: state.children}, (_, i) => ({
      ...window.tree[0], id: 'activity-' + i,
      status: state.statuses?.[i] ?? (i === 0 ? 'running' : 'pending'),
    }));
    const processItems = state.calls.length || state.processText ? [{
      message: {id: 'process-message', content: state.processText, reasoning: ''},
      toolCalls: state.calls,
    }] : [];
    return <React.Profiler id="activity" onRender={() => window.activityCommits++}>
      <RunBlock processItems={processItems}
        finalItem={state.final ? {
          message: {id: 'activity-message', runId: 'root-run', status: 'pending',
            content: '现在开始写作。', reasoning: '', parts: []}, toolCalls: [],
        } : null}
        delegations={children} runActive={state.active}
        runActivity={{phase: state.phase, toolName: state.toolName,
          taskName: state.taskName, retry: state.retry}}
        streaming={{'activity-message': '现在开始写作。'}} streamingReasoning={{}}
        runDurationMs={state.active ? null : 12000} runUsage={null}
        runStatus={state.status ?? (state.active ? 'running' : 'completed')}
        canRetry={false} onRetry={() => {}} projectId="project"/>
    </React.Profiler>;
  }
  window.activityCommits = 0;
  root.render(<Activity/>);
};
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
  await page.getByText('等待 2 个子 Agent 完成', { exact: true }).waitFor()
  await page.locator('.delegation-open').first().focus()
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
  await page.getByText('等待 1 个子 Agent 完成', { exact: true }).waitFor()
  await page.locator('.delegation-open').nth(1).click()
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
  await verifyTimeline(page)
  await verifyDelegationLayout(page)
}

async function verifyTimeline(page) {
  await page.evaluate(() => {
    window.showRunActivity()
  })
  const calls = ['src/a.ts', 'src/b.ts'].map((path, index) => ({
    id: 'read-' + index,
    toolName: 'file.read',
    args: { path },
    status: 'completed',
    errorCode: null,
    result: null,
    output: { content: '文件正文 ' + index, data: '文件正文 ' + index },
  }))
  await page.evaluate((calls) => {
    window.timelineCalls = calls
    window.updateRunActivity({ phase: 'waiting', calls })
  }, calls)
  await page.getByText('已完成 2 项工具调用', { exact: true }).waitFor()
  assert.equal(await page.locator('.run-process-body').count(), 1)
  assert.equal(await page.locator('.run-activity-status').count(), 1)

  // 组摘要一次展开即见每次调用的参数/结果，不需要再展开子项。
  const group = page.locator('.tool-trace-group > summary')
  await group.focus()
  await page.keyboard.press('Enter')
  await page.getByText('文件正文 0', { exact: false }).waitFor()
  assert.equal(await page.locator('.tool-trace-group-body button').count(), 0)
  assert.equal(
    await page.locator('.tool-trace-group-body pre:visible').count(),
    2,
  )
  for (const width of [1200, 600, 320]) {
    await page.setViewportSize({ width, height: 750 })
    assert.equal(
      await page.evaluate(() => document.body.scrollWidth > innerWidth),
      false,
    )
  }
  await page.screenshot({ path: '/tmp/reflexion-chat-timeline.png' })
  await page.evaluate(() => window.updateRunActivity({ active: false }))
  await page.getByText('工作了 12 秒', { exact: true }).waitFor()
  assert.equal(await page.locator('.run-process-body').count(), 1)
  assert.equal(
    await page.locator('.tool-trace-group-body pre:visible').count(),
    2,
  )

  // 显式关闭后，阶段变化不会重新打开；显式展开后完成也不会收起。
  const toggle = page.locator('button.run-process-toggle')
  await toggle.click()
  await page.evaluate(() =>
    window.updateRunActivity({ active: true, phase: 'thinking' }),
  )
  await page.getByText('思考中…', { exact: true }).waitFor()
  assert.equal(await page.locator('.run-process-body').count(), 0)
  await toggle.focus()
  await page.keyboard.press('Enter')
  await page.evaluate(() => window.updateRunActivity({ active: false }))
  await page.getByText('工作了 12 秒', { exact: true }).waitFor()
  assert.equal(await page.locator('.run-process-body').count(), 1)

  // 未操作的过程完成后仍默认收起，历史记录保持紧凑。
  await page.evaluate(() => window.showRunActivity())
  await page.evaluate(() =>
    window.updateRunActivity({ phase: 'waiting', calls: window.timelineCalls }),
  )
  await page.locator('.run-process-body').waitFor()
  await page.evaluate(() => window.updateRunActivity({ active: false }))
  await page.getByText('工作了 12 秒', { exact: true }).waitFor()
  assert.equal(await page.locator('.run-process-body').count(), 0)

  // 非完成终态不能显示为“处理完成”。
  for (const [status, label] of [
    ['cancelled', '已取消'],
    ['interrupted', '已中断'],
    ['failed', '运行失败'],
  ]) {
    await page.evaluate(
      (status) => window.updateRunActivity({ status }),
      status,
    )
    await page
      .locator('.run-process-label')
      .getByText(label, { exact: true })
      .waitFor()
  }
  for (const [status, label] of [
    ['awaiting_approval', '等待审批'],
    ['awaiting_user_input', '等待回答'],
  ]) {
    await page.evaluate(
      (status) => window.updateRunActivity({ active: true, status }),
      status,
    )
    await page
      .locator('.run-process-label')
      .getByText(label, { exact: true })
      .waitFor()
  }

  // 工具活动与完成计数来自调用记录；无最终消息时状态仍可见。
  await page.evaluate(() =>
    window.updateRunActivity({
      status: 'running',
      phase: 'tool',
      final: false,
      calls: [
        ...window.timelineCalls,
        {
          ...window.timelineCalls[0],
          id: 'running',
          status: 'running',
        },
      ],
    }),
  )
  await page.getByText('正在执行：读取文件', { exact: true }).waitFor()
  await page.getByText('已完成 2 项工具调用', { exact: true }).waitFor()
  await page.evaluate(() =>
    window.updateRunActivity({
      calls: [{ ...window.timelineCalls[0], status: 'awaiting_approval' }],
      retry: { attempt: 1, maxRetries: 3 },
    }),
  )
  await page
    .locator('.run-process-label')
    .getByText('等待审批', { exact: true })
    .waitFor()

  // 重试只有主状态行一处显示，重试结束后无常驻 React 更新。
  await page.evaluate(() =>
    window.updateRunActivity({
      status: 'running',
      phase: 'waiting',
      final: true,
      calls: window.timelineCalls,
      retry: { attempt: 1, maxRetries: 3, waitMs: 300, startedAt: Date.now() },
    }),
  )
  await page
    .locator('.run-process-label')
    .getByText(/正在重试/)
    .waitFor()
  assert.equal(await page.locator('.assistant-retrying').count(), 0)
  // 归零提交（“…秒后自动重试”→“正在重试…”）与最后一次心跳可能因 CI
  // 计时抖动落在固定偏移采样之后；先等倒计时收敛到终态标签，再断言静止。
  await page
    .locator('.run-process-label')
    .getByText('正在重试…', { exact: true })
    .waitFor()
  await page.waitForTimeout(300)
  const commits = await page.evaluate(() => window.activityCommits)
  await page.waitForTimeout(400)
  assert.equal(await page.evaluate(() => window.activityCommits), commits)
  await page.evaluate(() =>
    window.updateRunActivity({ retry: undefined, phase: 'answering' }),
  )
  await page.getByText('正在作答…', { exact: true }).waitFor()
  assert.equal(await page.locator('.stream-caret').count(), 1)
  await page.evaluate(() => window.updateRunActivity({ phase: 'waiting' }))
  await page.getByText('等待模型响应', { exact: true }).waitFor()
  assert.equal(await page.locator('.stream-caret').count(), 0)
  await page.evaluate(() => window.clearUI())
}
