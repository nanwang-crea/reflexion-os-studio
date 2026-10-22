const usage = {
  promptTokens: 120,
  completionTokens: 30,
  cachedPromptTokens: 40,
  sources: 1,
  reportedSources: 1,
  cacheReportedSources: 1,
  unreportedCalls: 0,
  legacyRuns: 0,
}
const run = (id = 'root') => ({
  run: {
    id,
    sessionId: 'session',
    parentRunId: id === 'child' ? 'root' : null,
    model: 'test-model',
    providerId: 'provider',
    status: 'completed',
    startedAt: '2026-10-22T01:00:00.000Z',
    completedAt: '2026-10-22T01:00:01.000Z',
    usage,
    performance: null,
  },
  sessionTitle: id === 'child' ? '子任务示例' : '开发者测试对话',
  projectId: 'project',
  projectName: '测试项目',
  providerName: '测试供应商',
  toolCalls: 1,
  toolFailures: 0,
  childRuns: id === 'child' ? 0 : 1,
})
const tool = {
  id: 'tool',
  runId: 'root',
  sessionId: 'session',
  sessionTitle: '开发者测试对话',
  projectId: 'project',
  model: 'test-model',
  toolName: 'file.read',
  status: 'completed',
  errorCode: null,
  createdAt: '2026-10-22T01:00:00.000Z',
  completedAt: '2026-10-22T01:00:01.000Z',
}
function record(method, params) {
  window.calls.push({ method, params })
}
export async function getDeveloperOverview(filter) {
  record('overview', filter)
  if (window.delayOverview)
    await new Promise((resolve) =>
      (window.overviewResolvers ??= []).push(resolve),
    )
  if (window.failOverview) throw new Error('测试加载错误')
  return {
    usage: filter.model ? { ...usage, promptTokens: 999 } : usage,
    runs: 1,
    failedRuns: 0,
    tools: 1,
    failedTools: 0,
    days: [{ key: '2026-10-22', ...usage }],
    models: [{ key: '测试模型', ...usage }],
    toolGroups: [{ name: 'file.read', calls: 1, failures: 0 }],
  }
}
export async function listDeveloperRuns(input) {
  record('runs', input)
  return {
    items: [
      run(input.parentRunId ? 'child' : input.offset ? 'page-2' : 'root'),
    ],
    total: input.parentRunId ? 1 : 26,
  }
}
export async function getDeveloperRun(id) {
  record('run', id)
  return { entry: run(id), treeUsage: usage, treeRuns: id === 'root' ? 2 : 1 }
}
export async function listDeveloperTools(input) {
  record('tools', input)
  return {
    items: input.toolName && input.toolName !== 'file.read' ? [] : [tool],
    total: 1,
  }
}
export async function getDeveloperTool(id) {
  record('tool', id)
  return {
    ...tool,
    args: { path: 'src/example.ts' },
    timing: {
      version: 1,
      approvalWaitMs: 300,
      mutationWaitMs: 50,
      executionMs: 20,
    },
    output: {
      type: 'tool_output',
      version: 1,
      content: '完整工具结果',
      data: { value: 42 },
    },
  }
}
export async function listDeveloperModels(input) {
  record('models', input)
  return {
    total: 1,
    items: [
      {
        id: 'model',
        sessionId: 'session',
        runId: 'root',
        messageId: 'message',
        model: 'test-model',
        purpose: 'chat',
        status: 'completed',
        usage,
        estimatedInputTokens: 150,
        contextWindow: 10000,
        startedAt: '2026-10-22T01:00:00.000Z',
        durationMs: 1000,
      },
    ],
  }
}
export async function listDeveloperAttempts(messageId, offset) {
  record('attempts', { messageId, offset })
  return {
    total: 1,
    items: [
      {
        id: 'attempt',
        status: 'completed',
        attempt: 1,
        responseStatus: 200,
        firstDataMs: 15,
        firstTextMs: 20,
        durationMs: 1000,
        providerRequestId: 'request-example',
      },
    ],
  }
}
export function subscribeDeveloperChanges(handler) {
  window.listeners.add(handler)
  return () => window.listeners.delete(handler)
}
