# 流式模型请求重试 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让模型响应流在已产生增量后发生任意读取、解析或协议错误时，按现有 `maxRetries` 预算重试，并通过 `message.reset` 防止前端显示重复内容。

**Architecture:** 将 `streamChatCompletion` 重构为独立 attempt：每次 attempt 自己累积内容，流错误丢弃 attempt 并回到统一重试循环；用户 AbortError 立即终止。Runner 在 provider 通知重试时清理草稿并发出 `message.reset`，前端清理临时流缓存后接收新 attempt。

**Tech Stack:** TypeScript、Zod contracts、Node test runner、React hooks、pnpm。

---

### Task 1: 扩展 Runtime 事件契约

**Files:**
- Modify: `packages/contracts/src/events.ts:56-60`
- Test: `packages/contracts/test/*`（沿用现有 contracts 测试位置，若无事件测试则在 runtime 事件测试中覆盖）

- [ ] **Step 1: 写失败测试**

新增对 `message.reset` 的 schema 解析测试，事件应包含 envelope 字段、`type: 'message.reset'` 和非空 `messageId`；缺少 `messageId` 应失败。

- [ ] **Step 2: 运行测试确认失败**

运行：`pnpm test`（或项目现有 contracts/runtime 测试命令）
预期：事件 discriminated union 不接受 `message.reset`。

- [ ] **Step 3: 实现最小契约变更**

在 `RuntimeEventSchema` 的 `message.created` 与 `message.delta` 之间加入：

```ts
RuntimeEventEnvelopeSchema.extend({
  type: z.literal('message.reset'),
  messageId: z.string().min(1),
}),
```

确保 `RuntimeEvent`、runtime-client 和前端自动复用派生类型，不复制接口。

- [ ] **Step 4: 运行测试确认通过**

运行：`pnpm typecheck`
预期：contracts 类型检查通过。

### Task 2: 为 provider 增加流 attempt 重试测试

**Files:**
- Modify: `apps/runtime/test/provider-sse.test.mjs`
- Modify: `apps/runtime/src/provider.ts`

- [ ] **Step 1: 写失败测试：流中断后成功重试**

增加 HTTP SSE 测试：第一次请求先发送一个 content delta，然后关闭/触发读取错误；第二次请求发送完整 `retry-success` 内容与 `[DONE]`。断言返回内容只等于第二次完整结果，服务端请求次数为 2，`onRetry` 收到 `attempt: 1` 且 reason 表示 stream failure。

- [ ] **Step 2: 写失败测试：流错误耗尽不返回中间内容**

用 `maxRetries: 1` 让两次响应都在发送部分内容后断流；断言 Promise reject，且不存在返回值。断言只触发一次 `onRetry`。

- [ ] **Step 3: 写失败测试：流错误期间 AbortError 不重试**

在第一次流 attempt 后通过外部 controller abort；断言错误名为 `AbortError`，请求次数保持 1，且不触发 `onRetry`。

- [ ] **Step 4: 运行新增测试确认失败**

运行：`pnpm --filter @reflexion-os-studio/runtime test -- provider-sse.test.mjs`（按仓库实际 runtime test script 调整参数）
预期：流中断测试当前失败，因为 provider 直接将流错误转换为 `ProviderError`，不会重试。

- [ ] **Step 5: 实现独立 attempt**

把 `provider.ts:207-289` 的 fetch/status 逻辑与 `:294-388` 的 stream 状态封装进统一循环。每个 attempt 必须重新初始化 `content`、`reasoning`、`finishReason`、`usage`、`toolCallByIndex`、`buffer` 和 reader。

流读取 `catch` 的行为改为：

```ts
if (isAbort(error)) throw error
if (attempt < maxRetries) {
  attempt += 1
  options.onRetry?.({
    attempt,
    maxRetries,
    reason: `stream: ${String(error)}`,
  })
  await sleep(
    RETRY_BACKOFF_MS[Math.min(attempt - 1, RETRY_BACKOFF_MS.length - 1)],
    signal,
  )
  continue
}
throw new ProviderError('network', `provider stream failed: ${String(error)}`)
```

解析/协议错误必须进入同一 catch；attempt 的部分工具调用不能从函数返回，也不能触发 agent 工具执行。

- [ ] **Step 6: 运行 provider 测试确认通过**

运行：`pnpm --filter @reflexion-os-studio/runtime test -- provider-sse.test.mjs`
预期：新增流重试、耗尽、取消测试及既有 429/401/网络错误测试全部通过。

### Task 3: 在 Runner 中清理并重置 assistant 草稿

**Files:**
- Modify: `apps/runtime/src/agent/runner.ts:185-253`
- Modify: `apps/runtime/src/store/messages.ts`（使用现有领域方法；若无清空 pending 方法则新增）
- Test: `apps/runtime/test/runner.test.*`（按现有测试布局新增）

- [ ] **Step 1: 写失败测试**

模拟 provider 第一次流出 delta 后触发重试、第二次成功；断言事件顺序包含 `run.retrying` 与 `message.reset`，reset 后新 attempt 的 `chunkSeq` 从 0 开始，最终消息只保存第二次完整内容。

- [ ] **Step 2: 运行测试确认失败**

运行对应 runner 测试命令。
预期：当前没有 `message.reset`，且 runner 只会收到 provider 最终失败或无法模拟流重试。

- [ ] **Step 3: 实现重试回调边界**

在 `runner.ts` 的 `onRetry` 中：

1. 将 `draft.content` 与 `draft.reasoning` 设为空字符串；
2. 将 `chunkSeq` 与 `reasoningSeq` 设为 0；
3. 清空持久化 pending assistant 草稿，不能改变 message ID；
4. 发出 `run.retrying`；
5. 发出 `{ type: 'message.reset', messageId: draft.id }`；
6. 保证此回调只在 provider 即将重试时触发。

不得在 provider 重试期间执行工具调用；只有最终完整响应返回后，既有 agent loop 才能处理 tool calls。

- [ ] **Step 4: 运行 Runner 测试确认通过**

运行对应 runner 测试命令。
预期：reset 事件、序号、最终持久化内容和既有取消/失败路径全部正确。

### Task 4: 前端处理 message.reset

**Files:**
- Modify: `apps/desktop/frontend/hooks/useAppBootstrap.ts:278-318`
- Test: `apps/desktop/frontend/**/*.test.*`（沿用现有前端测试布局）

- [ ] **Step 1: 写失败测试**

给事件处理器一个已有流内容、reasoning 和 `streamRunRef`，发送 `message.reset`；断言对应 `streamingRef`、`streamingReasoningRef` 被清空，后续 delta 重新从空内容开始聚合。

- [ ] **Step 2: 运行测试确认失败**

运行项目现有 desktop frontend 测试命令。
预期：当前没有 reset 分支，缓存仍保留旧内容。

- [ ] **Step 3: 实现 reset 分支**

在 `useAppBootstrap.ts` 的 event handler 中，在 delta 分支前增加 `message.reset` 处理：删除对应 messageId 的正文和 reasoning 流缓存，保留 `streamRunRef` 的 run 关联，取消/刷新待执行的 streaming flush 后再按现有机制刷新空状态。

不要删除数据库中的已完成历史消息；该事件只负责当前 pending assistant 的临时流状态。

- [ ] **Step 4: 运行前端测试、lint、typecheck**

运行：`pnpm lint`、`pnpm typecheck`、`pnpm --filter @reflexion-os-studio/desktop typecheck`
预期：全部通过。

### Task 5: 全量验证与回归

**Files:**
- No additional files unless tests expose a contract mismatch.

- [ ] **Step 1: 运行格式与类型检查**

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm --filter @reflexion-os-studio/desktop typecheck
```

预期：全部成功。

- [ ] **Step 2: 运行 runtime/provider 回归测试**

运行 runtime 全部测试及 provider SSE 测试，确认网络错误、429/5xx、401、用户取消、流重试和流重试耗尽均通过。

- [ ] **Step 3: 运行构建验证**

```bash
pnpm build:packages
```

预期：contracts、runtime-client、runtime 和前端构建成功。

- [ ] **Step 4: 检查最终 diff**

运行：`git diff --check && git status --short`
预期：无空白错误；只包含本功能相关文件。
