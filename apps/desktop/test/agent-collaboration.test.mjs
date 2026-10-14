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
              sessions: sessionsApi,
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
import {AgentRolesView} from './frontend/features/agents/AgentRolesView';
import {CollaborationPanel} from './frontend/features/chat/collaboration/CollaborationPanel';
import {useSkillCatalog} from './frontend/hooks/useAppSurfaces';
const root=createRoot(document.getElementById('root'));
const profiles=[{id:'synthetic',name:'Synthetic',enabled:true,capabilities:['chat'],models:['review-model'],apiFormat:'openai-chat'}];
window.showRoles=()=>root.render(<AgentRolesView profiles={profiles} initialProjectId="project" confirm={async()=>true}/>);
window.collaborationCommits=0;
window.showCollaboration=()=>root.render(<React.Profiler id="collaboration" onRender={()=>window.collaborationCommits++}><CollaborationPanel onCollapse={()=>{}} chat={{sessionData:{session:{id:'session',projectId:'project'},messages:[{id:'user',runId:'root-run'}],runs:[{id:'root-run',parentRunId:null,supersededByRunId:null,model:'parent-model',providerId:'synthetic',status:'completed',planId:'plan'}],plans:[{id:'plan',goal:'Deliver feature',steps:[{id:'step',title:'Implement and verify',status:'completed'}]}]},pendingApprovals:[],pendingInteractions:[]}}/></React.Profiler>);
window.showCatalog=()=>{function Catalog(){const [project,setProject]=React.useState('project');window.catalogProject=setProject;const skills=useSkillCatalog(true,project);return <div>{skills.map(skill=><p key={skill.id}>{skill.id}</p>)}</div>};root.render(<Catalog/>)};
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
    await page.evaluate(() => window.clearUI())
    await page.waitForFunction(() => window.listenerCount() === 0)
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
    assert.deepEqual(errors, [])
  } finally {
    await browser?.close()
    await new Promise((resolve) => server.close(resolve))
    await rm(directory, { recursive: true, force: true })
  }
})
