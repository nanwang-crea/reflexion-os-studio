import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../dist/store/index.js'
import { ContextBuilder } from '../dist/agent/context.js'

// W5：Checkpoint → legacy → 确定性裁剪三级降级闭环。
// Checkpoint 失败已有 context-checkpoint.test.mjs 覆盖；这里覆盖
// "legacy 摘要也失败"的第二级降级——旧实现在此场景会把异常直接抛出，
// 导致整个 Run 失败，违背"压缩失败绝不阻塞对话"的设计约束。
test('ContextBuilder.build degrades to deterministic trim when both summaries fail', async () => {
  const store = new Store(
    mkdtempSync(join(tmpdir(), 'reflexion-ctx-fallback-')),
  )
  const project = store.projects.create({ name: 'p', folderPath: '/w' })
  const session = store.sessions.create(project.id)
  // 大段历史：确保远超极小预算，必然触发压缩路径。
  for (let i = 0; i < 12; i += 1) {
    store.messages.create({
      sessionId: session.id,
      runId: null,
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `第 ${i} 轮：${'内容'.repeat(400)}`,
      status: 'completed',
    })
  }
  const builder = new ContextBuilder(store)
  // 死端口 + 零重试 + 短超时：Checkpoint 与 legacy 摘要两层都立即失败。
  const provider = {
    baseUrl: 'http://127.0.0.1:1',
    apiKey: 'k',
    model: 'm',
    contextBudget: 200,
    maxRetries: 0,
    timeoutMs: 1000,
  }
  const controller = new AbortController()
  const messages = await builder.build(
    session.id,
    '你是助手。',
    provider,
    controller.signal,
  )
  // 降级产物仍是合法消息序列：system 头 + 确定性裁剪后的最近窗口。
  assert.ok(Array.isArray(messages))
  assert.ok(messages.length > 0)
  assert.equal(messages[0].role, 'system')
  assert.match(messages[0].content, /助手/)
  store.close()
})
