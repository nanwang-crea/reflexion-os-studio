import { activityFixture, verifyRunLayouts } from './agent-ui/run-activity.mjs'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from 'esbuild'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import {
  agentApi,
  providersApi,
  projectsApi,
  skillsApi,
  transportApi,
  sessionsApi,
} from './agent-ui/mock-api.mjs'
import { browserWorkerPaths } from '../../runtime/dist/browser/agent/paths.js'
const desktop = fileURLToPath(new URL('..', import.meta.url))
const require = createRequire(
  new URL('../../runtime/package.json', import.meta.url),
)
process.env.PLAYWRIGHT_BROWSERS_PATH = browserWorkerPaths().browsers
const { chromium } = require('playwright')

test('roles configure real model/scope fields; collaboration shows canonical tree and saves reviewed Skills', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-collaboration-ui-'))
  const server = createServer()
  let browser
  try {
    await build({
      absWorkingDir: desktop,
      plugins: [
        {
          name: 'synthetic-agent-api',
          setup(build) {
            for (const [name, contents] of Object.entries({
              agents: agentApi,
              providers: providersApi,
              projects: projectsApi,
              skills: skillsApi,
              sessions: sessionsApi.replaceAll(
                "status:'completed'",
                "status:window.traceRunning?'running':'completed'",
              ),
            }))
              build.onLoad(
                {
                  filter: new RegExp(
                    'frontend[\\\\/]api[\\\\/]' + name + '\\.ts$',
                  ),
                },
                () => ({ contents, loader: 'js' }),
              )
            build.onLoad(
              { filter: /features.*terminal.*manager\.ts$/ },
              () => ({
                contents: 'export const terminalManager = {}',
                loader: 'js',
              }),
            )
            build.onLoad(
              { filter: /frontend[\\/]lib[\\/]transport\.ts$/ },
              () => ({ contents: transportApi, loader: 'js' }),
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
import './frontend/features/chat/chat.css';
import {InteractionQueue} from './frontend/features/chat/interactions/InteractionQueue';
import {ApprovalCard} from './frontend/features/chat/approvals/ApprovalCard';
import './frontend/features/chat/approvals/approvals.css';
import {WorkSummary} from './frontend/features/chat/run/WorkSummary';
import {DelegationList} from './frontend/features/chat/run/DelegationList';
import {ChildAgentTrace} from './frontend/features/chat/run/ChildAgentTrace';
import {AgentRolesView} from './frontend/features/agents/AgentRolesView';
import {CollaborationPanel} from './frontend/features/chat/collaboration/CollaborationPanel';
import {useSkillCatalog} from './frontend/hooks/useAppSurfaces';
const root=createRoot(document.getElementById('root'));
const profiles=[{id:'synthetic',name:'Synthetic',enabled:true,capabilities:['chat'],models:['review-model'],apiFormat:'openai-chat'}];
window.showRoles=()=>root.render(<AgentRolesView profiles={profiles} initialProjectId="project" confirm={async()=>true}/>);
window.collaborationCommits=0;
window.showCollaboration=()=>root.render(<React.Profiler id="collaboration" onRender={()=>window.collaborationCommits++}><CollaborationPanel onCollapse={()=>{}} chat={{sessionData:{session:{id:'session',projectId:'project'},messages:[{id:'user',runId:'root-run'}],runs:[{id:window.currentRootRun??'root-run',parentRunId:null,supersededByRunId:null,model:'parent-model',providerId:'synthetic',status:'completed',planId:'plan'}],plans:[{id:'plan',goal:'Deliver feature',steps:[{id:'step',title:'Implement and verify',status:'completed'}]}]},pendingApprovals:[],pendingInteractions:[]}}/></React.Profiler>);
window.showCatalog=()=>{function Catalog(){const [project,setProject]=React.useState('project');window.catalogProject=setProject;const skills=useSkillCatalog(true,project);return <div>{skills.map(skill=><p key={skill.id}>{skill.id}</p>)}</div>};root.render(<Catalog/>)};
window.showQuestions=()=>root.render(<div className="chat-view" style={{height:'100vh'}}><div className="chat-scroll"><p>实际对话正文</p></div><div className="composer-wrap"><InteractionQueue interactions={[{interactionId:'questions',kind:'user_question',questions:Array.from({length:3},(_,i)=>({id:'q'+i,header:'问题'+i,question:'请选择写作协作方式',multiSelect:false,options:Array.from({length:3},(_,j)=>({id:'o'+j,label:'选择'+i+'-'+j,description:'用于写作协作的方法说明。'.repeat(10)}))}))}]} onSubmit={async(id,answers)=>{window.questionAnswers=answers;return false}}/><div style={{height:80}}>输入框</div></div></div>);
window.showTeamApproval=()=>root.render(<ApprovalCard focusable={false} onChoose={()=>{}} approval={{toolCallId:'team',runId:'root-run',operation:'agent_team.create',summary:'创建写作团队',subject:{kind:'operation',operation:'agent_team.create'},choices:[{id:'allow-once',decision:'approved',presentation:'primary',label:'允许一次'},{id:'deny',decision:'denied',presentation:'secondary',label:'拒绝'}],context:{permissionPreset:'workspace-read',sandbox:'workspace-write',workspaceScope:'inside',displayCwd:'…/project',network:false,escalation:false,sandboxProvider:null,review:JSON.stringify({scope:'project',roles:Array.from({length:8},(_,i)=>({name:'Role '+i,modelBinding:{mode:'inherit'},instructions:'明确职责、输入输出、交接和验收标准。'.repeat(40)}))},null,2)}}}/>);
window.showThinking=()=>{let text='一行思考内容。\\n'.repeat(300);function Thinking(){const [value,setValue]=React.useState(text);window.appendThinking=()=>setValue(v=>v+'新的思考。\\n');return <WorkSummary reasoningText={value} phase="thinking" toolCalls={[]} runActive={true} runDurationMs={null}/>};root.render(<Thinking/>)};
window.showTrace=()=>{window.traceRunning=true;root.render(<ChildAgentTrace delegation={{...window.tree[0],task:'很长的任务说明。'.repeat(600)}} onClose={()=>root.render(null)}/>)};
window.showDelegations=()=>root.render(<div style={{maxWidth:900,margin:'0 auto'}}><DelegationList runActive={false} items={['completed','failed','cancelled','running'].map((status,i)=>({...window.tree[0],id:'layout-'+i,status,agentInstance:{...window.tree[0].agentInstance,name:'大纲架构 · 时差以及很长的中文角色标题'},task:'【剧本杀大纲架构】把选题《时差》扩展为完整稿件。'.repeat(20),error:status==='failed'?'provider stream failed: TimeoutError: The operation was aborted due to timeout '+ 'long_unbroken_error_'.repeat(30):status==='cancelled'?'父 Run 已取消':null}))}/></div>);
${activityFixture}
window.clearUI=()=>root.render(null);window.showRoles();
`,
      },
      bundle: true,
      format: 'iife',
      jsx: 'automatic',
      outfile: join(directory, 'app.js'),
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
            : '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/app.css"></head><body style="height:100vh"><div id="root" style="height:100%"></div><script src="/app.js"></script></body></html>',
      )
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    browser = await chromium.launch({ headless: true })
    const page = await browser.newPage({
      viewport: { width: 1200, height: 850 },
    })
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(`http://127.0.0.1:${server.address().port}`)
    await page.getByRole('button', { name: '新建角色', exact: true }).click()
    await page
      .getByRole('textbox', { name: '角色名称', exact: true })
      .fill('Feature reviewer')
    await page
      .getByRole('textbox', { name: '职责与适用场景', exact: true })
      .fill('Independent review')
    await page
      .getByRole('textbox', { name: '领域分类', exact: true })
      .fill('开发, 写作')
    await page
      .getByRole('textbox', { name: '角色指令', exact: true })
      .fill('Review evidence and report actionable findings.')
    await page.getByRole('combobox', { name: '执行模型', exact: true }).click()
    await page
      .getByRole('option', { name: 'Synthetic / review-model', exact: true })
      .click()
    await page.getByRole('combobox', { name: '思考强度', exact: true }).click()
    await page.getByRole('option', { name: '高', exact: true }).click()
    await page.getByRole('button', { name: '保存角色', exact: true }).click()
    await page.waitForFunction(() => window.roleSaves.length === 1)
    const saved = await page.evaluate(() => window.roleSaves[0])
    assert.deepEqual(saved.domains, ['开发', '写作'])
    assert.equal(saved.projectId, 'project')
    assert.deepEqual(saved.modelBinding, {
      mode: 'fixed',
      providerId: 'synthetic',
      model: 'review-model',
      reasoningEffort: 'high',
    })
    assert.equal(saved.permissionCeiling, 'workspace-read')
    await page.screenshot({ path: '/tmp/reflexion-agent-roles.png' })
    await page.evaluate(() => window.showCollaboration())
    await page
      .getByRole('button', { name: 'Review Agent · 已完成', exact: true })
      .waitFor()
    assert.equal(await page.locator('.react-flow__node').count(), 3)
    await page
      .locator('.react-flow__node')
      .filter({ hasText: 'Review Agent' })
      .click()
    await page
      .getByRole('dialog', { name: '子 Agent 执行轨迹', exact: true })
      .waitFor()
    await page.getByText('Synthetic review result', { exact: true }).waitFor()
    await page
      .getByRole('button', { name: '关闭子 Agent 执行轨迹', exact: true })
      .click()
    await page
      .getByRole('button', { name: '保存为协作 Skill', exact: true })
      .click()
    await page
      .getByRole('textbox', { name: 'Skill 标识', exact: true })
      .fill('feature-review')
    await page
      .getByRole('textbox', { name: '适用场景', exact: true })
      .fill('Feature implementation review')
    const methods = page.getByRole('textbox', { name: '协作方法', exact: true })
    assert.equal(
      (await methods.inputValue()).includes('/synthetic/project'),
      false,
    )
    assert.equal((await methods.inputValue()).includes('Review task'), false)
    await methods.fill(
      '# Review method\n\nSelect a reviewer; inspect evidence and verify completion.',
    )
    await page.getByRole('button', { name: '保存 Skill', exact: true }).click()
    await page.getByText(/已保存。可以在对话中使用/).waitFor()
    assert.equal(
      (await page.evaluate(() => window.savedSkills[0])).projectId,
      'project',
    )
    await page.getByRole('button', { name: '关闭', exact: true }).click()
    await page.evaluate(() => {
      window.tree.push({
        ...window.tree[0],
        id: 'nested',
        agentInstance: { name: 'Nested Reviewer' },
        parentRunId: 'child-run',
        childRunId: 'nested-run',
        childSessionId: null,
        execution: { depth: 2, model: 'review-model' },
        status: 'running',
      })
      window.emitAgentEvent({
        type: 'delegation.updated',
        delegation: window.tree[1],
      })
    })
    await page
      .getByRole('button', { name: 'Nested Reviewer · 执行中', exact: true })
      .waitFor()
    assert.equal(await page.locator('.react-flow__edge').count(), 2)
    await page
      .getByRole('button', { name: 'Review Agent · 已完成', exact: true })
      .click()
    const trace = page.getByRole('dialog', {
      name: '子 Agent 执行轨迹',
      exact: true,
    })
    await trace.getByRole('button', { name: /Nested Reviewer/ }).click()
    await trace.getByText('子会话尚未创建。', { exact: true }).waitFor()
    assert.equal(
      await trace
        .getByText('Synthetic review result', {
          exact: true,
        })
        .count(),
      0,
    )
    await page.evaluate(() => {
      window.tree[0] = { ...window.tree[0] }
      window.emitAgentEvent({
        type: 'delegation.updated',
        delegation: window.tree[0],
      })
    })
    await page.waitForTimeout(150)
    assert.match(
      await trace.locator('button.selected').innerText(),
      /Nested Reviewer/,
    )
    await page
      .getByRole('button', {
        name: '关闭子 Agent 执行轨迹',
        exact: true,
      })
      .click()
    await page
      .getByRole('button', { name: '停止此 Agent', exact: true })
      .click()
    await page
      .getByRole('button', { name: 'Nested Reviewer · 已取消', exact: true })
      .waitFor()
    await page
      .waitForFunction(
        () => {
          const graph = document
            .querySelector('.collaboration-graph')
            .getBoundingClientRect()
          return [...document.querySelectorAll('.react-flow__node')].every(
            (node) => {
              const bounds = node.getBoundingClientRect()
              return (
                bounds.left >= graph.left &&
                bounds.right <= graph.right &&
                bounds.top >= graph.top &&
                bounds.bottom <= graph.bottom
              )
            },
          )
        },
        null,
        { timeout: 5000 },
      )
      .catch(async () => {
        await page.screenshot({
          path: '/tmp/reflexion-agent-viewport-failure.png',
        })
        const bounds = await page.evaluate(() => ({
          graph: document
            .querySelector('.collaboration-graph')
            .getBoundingClientRect()
            .toJSON(),
          viewport: document
            .querySelector('.react-flow__viewport')
            .getAttribute('style'),
          nodes: [...document.querySelectorAll('.react-flow__node')].map(
            (node) => ({
              id: node.dataset.id,
              bounds: node.getBoundingClientRect().toJSON(),
            }),
          ),
        }))
        throw new Error(JSON.stringify(bounds))
      })
    await page.screenshot({ path: '/tmp/reflexion-agent-collaboration.png' })
    for (const width of [950, 600]) {
      await page.setViewportSize({ width, height: 700 })
      assert.equal(
        await page.evaluate(() => document.body.scrollWidth > innerWidth),
        false,
      )
    }
    await page.waitForTimeout(200)
    const commits = await page.evaluate(() => window.collaborationCommits)
    await page.waitForTimeout(300)
    assert.equal(
      await page.evaluate(() => window.collaborationCommits),
      commits,
      'idle collaboration must not continuously commit React updates',
    )
    assert.equal(await page.evaluate(() => window.listenerCount()), 1)
    await page
      .getByRole('button', {
        name: 'Review Agent · 已完成',
        exact: true,
      })
      .click()
    await page
      .getByRole('dialog', {
        name: '子 Agent 执行轨迹',
        exact: true,
      })
      .waitFor()
    await page.evaluate(() => {
      window.currentRootRun = 'next-root-run'
      window.showCollaboration()
    })
    await page.waitForFunction(
      () => !document.querySelector('.child-trace-body'),
    )
    await page.evaluate(() => window.clearUI())
    await page.waitForFunction(() => window.listenerCount() === 0)
    await page.evaluate(() => window.showTrace())
    await page.getByText('Synthetic review result', { exact: true }).waitFor()
    assert.ok(
      (await page
        .locator('.child-trace-body')
        .evaluate((el) => el.clientHeight)) > 300,
    )
    await page.getByText('查看任务说明', { exact: true }).click()
    assert.ok(
      (await page
        .locator('.child-trace-body')
        .evaluate((el) => el.clientHeight)) > 200,
    )
    await page.evaluate(() => {
      window.emitAgentEvent({
        type: 'message.delta',
        runId: 'unrelated',
        messageId: 'assistant',
        delta: 'WRONG SESSION',
      })
      window.emitAgentEvent({
        type: 'message.delta',
        runId: 'child-run',
        messageId: 'assistant',
        delta: 'Live child output',
      })
    })
    await page.getByText('Live child output', { exact: true }).waitFor()
    assert.equal(
      await page.getByText('WRONG SESSION', { exact: true }).count(),
      0,
    )
    await page.waitForTimeout(200)
    await page.getByText('Live child output', { exact: true }).waitFor()
    await page.evaluate(() => window.clearUI())
    await page.waitForFunction(() => window.listenerCount() === 0)
    await page.evaluate(() => window.showThinking())
    const thinking = page.locator('.work-thinking-text')
    await thinking.waitFor()
    await thinking.hover()
    await page.mouse.wheel(0, -120)
    await page.waitForTimeout(100)
    const thinkingTop = await thinking.evaluate((el) => el.scrollTop)
    await page.evaluate(() => window.appendThinking())
    await page.waitForTimeout(100)
    assert.equal(
      await thinking.evaluate((el) => el.scrollTop),
      thinkingTop,
      'new reasoning must not pull a reader back to the bottom',
    )
    await page.evaluate(() => window.clearUI())
    await page.evaluate(() => window.showCatalog())
    await page.getByText('project-skill', { exact: true }).waitFor()
    await page.evaluate(() => {
      window.savedSkills.push({ id: 'new-global-skill', projectId: null })
      window.emitAgentEvent({ type: 'plugin.changed' })
    })
    await page.getByText('new-global-skill', { exact: true }).waitFor()
    await page.evaluate(() => window.catalogProject('other'))
    await page.getByText('other-skill', { exact: true }).waitFor()
    assert.equal(
      await page.getByText('feature-review', { exact: true }).count(),
      0,
    )
    assert.equal(await page.evaluate(() => window.listenerCount()), 1)
    await page.evaluate(() => window.clearUI())
    await page.waitForFunction(() => window.listenerCount() === 0)
    await page.evaluate(() => window.showQuestions())
    for (const height of [850, 600, 450]) {
      await page.setViewportSize({ width: 600, height })
      const bounds = await page.evaluate(() => {
        const body = document.querySelector('.user-question-body')
        const chat = document
          .querySelector('.chat-scroll')
          .getBoundingClientRect()
        const card = document
          .querySelector('.user-question-card')
          .getBoundingClientRect()
        const actions = document
          .querySelector('.user-question-actions')
          .getBoundingClientRect()
        return {
          scrollable: body.scrollHeight > body.clientHeight,
          chatHeight: chat.height,
          chatBottom: chat.bottom,
          cardTop: card.top,
          cardHeight: card.height,
          actionsBottom: actions.bottom,
        }
      })
      assert.ok(bounds.scrollable)
      assert.ok(bounds.chatHeight > 70)
      assert.ok(bounds.cardHeight <= height * 0.45 + 1)
      assert.ok(bounds.chatBottom <= bounds.cardTop)
      assert.ok(bounds.actionsBottom < height)
    }
    await page.locator('.user-question-body').hover()
    await page.mouse.wheel(0, 350)
    await page.waitForFunction(
      () => document.querySelector('.user-question-body').scrollTop > 0,
    )
    await page.getByText('选择2-2', { exact: true }).click()
    assert.ok(
      (await page
        .locator('.user-question-body')
        .evaluate((el) => el.scrollTop)) > 0,
    )
    await page.getByRole('button', { name: '收起问题', exact: true }).click()
    assert.equal(await page.locator('.user-question-body').isVisible(), false)
    await page.getByText('实际对话正文', { exact: true }).waitFor()
    await page.getByRole('button', { name: '展开问题', exact: true }).click()
    assert.equal(await page.getByRole('radio').last().isChecked(), true)
    await page.getByRole('button', { name: '提交回答', exact: true }).click()
    await page.waitForFunction(() => window.questionAnswers?.length === 1)
    assert.equal(
      (await page.evaluate(() => window.questionAnswers[0])).questionId,
      'q2',
    )
    await page.screenshot({ path: '/tmp/reflexion-question-scroll.png' })
    await verifyRunLayouts(page)
    await page.evaluate(() => window.showTeamApproval())
    await page.getByRole('button', { name: '查看详情', exact: true }).click()
    const preview = page.getByRole('region', {
      name: '待保存的配置',
      exact: true,
    })
    // section has an accessible name and therefore exposes region semantics.
    await preview.waitFor()
    assert.ok((await preview.innerText()).includes('Role 7'))
    assert.ok(
      await preview
        .locator('pre')
        .evaluate((el) => el.scrollHeight > el.clientHeight),
    )
    assert.ok((await preview.locator('pre').boundingBox()).height <= 241)
    const reviewBody = await page
      .locator('.approval-body.has-review')
      .boundingBox()
    assert.ok(reviewBody.height <= 450 * 0.35 + 1)
    const allowButton = await page
      .getByRole('button', { name: '允许一次', exact: true })
      .boundingBox()
    assert.ok(allowButton.y + allowButton.height < 450)
    await page.getByRole('button', { name: '收起详情', exact: true }).click()
    assert.equal(await preview.count(), 0)
    assert.deepEqual(errors, [])
  } finally {
    await browser?.close()
    await new Promise((resolve) => server.close(resolve))
    await rm(directory, { recursive: true, force: true })
  }
})
