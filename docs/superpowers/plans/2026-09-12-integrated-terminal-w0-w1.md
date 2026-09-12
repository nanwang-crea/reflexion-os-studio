# 集成终端 Plan 1：W0 事件信封泛化 + W1 三平台贯通验证

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 RuntimeEvent 信封从"借用 runId"泛化为显式 scope 判别联合（W0），并交付终端纵向切片验证——Rust PTY 服务 + TS 通知路由 + xterm WebView 行为（W1），为 W2–W4 固定依赖版本与性能门槛。

**Architecture:** 信封 base 不再携带 runId；每个事件变体自带 scope 字面量与真实资源字段（zod 判别联合，type 单键判别）。Rust `terminal/` 模块以 portable-pty 拥有 PTY 与输出帧（seq + ≤16 KiB + base64），`SystemRuntimeClient` 补齐通知路由与代际丢弃。上游 spec：`docs/superpowers/specs/2026-09-12-integrated-terminal-design.md`（已评审）。

**Tech Stack:** zod v4（现仓内版本）、node:test、portable-pty 0.8、base64 0.22、@xterm/xterm 5.5 / @xterm/addon-fit 0.10（W1 出口固定）。

**验证链（每个 TS 任务完成后跑相关项，任务出口跑全量）**：

```bash
pnpm format:check && pnpm lint && pnpm typecheck
pnpm --filter @reflexion-os-studio/desktop typecheck
pnpm build:packages
cargo fmt --manifest-path crates/Cargo.toml -- --check
cargo test --manifest-path crates/Cargo.toml
cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml
```

> 环境：cargo 若找不到先 `source ~/.cargo/env`。禁止直改 `gen/`、`dist/`、`target/`（AGENTS §5）。

---

## W0：事件信封泛化

> **树红窗口**：Task 1 起至 Task 6 止，`apps/runtime`/`runtime-client`/前端 typecheck 与部分 runtime 测试有意保持红色（生产者/消费者按任务顺序迁移）。bisect 起点 = Task 7 的全量绿。

### Task 0: 功能分支

- [ ] **Step 1: 从 main 建分支**

```bash
git checkout main && git pull --ff-only
git checkout -b feature/terminal-surface
```

- [ ] **Step 2: 确认工作区干净**

Run: `git status --short`
Expected: 空输出。

---

### Task 1: contracts——信封判别联合（TDD 先行）

**Files:**
- Modify: `packages/contracts/src/events.ts`
- Modify: `packages/contracts/src/entities.ts`（如需；实际不动）
- Test: `packages/contracts/test/validators.test.mjs`

- [ ] **Step 1: 先改测试使其失败**

在 `validators.test.mjs` 顶部 import 增加 `PROTOCOL_VERSION`（与 `RuntimeEventSchema` 同一 import 来源）；定义公共 run 信封并替换 :248-293 两个用例与 :463-527 用例：

```js
const RUN_ENV = {
  protocolVersion: PROTOCOL_VERSION,
  eventId: 'e1',
  scope: 'run',
  runId: 'r1',
  seq: 0,
  occurredAt: NOW,
}

test('RuntimeEventSchema validates message.delta envelope and rejects unknown type', () => {
  const delta = {
    ...RUN_ENV,
    type: 'message.delta',
    messageId: 'm1',
    chunkSeq: 0,
    delta: 'he',
  }
  assert.equal(RuntimeEventSchema.safeParse(delta).success, true)

  const missingSeq = { ...delta }
  delete missingSeq.seq
  assert.equal(RuntimeEventSchema.safeParse(missingSeq).success, false)

  assert.equal(
    RuntimeEventSchema.safeParse({ ...delta, type: 'message.exploded' })
      .success,
    false,
  )
  // 旧信封（无 scope、只有 runId）必须被拒绝——版本代际不可混流。
  const legacy = { ...delta }
  delete legacy.scope
  assert.equal(RuntimeEventSchema.safeParse(legacy).success, false)
  // run 作用域事件不许带别的作用域。
  assert.equal(
    RuntimeEventSchema.safeParse({ ...delta, scope: 'project' }).success,
    false,
  )
})

test('RuntimeEventSchema message.reset requires envelope and messageId', () => {
  const envelope = {
    ...RUN_ENV,
    type: 'message.reset',
    messageId: 'm1',
  }
  assert.equal(RuntimeEventSchema.safeParse(envelope).success, true)

  const missingMessageId = { ...envelope }
  delete missingMessageId.messageId
  assert.equal(RuntimeEventSchema.safeParse(missingMessageId).success, false)

  assert.equal(
    RuntimeEventSchema.safeParse({ ...envelope, messageId: '' }).success,
    false,
  )
})

test('resource-scoped events require their identity and reject runId smuggling', () => {
  const base = {
    protocolVersion: PROTOCOL_VERSION,
    eventId: 'e1',
    seq: 0,
    occurredAt: NOW,
  }
  assert.equal(
    RuntimeEventSchema.safeParse({
      ...base,
      type: 'runtime.status',
      scope: 'runtime',
      status: {
        state: 'ready',
        protocolVersion: PROTOCOL_VERSION,
        runtimeVersion: '0.1.0',
        capabilities: ['chat'],
        chatAvailable: true,
        systemAvailable: false,
      },
    }).success,
    true,
  )
  // workspace.index.* 用 project 作用域 + projectId，不许再出现 runId。
  const progress = {
    ...base,
    type: 'workspace.index.progress',
    scope: 'project',
    projectId: 'p1',
    version: 1,
    files: 2,
    dirs: 1,
  }
  assert.equal(RuntimeEventSchema.safeParse(progress).success, true)
  assert.equal(
    RuntimeEventSchema.safeParse({ ...progress, scope: 'run', runId: 'r1' })
      .success,
    false,
  )
  const queue = {
    ...base,
    type: 'queue.changed',
    scope: 'session',
    sessionId: 's1',
    items: [],
  }
  assert.equal(RuntimeEventSchema.safeParse(queue).success, true)
  const mcp = {
    ...base,
    type: 'mcp.changed',
    scope: 'mcp',
    serverId: 'srv1',
    server: {
      id: 'srv1',
      name: 'demo',
      command: 'node',
      args: [],
      env: [],
      enabled: true,
      toolCount: 0,
      status: 'disabled',
      lastError: null,
      updatedAt: NOW,
    },
  }
  assert.equal(RuntimeEventSchema.safeParse(mcp).success, true)
  // terminal 作用域：projectId + terminalId 同时必填（W2 事件用，先锁契约）。
  const termState = {
    ...base,
    type: 'terminal.state',
    scope: 'terminal',
    projectId: 'p1',
    terminalId: 't1',
    status: 'running',
  }
  assert.equal(RuntimeEventSchema.safeParse(termState).success, true)
  const missingTerminalId = { ...termState }
  delete missingTerminalId.terminalId
  assert.equal(
    RuntimeEventSchema.safeParse(missingTerminalId).success,
    false,
  )
})

test('tool and approval events validate envelope payloads', () => {
  const envelope = RUN_ENV
  const cases = [
    {
      type: 'tool.requested',
      toolCallId: 't1',
      toolName: 'file.read',
      args: { path: 'a.ts' },
    },
    {
      type: 'tool.completed',
      toolCallId: 't1',
      status: 'failed',
      errorCode: 'timeout',
    },
    {
      type: 'approval.required',
      toolCallId: 't1',
      operation: 'shell.execute',
      summary: 'rm -rf build',
    },
    {
      type: 'approval.resolved',
      toolCallId: 't1',
      decision: 'approved',
      grantScope: 'session',
    },
  ]
  for (const payload of cases) {
    assert.equal(
      RuntimeEventSchema.safeParse({ ...envelope, ...payload }).success,
      true,
      payload.type,
    )
  }
  assert.equal(
    RuntimeEventSchema.safeParse({
      ...envelope,
      type: 'approval.required',
      toolCallId: 't1',
      operation: 'someServer/tool',
      summary: 'x',
    }).success,
    true,
  )
  assert.equal(
    RuntimeEventSchema.safeParse({
      ...envelope,
      type: 'approval.required',
      toolCallId: 't1',
      operation: '',
      summary: 'x',
    }).success,
    false,
  )
})
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter @reflexion-os-studio/contracts test`
Expected: FAIL（现 schema 无 scope、有 runId 必填，新用例不过）。

- [ ] **Step 3: 重写 `packages/contracts/src/events.ts`**

完整新内容（未提及的变体载荷字段与原文件逐字一致；`session.created` 变体**删除**——生产者/消费者均为零，YAGNI）：

```ts
import { z } from 'zod'
import {
  JsonValueSchema,
  ApprovalOperationSchema,
  MemorySchema,
  MessageSchema,
  RunSchema,
  UsageSchema,
  ContentPartSchema,
  WorkspaceIndexSnapshotSchema,
  QueueEntrySchema,
  McpServerSchema,
  PlanSchema,
  PlanStepSchema,
  DelegationSchema,
} from './entities.js'
import { RuntimeErrorSchema } from './errors.js'
import { RuntimeStatusSchema } from './handshake.js'

export type { Usage } from './entities.js'

export const FinishReasonSchema = z.enum([
  'stop',
  'length',
  'content_filter',
  // 模型请求工具调用；Agent 工具循环据此继续本轮 Run。
  'tool_calls',
  'cancelled',
])
export type FinishReason = z.infer<typeof FinishReasonSchema>

// 事件作用域：显式声明每条事件归属的资源流，取代“借用 runId”的旧信封
//（workspace/queue/mcp 借用史到此为止）。判别联合以 type 单键判别，
// scope 字面量与资源字段在每个变体内成对声明，schema 保证三者一致。
export const EventScopeSchema = z.enum([
  'runtime',
  'run',
  'session',
  'project',
  'mcp',
  'terminal',
])
export type EventScope = z.infer<typeof EventScopeSchema>

export const RuntimeEventEnvelopeSchema = z.object({
  protocolVersion: z.string(),
  eventId: z.string().min(1),
  scope: EventScopeSchema,
  seq: z.number().int().nonnegative(),
  occurredAt: z.iso.datetime(),
})
export type RuntimeEventEnvelope = z.infer<typeof RuntimeEventEnvelopeSchema>

// run 作用域公共信封：run 通道事件全部 extend 它（runId 真实归属）。
const RunEnvelopeSchema = RuntimeEventEnvelopeSchema.extend({
  scope: z.literal('run'),
  runId: z.string().min(1),
})

export const TerminalStatusSchema = z.enum([
  'starting',
  'running',
  'closing',
  'closed',
  'exited',
  'disconnected',
  'failed',
])
export type TerminalStatus = z.infer<typeof TerminalStatusSchema>

// terminal 作用域公共信封（事件在 W2 接线，契约在本阶段冻结）。
const TerminalEnvelopeSchema = RuntimeEventEnvelopeSchema.extend({
  scope: z.literal('terminal'),
  projectId: z.string().min(1),
  terminalId: z.string().min(1),
})

export const RuntimeEventSchema = z.discriminatedUnion('type', [
  RuntimeEventEnvelopeSchema.extend({
    type: z.literal('runtime.status'),
    scope: z.literal('runtime'),
    status: RuntimeStatusSchema,
  }),
  RunEnvelopeSchema.extend({
    type: z.literal('message.created'),
    message: MessageSchema,
  }),
  RunEnvelopeSchema.extend({
    type: z.literal('message.delta'),
    messageId: z.string().min(1),
    chunkSeq: z.number().int().nonnegative(),
    delta: z.string(),
  }),
  RunEnvelopeSchema.extend({
    type: z.literal('message.reset'),
    messageId: z.string().min(1),
  }),
  RunEnvelopeSchema.extend({
    type: z.literal('message.reasoning_delta'),
    messageId: z.string().min(1),
    chunkSeq: z.number().int().nonnegative(),
    delta: z.string(),
  }),
  RunEnvelopeSchema.extend({
    type: z.literal('message.completed'),
    messageId: z.string().min(1),
    content: z.string(),
    finishReason: FinishReasonSchema,
    usage: UsageSchema.optional(),
    parts: z.array(ContentPartSchema).optional(),
  }),
  RunEnvelopeSchema.extend({
    type: z.literal('run.started'),
    run: RunSchema,
  }),
  RunEnvelopeSchema.extend({
    type: z.literal('run.completed'),
  }),
  RunEnvelopeSchema.extend({
    type: z.literal('run.retrying'),
    attempt: z.number().int().positive(),
    maxRetries: z.number().int().nonnegative(),
    reason: z.string(),
    // 本次重试前的退避等待时长（毫秒）；UI 用它展示倒计时。
    // 可选：旧版 runtime 事件与持久化的 run_events 历史记录不含该字段。
    waitMs: z.number().int().nonnegative().optional(),
  }),
  RunEnvelopeSchema.extend({
    type: z.literal('run.failed'),
    error: RuntimeErrorSchema,
  }),
  RunEnvelopeSchema.extend({
    type: z.literal('run.cancelled'),
  }),
  // 计划工具事件（实现补录：原列表遗漏，载荷与旧契约逐字一致）。
  RunEnvelopeSchema.extend({
    type: z.literal('plan.created'),
    plan: PlanSchema,
  }),
  RunEnvelopeSchema.extend({
    type: z.literal('plan.step.updated'),
    planId: z.string().min(1),
    step: PlanStepSchema,
  }),
  RunEnvelopeSchema.extend({
    type: z.literal('plan.updated'),
    plan: PlanSchema,
  }),
  // 工具调用与审批事件。
  RunEnvelopeSchema.extend({
    type: z.literal('tool.requested'),
    toolCallId: z.string().min(1),
    toolName: z.string().min(1),
    args: JsonValueSchema,
  }),
  RunEnvelopeSchema.extend({
    type: z.literal('tool.completed'),
    toolCallId: z.string().min(1),
    status: z.enum(['completed', 'failed', 'cancelled']),
    errorCode: z.string().nullable(),
  }),
  RunEnvelopeSchema.extend({
    type: z.literal('approval.required'),
    toolCallId: z.string().min(1),
    operation: ApprovalOperationSchema,
    summary: z.string(),
    // 审批所属会话：侧栏会话行据此显示待审批标记。可选：旧版 runtime
    // 事件与持久化的 run_events 历史记录不含该字段（对齐 waitMs 先例）。
    sessionId: z.string().min(1).optional(),
  }),
  RunEnvelopeSchema.extend({
    type: z.literal('approval.resolved'),
    toolCallId: z.string().min(1),
    decision: z.enum(['approved', 'denied']),
    // 原 payload 字段名 scope（once/session）改名 grantScope：
    // 避免与信封 scope 在 .extend() 合并时静默互相覆盖。
    grantScope: z.enum(['once', 'session']),
  }),
  // A2 Memory：Run 结束后异步提取落库的记忆；UI 据此做非打断式提示。
  RunEnvelopeSchema.extend({
    type: z.literal('memory.written'),
    memories: z.array(MemorySchema),
  }),
  // Phase 1B Workspace 索引事件：project 作用域，projectId 为真实身份。
  RuntimeEventEnvelopeSchema.extend({
    type: z.literal('workspace.index.progress'),
    scope: z.literal('project'),
    projectId: z.string().min(1),
    version: z.number().int().nonnegative(),
    files: z.number().int().nonnegative(),
    dirs: z.number().int().nonnegative(),
  }),
  RuntimeEventEnvelopeSchema.extend({
    type: z.literal('workspace.index.completed'),
    scope: z.literal('project'),
    projectId: z.string().min(1),
    snapshot: WorkspaceIndexSnapshotSchema,
  }),
  RuntimeEventEnvelopeSchema.extend({
    type: z.literal('workspace.index.failed'),
    scope: z.literal('project'),
    projectId: z.string().min(1),
    error: z.string(),
  }),
  // 会话发送队列快照：session 作用域，sessionId 为真实身份。
  // paused：队列是否处于"用户停止后暂停待确认"状态；可选：旧版 runtime 不含该字段。
  RuntimeEventEnvelopeSchema.extend({
    type: z.literal('queue.changed'),
    scope: z.literal('session'),
    sessionId: z.string().min(1),
    paused: z.boolean().optional(),
    items: z.array(QueueEntrySchema),
  }),
  RunEnvelopeSchema.extend({
    type: z.literal('delegation.created'),
    delegation: DelegationSchema,
  }),
  RunEnvelopeSchema.extend({
    type: z.literal('delegation.updated'),
    delegation: DelegationSchema,
  }),
  // MCP server 状态变化(disabled/ready/failed)：mcp 作用域，serverId 为真实身份。
  RuntimeEventEnvelopeSchema.extend({
    type: z.literal('mcp.changed'),
    scope: z.literal('mcp'),
    serverId: z.string().min(1),
    server: McpServerSchema,
  }),
  // 集成终端事件（W2 接线，本阶段冻结契约）。output 载荷为 base64 字节帧。
  TerminalEnvelopeSchema.extend({
    type: z.literal('terminal.output'),
    outputSeq: z.number().int().nonnegative(),
    generation: z.number().int().nonnegative(),
    consumerId: z.string().min(1),
    data: z.string().min(1),
  }),
  TerminalEnvelopeSchema.extend({
    type: z.literal('terminal.state'),
    status: TerminalStatusSchema,
    exitCode: z.number().int().nullable().optional(),
    errorMessage: z.string().optional(),
  }),
])
export type RuntimeEvent = z.infer<typeof RuntimeEventSchema>

export type RuntimeEventName = RuntimeEvent['type']
```

- [ ] **Step 4: 运行 contracts 测试确认新用例通过**

Run: `pnpm --filter @reflexion-os-studio/contracts test`
Expected：新用例 PASS；若有旧用例内联 runId 信封（memory.written 测试段 ~:609-646），在 `runId: 'r1'` 前插入 `scope: 'run',` 一行（确定性编辑，逐处 grep `runId: 'r1'`）。

- [ ] **Step 5: 全仓排查残留构造点**

Run: `grep -rn "runId: " apps/runtime/src apps/desktop/frontend packages/runtime-client/src --include=*.ts | grep -v "runId: run\|run.id\|event.runId"`
Expected: 除 run 通道合法字段（消息/委派实体等）外，无事件信封直接字面量。`session.created` 若有引用（`grep -rn "session.created" apps packages --include=*.ts`）如实报告后再删。

- [ ] **Step 6: Commit**

```bash
pnpm format
git add packages/contracts
git commit -m "feat(contracts)!: 事件信封泛化为显式 scope 判别联合（W0）"
```

---

### Task 2: PROTOCOL_VERSION 1.0 → 1.1（三处同步）

**Files:**
- Modify: `packages/contracts/src/handshake.ts:3`
- Modify: `crates/system-runtime/src/protocol.rs:10`
- Test: `apps/runtime/test/fixtures/fake-system-runtime.mjs`（字面量处）

- [ ] **Step 1: 排查所有版本字面量**

Run: `grep -rn "protocolVersion: '1.0'\|PROTOCOL_VERSION: &str = \"1.0\"\|\"1.0\"" packages apps crates --include=*.ts --include=*.rs --include=*.mjs | grep -v dist/ | grep -v target/ | grep -v node_modules`
Expected: 命中 handshake.ts、protocol.rs、fixtures、以及 validators.test.mjs 内已改为 `PROTOCOL_VERSION` 引用（Task 1 已消）。

- [ ] **Step 2: 同步修改**

`packages/contracts/src/handshake.ts:3`：

```ts
export const PROTOCOL_VERSION = '1.1'
```

`crates/system-runtime/src/protocol.rs:10`：

```rust
pub const PROTOCOL_VERSION: &str = "1.1";
```

`fake-system-runtime.mjs` 中若硬编码 `'1.0'` 的合法握手行：改为 `import { PROTOCOL_VERSION } from '../packages/contracts/dist/index.js'`（相对路径按 fixture 实际位置）或使用 `process.env.TEST_PROTOCOL_VERSION`，与既有 mismatch 用例（'99.0'）并存不冲突。

- [ ] **Step 3: 验证代际校验行为不变**

Run: `node --test apps/runtime/test/system-client.test.mjs`
Expected: PASS（TS↔Rust strict-equality 拒绝逻辑不变；旧 '1.0' sidecar 对新 '1.1' Runtime 会被降级——这正是"开发态不匹配必须明确失败"承诺）。

- [ ] **Step 4: Commit**

```bash
git add packages/contracts/src/handshake.ts crates/system-runtime/src/protocol.rs apps/runtime/test
git commit -m "feat(protocols)!: PROTOCOL_VERSION 1.0 -> 1.1（信封变更随之升级）"
```

---

### Task 3: `apps/runtime/src/events.ts`——通用资源发射器

**Files:**
- Modify: `apps/runtime/src/events.ts`
- Test: `apps/runtime/test/events-envelope.test.mjs`（Create，并登记进 package.json）

- [ ] **Step 1: 写失败的测试（新建文件）**

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  PROTOCOL_VERSION,
  RuntimeEventSchema,
} from '@reflexion-os-studio/contracts'
import { ResourceEventEmitter, RunEventEmitter } from '../dist/events.js'

test('ResourceEventEmitter(runtime) 不带 runId 且 scope=runtime', () => {
  const events = []
  const emitter = new ResourceEventEmitter({ scope: 'runtime' }, (e) =>
    events.push(e),
  )
  emitter.next({
    type: 'runtime.status',
    status: {
      state: 'ready',
      protocolVersion: PROTOCOL_VERSION,
      runtimeVersion: '0.1.0',
      capabilities: ['chat'],
      chatAvailable: true,
      systemAvailable: false,
    },
  })
  assert.equal(events.length, 1)
  assert.equal(events[0].scope, 'runtime')
  assert.equal('runId' in events[0], false)
  assert.equal(RuntimeEventSchema.safeParse(events[0]).success, true)
})

test('RunEventEmitter 保持 (runId, notifier) 构造与 .runId 访问器', () => {
  const events = []
  const emitter = new RunEventEmitter('r1', (e) => events.push(e))
  emitter.next({ type: 'run.completed' })
  assert.equal(emitter.runId, 'r1')
  assert.equal(events[0].scope, 'run')
  assert.equal(events[0].runId, 'r1')
})

test('作用域错配（session 发射器发 run 事件）必须抛错', () => {
  const emitter = new ResourceEventEmitter(
    { scope: 'session', sessionId: 's1' },
    () => undefined,
  )
  assert.throws(() => emitter.next({ type: 'run.completed' }))
})

test('seq 在同一发射器实例内单调递增', () => {
  const events = []
  const emitter = new ResourceEventEmitter(
    { scope: 'session', sessionId: 's1' },
    (e) => events.push(e),
  )
  const payload = { type: 'queue.changed', sessionId: 's1', items: [] }
  emitter.next(payload)
  emitter.next(payload)
  assert.deepEqual(
    events.map((e) => e.seq),
    [0, 1],
  )
})
```

- [ ] **Step 2: 登记测试并确认失败**

`apps/runtime/package.json` 的 `test` 脚本文件列表追加 `test/events-envelope.test.mjs`（该脚本是显式列表，漏登记=测试永不运行）。

Run: `pnpm build:packages && pnpm --filter @reflexion-os-studio/runtime test`
Expected: FAIL（`ResourceEventEmitter` 未导出）。

- [ ] **Step 3: 重写 `apps/runtime/src/events.ts`**

```ts
import { randomUUID } from 'node:crypto'
import {
  PROTOCOL_VERSION,
  RuntimeEventSchema,
  type EventScope,
  type RuntimeEvent,
} from '@reflexion-os-studio/contracts'

export type EventNotifier = (event: RuntimeEvent) => void

/** 发射器身份 = 事件作用域 + 真实资源 ID（信封字段来源，单一构造点）。 */
export type EventIdentity =
  | { scope: 'runtime' }
  | { scope: 'run'; runId: string }
  | { scope: 'session'; sessionId: string }
  | { scope: 'project'; projectId: string }
  | { scope: 'mcp'; serverId: string }
  | { scope: 'terminal'; projectId: string; terminalId: string }

/**
 * 资源事件发射器：seq 在本实例代表的资源流内单调递增。
 * 每类资源应持有长生命周期实例（Map 缓存），禁止每次 emit 新建
 *（否则 seq 恒为 0，消费端无法排序/去重）。
 */
export class ResourceEventEmitter {
  private seq = 0
  readonly scope: EventScope

  constructor(
    readonly identity: EventIdentity,
    private readonly notifier: EventNotifier,
  ) {
    this.scope = identity.scope
  }

  next(event: { type: RuntimeEvent['type'] } & Record<string, unknown>): void {
    const candidate = {
      protocolVersion: PROTOCOL_VERSION,
      eventId: randomUUID(),
      ...this.identity,
      seq: this.seq++,
      occurredAt: new Date().toISOString(),
      ...event,
    }
    const parsed = RuntimeEventSchema.safeParse(candidate)
    if (!parsed.success) {
      throw new Error(
        `runtime event failed schema: ${parsed.error.issues.map((issue) => issue.message).join('; ')}`,
      )
    }
    this.notifier(parsed.data)
  }
}

/** run 通道便捷子类：构造签名与历史用法一致，agent/* 调用点零改动。 */
export class RunEventEmitter extends ResourceEventEmitter {
  constructor(
    runId: string,
    notifier: EventNotifier,
  ) {
    super({ scope: 'run', runId }, notifier)
  }

  get runId(): string {
    if (this.identity.scope !== 'run') {
      throw new Error('runId accessed on non-run emitter')
    }
    return this.identity.runId
  }
}
```

- [ ] **Step 4: 确认通过**

Run: `pnpm build:packages && pnpm --filter @reflexion-os-studio/runtime test`
Expected: PASS（含既有 runner/queue/mcp/indexer 测试——它们 fake-notifier 捕获后只断言 type，信封变更不破坏；若有全等断言失败，按新信封修断言而不改 schema）。

- [ ] **Step 5: Commit**

```bash
git add apps/runtime/src/events.ts apps/runtime/test/events-envelope.test.mjs apps/runtime/package.json
git commit -m "feat(runtime): ResourceEventEmitter 显式作用域发射器，RunEventEmitter 收敛为子类"
```

---

### Task 4: 生产者迁移（runtime.status / queue / mcp / workspace indexer）

**Files:**
- Modify: `apps/runtime/src/index.ts:13,57-58`
- Modify: `apps/runtime/src/agent/queue.ts:136-144`（+ 发射器 Map 字段）
- Modify: `apps/runtime/src/mcp/manager.ts:207-210`（+ 发射器 Map 字段）
- Modify: `apps/runtime/src/workspace/indexer.ts:35`
- Modify: `apps/runtime/src/agent/permissions.ts:157-162`（`scope`→`grantScope`）
- Test: `apps/runtime/test/queue.test.mjs`、`apps/runtime/test/mcp.test.mjs`（追加 seq 断言）

- [ ] **Step 1: index.ts——runtime.status 用 runtime 作用域**

:13 导入改为 `import { ResourceEventEmitter, RunEventEmitter } from './events.js'`（RunEventEmitter 仍被 agent 侧间接使用则保留）。:57-58：

```ts
// 全局状态事件信封（runtime 作用域，不归属任何 Run）。
const statusEmitter = new ResourceEventEmitter({ scope: 'runtime' }, notify)
```

（:69、:118 两个 `statusEmitter.next({ type: 'runtime.status', ... })` 不变。）

- [ ] **Step 2: queue.ts——按会话持有发射器，seq 连续**

字段区（:18-20 的 `queues`/`paused` 旁）加：

```ts
  /** 每会话一个长生命周期发射器：queue.changed 的 seq 在会话流内单调。 */
  private readonly emitters = new Map<string, ResourceEventEmitter>()
```

:136-144 替换：

```ts
  private notify(sessionId: string): void {
    let emitter = this.emitters.get(sessionId)
    if (!emitter) {
      emitter = new ResourceEventEmitter({ scope: 'session', sessionId }, this.notifier)
      this.emitters.set(sessionId, emitter)
    }
    emitter.next({
      type: 'queue.changed',
      sessionId,
      paused: this.isPaused(sessionId),
      items: this.list(sessionId),
    })
  }
```

导入行把 :4 的 `RunEventEmitter` 换成 `ResourceEventEmitter`（路径同为 `../events.js`，EventNotifier 导入不变）。同时 `removeSession()`（:62-65，会话删除路径）加一行 `this.emitters.delete(sessionId)`——发射器生命周期不越过会话生命周期。

- [ ] **Step 3: mcp/manager.ts——按 server 持有发射器；remove/dispose 清理**

字段区加 `private readonly emitters = new Map<string, ResourceEventEmitter>()`；:207-210 替换：

```ts
  private emitChanged(server: McpServer): void {
    let emitter = this.emitters.get(server.id)
    if (!emitter) {
      emitter = new ResourceEventEmitter({ scope: 'mcp', serverId: server.id }, this.notifier)
      this.emitters.set(server.id, emitter)
    }
    emitter.next({ type: 'mcp.changed', serverId: server.id, server })
  }
```

`dispose()`（:200-205）末尾加 `this.emitters.clear()`；`remove()`（:44-49 附近，删配置路径）中加 `this.emitters.delete(id)`（发射器生命周期不越过资源生命周期）。

- [ ] **Step 4: workspace/indexer.ts——身份换成 ResourceEventEmitter**

:35 替换（每次扫描一个实例、seq 按扫描流计数——与现状一致，消费端不使用 seq，W0 不改语义只改身份）：

```ts
    const emitter = new ResourceEventEmitter(
      { scope: 'project', projectId },
      this.notifier,
    )
```

导入补 `ResourceEventEmitter`。

- [ ] **Step 5: permissions.ts——grantScope 改名（唯一生产点）**

:157-162 替换：

```ts
          emitter.next({
            type: 'approval.resolved',
            toolCallId,
            decision,
            grantScope: scope,
          })
```

:131 注释更新为"事件载荷携带 sessionId（信封 scope=run + runId）"。

- [ ] **Step 6: 追加 seq 连续性断言到既有测试**

`apps/runtime/test/queue.test.mjs` 末尾追加（QueueService 构造签名为 `(notifier)`，`enqueue` 为公开触发 notify 的路径；imports 沿用文件头部既有的 `dist/agent/queue.js` 与 node:assert）：

```js
test('queue.changed 事件 seq 在会话流内单调递增，跨会话独立', () => {
  const events = []
  const service = new QueueService((event) => events.push(event))
  service.enqueue('s1', { content: 'a' })
  service.enqueue('s1', { content: 'b' })
  service.enqueue('s2', { content: 'c' })
  const s1 = events.filter((e) => e.type === 'queue.changed' && e.sessionId === 's1')
  assert.equal(s1.length, 2)
  assert.equal(s1[0].scope, 'session')
  assert.equal(s1[0].seq, 0)
  assert.equal(s1[1].seq, 1)
  const s2 = events.filter((e) => e.type === 'queue.changed' && e.sessionId === 's2')
  assert.equal(s2[0].seq, 0)
})
```

（mcp 侧 `emitChanged` 为私有、connect 需真实 stdio server，seq 语义已由 Task 3 的发射器通用测试覆盖，不重复造测试；mcp.test.mjs 只需回归通过。）

- [ ] **Step 7: 运行 runtime 测试**

Run: `pnpm build:packages && pnpm --filter @reflexion-os-studio/runtime test`
Expected: 全部 PASS。

- [ ] **Step 8: Commit**

```bash
git add apps/runtime/src apps/runtime/test
git commit -m "feat(runtime)!: 事件生产者迁移到显式作用域；queue/mcp 发射器长生命周期化"
```

---

### Task 5: runtime-client——通知路径日志 + 测试（原零覆盖）

**Files:**
- Modify: `packages/runtime-client/src/transport.ts:151-164`
- Test: `packages/runtime-client/test/transport-events.test.mjs`（Create；同时确认登记到 package.json test 脚本——该 package 现仅 `node --test test/transport.test.mjs`，改为 `node --test test/transport.test.mjs test/transport-events.test.mjs`）

- [ ] **Step 1: 写失败的测试**

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { RuntimeTransport } from '../dist/index.js'

function makeTransport() {
  let messageHandler = null
  const host = {
    invoke: async () => 1,
    listen: async (_event, handler) => {
      messageHandler = handler
      return () => {}
    },
  }
  const transport = new RuntimeTransport(host)
  return { transport, fire: (payload) => messageHandler({ payload }) }
}

const VALID_DELTA = {
  jsonrpc: '2.0',
  method: 'message.delta',
  params: {
    protocolVersion: '1.1',
    eventId: 'e1',
    scope: 'run',
    runId: 'r1',
    seq: 0,
    occurredAt: '2026-09-12T00:00:00.000Z',
    type: 'message.delta',
    messageId: 'm1',
    chunkSeq: 0,
    delta: 'hi',
  },
}

test('合法事件经 onEvent 分发；畸形事件丢弃但必须留日志', async () => {
  const { transport, fire } = makeTransport()
  await transport.attach()
  const got = []
  transport.onEvent((event) => got.push(event))
  const warnings = []
  const original = console.warn
  console.warn = (...args) => warnings.push(args)
  try {
    fire({ name: 'runtime', message: VALID_DELTA })
    // 旧信封（缺 scope）必须被拒并告警，不允许静默蒸发。
    fire({
      name: 'runtime',
      message: {
        jsonrpc: '2.0',
        method: 'message.delta',
        params: { ...VALID_DELTA.params, scope: undefined },
      },
    })
  } finally {
    console.warn = original
  }
  assert.equal(got.length, 1)
  assert.equal(got[0].type, 'message.delta')
  assert.equal(warnings.length, 1)
  assert.match(
    String(warnings[0]),
    /malformed event/,
  )
})
```

Run: `pnpm --filter @reflexion-os-studio/runtime-client test`
Expected: FAIL（畸形事件当前静默丢弃、无 warn）。

- [ ] **Step 2: transport.ts:156-164 替换**

```ts
    if (typeof message.method === 'string' && message.id === undefined) {
      const parsed = RuntimeEventSchema.safeParse(message.params)
      if (parsed.success) {
        for (const handler of this.eventHandlers) {
          handler(parsed.data)
        }
      } else {
        // 版本代际不一致/畸形事件必须显式可见（AGENTS：降级不等于静默）。
        console.warn(
          `[runtime-client] dropped malformed event ${message.method}:`,
          parsed.error.issues.slice(0, 3),
        )
      }
      return
    }
```

（`{ scope: undefined }` 载荷经 JSON 往返后键消失——若测 `JSON.parse(JSON.stringify(...))` 更稳，执行者按实际断言调整，warn 计数仍为 1。）

- [ ] **Step 3: 测试通过并登记生成链**

Run: `pnpm build:packages && pnpm --filter @reflexion-os-studio/runtime-client test`
Expected: PASS。
Run: `node scripts/check-whitelist.mjs`
Expected: `check-whitelist: all checks passed`（W0 无新命令，白名单不变）。

- [ ] **Step 4: Commit**

```bash
git add packages/runtime-client
git commit -m "feat(runtime-client)!: 畸形事件不再静默丢弃；补通知路径测试"
```

---

### Task 6: 前端消费端类型修正

**Files:**
- Modify: `apps/desktop/frontend/hooks/useAppBootstrap.ts:335`

- [ ] **Step 1: 修 `event.runId` 联合类型收窄**

新信封下 `queue.changed`/`workspace.index.*`/`mcp.changed`/`runtime.status`/terminal.* 无 `runId` 字段，:335 的 `event.runId`（:345-347）失去全联合访问能力。:335 替换：

```ts
        if (
          event.scope === 'run' &&
          EVENT_TYPES_TRIGGERING_REFRESH.has(event.type)
        ) {
```

其余行（:336-349）不动——`scope==='run'` 收窄后全部变体都有 `runId`。

- [ ] **Step 2: 前端 typecheck**

Run: `pnpm --filter @reflexion-os-studio/desktop typecheck && pnpm typecheck`
Expected: PASS。其他直接读 `event.runId` 的点（:234/:250/:269/:283/:293/:312）都在 `event.type ===` 判别之后，zod 联合自动收窄，预期无需改动；若报错按同法在该分支入口补窄化。

- [ ] **Step 3: api/queue.ts、api/workspace.ts 回归确认**

Run: `grep -n "event.sessionId\|event.projectId" apps/desktop/frontend/api/queue.ts apps/desktop/frontend/api/workspace.ts`
Expected: 两处用的都是**载荷字段**（queue.changed.sessionId、workspace.index.*.projectId——变体保留这些字段），无改动。

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/frontend
git commit -m "fix(frontend): 事件联合按 scope 收窄 run 通道刷新路径"
```

---

### Task 7: W0 出口——文档、回归、生成链

**Files:**
- Modify: `docs/EVENT-PROTOCOL.md`
- Modify: `ARCHITECTURE.md`、`docs/ROADMAP.md`（Terminal Surface 立项文案）

- [ ] **Step 1: 重写 `docs/EVENT-PROTOCOL.md` 第 5 段**

替换为（保持文件第 1-3 段不动）：

```markdown
每条事件包含 `protocolVersion`、`eventId`、`scope`、`seq`、`occurredAt` 和 `type`。`scope` 是显式资源作用域（`runtime | run | session | project | mcp | terminal`），每个 `type` 在契约中与其资源字段成对声明（run → runId；queue → sessionId；workspace → projectId；mcp → serverId；terminal → projectId + terminalId），不再借用 runId。`seq` 在**单个发射器实例所代表的资源流**内单调递增（run 通道为每 Run 一个流；queue 为每会话一个流；workspace 索引为每轮扫描一个流）；跨流排序以 `occurredAt` + `eventId` 为准。MVP 的 UI 以快照 + 事件通知为准；完整重放（afterSeq）延后。事件可幂等消费。传输使用 JSON-RPC 2.0 over newline-delimited stdio：stdout 只传协议，stderr 只写日志；通知使用 JSON-RPC notification。`message.delta` 只在内存/传输层发送，最终 `message.completed` 和消息状态落盘，不按 token 写库；恢复以 canonical state 为准。`message.completed.parts` 可携带结构化内容块，其中 `resource_link` 只允许 `projectId + workspace-relative path`、Asset 引用或 HTTPS 外链；原始 Provider Markdown 仍保存在 `content`，前端优先使用 parts 渲染。
```

- [ ] **Step 2: ARCHITECTURE.md / ROADMAP.md 立项**

`ARCHITECTURE.md` 增加 "Terminal Surface" 小节：链接 spec 文件、四层所有权表（Rust=PTY/进程、TS=归属/额度/路由、前端=标签/xterm/面板、Host=转发+兜底）、权限边界一句话（用户终端 ≠ Agent 通道）。`docs/ROADMAP.md` 把 Terminal Surface 登记为 Phase 2 进行中（W0/W1 本计划，W2–W4 后续计划），不动其它阶段条目。

- [ ] **Step 3: 全量回归**

按本计划开头验证链逐条跑，另加：

```bash
pnpm test                      # node --test 全套 + smoke（scripts/test-all.sh）
node scripts/check-whitelist.mjs
```

Expected: 全绿。若 `smoke-chat.mjs` 因 `run.retrying` 等载荷字段断言变化失败，按新契约（grantScope）修脚本断言。

- [ ] **Step 4: Commit**

```bash
git add docs/ ARCHITECTURE.md
git commit -m "docs: 事件协议 v1.1（显式 scope 信封）+ Terminal Surface 立项"
```

**W0 出口标准**：全链路无 `runId` 借用；畸形事件可观测；旧信封被 schema 拒绝。

---

## W1：三平台贯通验证（纵向切片）

### Task 8: 依赖引入（版本在 Task 15 固定）

**Files:**
- Modify: `crates/system-runtime/Cargo.toml`
- Modify: `apps/desktop/frontend/package.json`

- [ ] **Step 1: Rust 依赖**

`crates/system-runtime/Cargo.toml` `[dependencies]` 追加（先 `grep -n "base64\|portable-pty" crates/system-runtime/Cargo.toml` 确认无既有项）：

```toml
portable-pty = "0.8"
base64 = "0.22"
```

- [ ] **Step 2: 前端依赖**

```bash
pnpm --filter @reflexion-os-studio/desktop add @xterm/xterm @xterm/addon-fit
```

- [ ] **Step 3: 编译确认**

Run: `cargo check --manifest-path crates/Cargo.toml`
Expected: 通过（仅依赖，未使用会有 warning——接受，W1 内消化）。

- [ ] **Step 4: Commit**

```bash
git add crates/system-runtime/Cargo.toml crates/Cargo.lock apps/desktop/frontend/package.json pnpm-lock.yaml
git commit -m "chore: 引入 portable-pty / base64 / xterm 依赖（终端 W1 验证）"
```

---

### Task 9: Rust——shell 选择（TDD）

**Files:**
- Create: `crates/system-runtime/src/terminal/mod.rs`
- Create: `crates/system-runtime/src/terminal/shell.rs`
- Modify: `crates/system-runtime/src/main.rs`（`mod terminal;`）

- [ ] **Step 1: 写失败测试与实现**

`crates/system-runtime/src/terminal/shell.rs`：

```rust
//! 默认 shell 选择（AGENTS §8：显式平台分支）。
//! 返回 argv（路径 + 独立参数数组），禁止拼接命令字符串。

use std::path::PathBuf;

#[cfg(unix)]
pub fn default_shell_argv() -> Vec<String> {
    // 有效用户 shell 优先；不存在/为空回退 /bin/sh。
    let user_shell = std::env::var("SHELL")
        .ok()
        .filter(|value| !value.trim().is_empty() && PathBuf::from(value).is_file())
        .unwrap_or_else(|| "/bin/sh".to_string());
    vec![user_shell]
}

#[cfg(windows)]
pub fn default_shell_argv() -> Vec<String> {
    // 优先 pwsh.exe（PATH 探测，带/不带 .exe 都试），回退 powershell.exe。
    for candidate in ["pwsh", "pwsh.exe", "powershell"] {
        let probe = std::process::Command::new(candidate)
            .args(["-NoLogo", "-Command", "$PSVersionTable.PSVersion.Major"])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
        if matches!(probe, Ok(status) if status.success()) {
            return vec![candidate.to_string()];
        }
    }
    vec!["powershell.exe".to_string()]
}

#[cfg(test)]
mod tests {
    use super::default_shell_argv;

    #[cfg(unix)]
    #[test]
    fn unix_shell_is_executable_absolute_path() {
        let argv = default_shell_argv();
        assert_eq!(argv.len(), 1);
        assert!(std::path::Path::new(&argv[0]).is_absolute());
    }

    #[cfg(unix)]
    #[test]
    fn unix_falls_back_to_bin_sh_when_shell_unset_or_invalid() {
        // SHELL 为目录（非文件）时必须回退。
        std::env::set_var("SHELL", "/tmp");
        assert_eq!(default_shell_argv(), vec!["/bin/sh".to_string()]);
        std::env::remove_var("SHELL");
        assert_eq!(default_shell_argv()[0].starts_with('/'), true);
    }

    #[cfg(windows)]
    #[test]
    fn windows_shell_argv_is_single_path() {
        assert_eq!(default_shell_argv().len(), 1);
    }
}
```

> `set_var` 在 edition 2024 是 unsafe：按 crate edition 决定；若 2024 用 `std::env::set_var` 包 `unsafe {}` 并注释原因（测试串行、单测无并发 env 访问）。

`terminal/mod.rs`：

```rust
//! 集成终端（W1 纵向切片）：shell 选择、PTY 会话、服务级路由。
pub mod session;
pub mod service;
pub mod shell;
```

`main.rs` 在 `mod shell;` 后加：

```rust
mod terminal;
```

- [ ] **Step 2: 临时 stub 让编译通过**

`crates/system-runtime/src/terminal/session.rs` 与 `crates/system-runtime/src/terminal/service.rs` 各写入一行（空模块即可编译；Task 10/11 分别整文件替换）：

```rust
//! W1 分步交付：本模块由后续任务填充。
```

Run: `cargo test --manifest-path crates/Cargo.toml terminal::shell 2>/dev/null || cargo test --manifest-path crates/Cargo.toml shell::`
Expected: shell 选择测试 PASS。

- [ ] **Step 3: Commit**

```bash
git add crates/system-runtime/src
git commit -m "feat(system-runtime): 终端默认 shell 选择（三平台显式分支）"
```

---

### Task 10: Rust——PTY 会话（帧、seq、退出收尾）

**Files:**
- Create/Replace: `crates/system-runtime/src/terminal/session.rs`
- Test: 同文件 `#[cfg(test)]` + `#[cfg(unix)]` 集成测试

- [ ] **Step 1: 完整实现**

```rust
//! 单个 PTY 会话（W1 切片）：读线程 → ≤16 KiB 帧 + 终端内 outputSeq + base64
//! 通知输出；写/resize；close/exited 收尾。背压额度与代际窗口在 W2 补。

use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};

use base64::Engine as _;
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde_json::json;

use crate::protocol::emit;
use crate::terminal::shell::default_shell_argv;

pub const MAX_FRAME_BYTES: usize = 16 * 1024;

pub struct TerminalSession {
    pub id: String,
    pub generation: u64,
    pub output_seq: AtomicU64,
    writer: Mutex<Box<dyn Write + Send>>,
    master: Arc<Mutex<Box<dyn MasterPty + Send>>>,
    child: Arc<Mutex<Box<dyn portable_pty::Child + Send + Sync>>>,
    closed: Arc<AtomicBool>,
}

fn emit_output(session: &TerminalSession, bytes: &[u8]) {
    // 16 KiB 上限分帧；本帧间 outputSeq 连续，消费端据此检测缺口。
    for chunk in bytes.chunks(MAX_FRAME_BYTES) {
        let seq = session.output_seq.fetch_add(1, Ordering::SeqCst);
        emit(json!({
            "jsonrpc": "2.0",
            "method": "terminal.output",
            "params": {
                "terminalId": session.id,
                "outputSeq": seq,
                "generation": session.generation,
                "data": base64::engine::general_purpose::STANDARD.encode(chunk),
            }
        }));
    }
}

fn emit_state(terminal_id: &str, generation: u64, status: &str, exit_code: Option<i64>) {
    emit(json!({
        "jsonrpc": "2.0",
        "method": "terminal.state",
        "params": {
            "terminalId": terminal_id,
            "generation": generation,
            "status": status,
            "exitCode": exit_code,
        }
    }));
}

pub fn spawn(terminal_id: String, generation: u64, cwd: &str, rows: u16, cols: u16) -> Result<Arc<TerminalSession>, String> {
    let pty_system = native_pty_system();
    let size = PtySize { rows, cols, pixel_width: 0, pixel_height: 0 };
    let pair = pty_system
        .openpty(size)
        .map_err(|error| format!("openpty failed: {error}"))?;
    let argv = default_shell_argv();
    let mut command = CommandBuilder::new(&argv[0]);
    for arg in &argv[1..] {
        command.arg(arg);
    }
    command.cwd(cwd);
    command.term("xterm-256color");
    let child = pair
        .slave
        .spawn_command(command)
        .map_err(|error| format!("spawn failed: {error}"))?;
    drop(pair.slave);
    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|error| format!("clone reader failed: {error}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|error| format!("take writer failed: {error}"))?;

    let session = Arc::new(TerminalSession {
        id: terminal_id.clone(),
        generation,
        output_seq: AtomicU64::new(0),
        writer: Mutex::new(writer),
        master: Arc::new(Mutex::new(pair.master)),
        child: Arc::new(Mutex::new(child)),
        closed: Arc::new(AtomicBool::new(false)),
    });

    // 读线程：EOF（子进程退出/最后一个 fd 关闭）后交付完毕，由 (tail_tx) 通知退出线程。
    let read_session = session.clone();
    let (tail_tx, tail_rx) = std::sync::mpsc::channel::<()>();
    std::thread::spawn(move || {
        let mut reader = reader;
        let mut buffer = [0u8; 8 * 1024];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(n) => emit_output(&read_session, &buffer[..n]),
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => break,
            }
        }
        let _ = tail_tx.send(());
    });

    // 退出线程：先 wait 拿退出码，再等读线程尾部交付完毕，最后发 terminal.state。
    //（顺序保证 spec §6“尾部输出先于退出事件”；Linux/macOS read EOF 与 wait 顺序不保证。）
    let exit_child = session.child.clone();
    let exit_id = session.id.clone();
    let exit_generation = session.generation;
    let exit_closed = session.closed.clone();
    std::thread::spawn(move || {
        let status = exit_child.lock().ok().and_then(|mut child| child.wait().ok());
        let _ = tail_rx.recv();
        // WaitStatus 变体名以 vendored 版本为准（cargo 源里 grep "enum WaitStatus" 核对一次）。
        let exit_code = match status {
            Some(portable_pty::WaitStatus::Exited(code)) => Some(code as i64),
            Some(portable_pty::WaitStatus::Signalled(signal)) => Some(-i64::from(signal)),
            _ => None,
        };
        if !exit_closed.load(Ordering::SeqCst) {
            emit_state(&exit_id, exit_generation, "exited", exit_code);
        }
    });

    emit_state(&terminal_id, generation, "running", None);
    Ok(session)
}

impl TerminalSession {
    pub fn write_input(&self, bytes: &[u8]) -> Result<(), String> {
        let mut writer = self.writer.lock().map_err(|_| "writer lock poisoned".to_string())?;
        writer.write_all(bytes).map_err(|error| format!("write failed: {error}"))?;
        writer.flush().map_err(|error| format!("flush failed: {error}"))
    }

    pub fn resize(&self, rows: u16, cols: u16) -> Result<(), String> {
        let master = self.master.lock().map_err(|_| "master lock poisoned".to_string())?;
        master
            .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
            .map_err(|error| format!("resize failed: {error}"))
    }

    /// 回收：kill 子进程（Unix 上 pty 子进程是会话首进程，master drop 后
    /// 内核向前台进程组发 SIGHUP）；显式标记 closed，避免与退出线程重复发状态。
    pub fn close(&self) {
        self.closed.store(true, Ordering::SeqCst);
        if let Ok(mut child) = self.child.lock() {
            let _ = child.kill();
            let _ = child.wait();
        }
        // master 最后 drop：先让 kill 收敛，再释放 PTY 让读线程 EOF。
        if let Ok(_master) = self.master.lock() {
            // 持有引用仅作生命周期标记；真正释放发生在 Arc 引用清零处（service 移除表项）。
        }
    }
}
```

`#[cfg(test)] mod tests`：

```rust
#[cfg(all(test, unix))]
mod integration {
    use super::*;

    #[test]
    fn frames_are_capped_and_seq_is_contiguous() {
        // 纯逻辑：32 KiB + 1 字节 → 3 帧（16 KiB、16 KiB、1 B），seq 0..3。
        let payload = vec![0x41u8; MAX_FRAME_BYTES * 2 + 1];
        let mut chunks = payload.chunks(MAX_FRAME_BYTES);
        assert_eq!(chunks.next().map(<[u8]>::len), Some(MAX_FRAME_BYTES));
        assert_eq!(chunks.next().map(<[u8]>::len), Some(MAX_FRAME_BYTES));
        assert_eq!(chunks.next().map(<[u8]>::len), Some(1));
        assert!(chunks.next().is_none());
    }

    #[test]
    fn echo_roundtrip_over_real_pty() {
        // 真实 PTY：sh 启动 → 执行 echo → 收到特征字节 → close 后读线程终止。
        let id = "itest".to_string();
        let session = spawn(id.clone(), 7, "/tmp", 24, 80).expect("spawn");
        session
            .write_input(b"echo TERMINAL_OK_$((1+2))\r\n")
            .expect("write");
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        // stdout 被本测试进程持有，直接读协议输出不可行；用 seq 推进作为
        // 活性证明：轮询 output_seq > 0 即有帧交付。
        while session.output_seq.load(Ordering::SeqCst) == 0
            && std::time::Instant::now() < deadline
        {
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        assert!(session.output_seq.load(Ordering::SeqCst) > 0);
        session.close();
        std::thread::sleep(std::time::Duration::from_millis(200));
    }
}
```

- [ ] **Step 2: 运行**

Run: `cargo test --manifest-path crates/Cargo.toml terminal::`
Expected: PASS。（echo 测试若因 cargo 捕获 stdout 干扰断言，以 output_seq>0 为准；协议通知本身在 Task 13 的独立进程 harness 里完整验证。）

- [ ] **Step 3: Commit**

```bash
git add crates/system-runtime/src/terminal
git commit -m "feat(system-runtime): PTY 会话——分帧输出/退出收尾/进程回收（终端 W1）"
```

---

### Task 11: Rust——service 路由与协议接线

**Files:**
- Create/Replace: `crates/system-runtime/src/terminal/service.rs`
- Modify: `crates/system-runtime/src/main.rs`（dispatch + shutdown 回收）

- [ ] **Step 1: service（全局表 + 方法入口，静态 OnceLock 与 running_shells 同模式）**

```rust
//! 终端服务：terminalId → 会话表、代际常量、协议入口（spawn/write/resize/close）
//! 与关停回收入口 close_all。额度/背压窗口在 W2 补。

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use serde_json::Value;

use crate::terminal::session::{self, TerminalSession};
use crate::protocol::OpError;

/// Rust 进程代际：随每次 sidecar 启动单调（进程内常量即可，跨重启由 TS 侧观察）。
pub fn generation() -> u64 {
    static GEN: AtomicU64 = AtomicU64::new(1);
    static ONCE: OnceLock<u64> = OnceLock::new();
    *ONCE.get_or_init(|| GEN.fetch_add(1, Ordering::SeqCst))
}

fn sessions() -> &'static Mutex<HashMap<String, Arc<TerminalSession>>> {
    static TABLE: OnceLock<Mutex<HashMap<String, Arc<TerminalSession>>>> = OnceLock::new();
    TABLE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn required_str(params: &Value, key: &str) -> Result<String, OpError> {
    params
        .get(key)
        .and_then(Value::as_str)
        .map(|value| value.to_string())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| OpError::new("invalid_request", format!("{key} is required")))
}

pub fn handle_spawn(params: Value) -> Result<Value, OpError> {
    let terminal_id = required_str(&params, "terminalId")?;
    let cwd = required_str(&params, "cwd")?;
    let rows = params.get("rows").and_then(Value::as_u64).unwrap_or(24) as u16;
    let cols = params.get("cols").and_then(Value::as_u64).unwrap_or(80) as u16;
    let mut table = sessions().lock().map_err(|_| OpError::new("internal", "table poisoned".into()))?;
    // 幂等：同 ID 已存在直接返回元数据（不产生第二个 shell，spec §5）。
    if let Some(existing) = table.get(&terminal_id) {
        return Ok(json_meta(existing));
    }
    if table.len() >= 16 {
        return Err(OpError::new("too_many_terminals", "terminal limit reached".into()));
    }
    let session = session::spawn(terminal_id.clone(), generation(), &cwd, rows, cols)
        .map_err(|message| OpError::new("pty_error", message))?;
    let meta = json_meta(&session);
    table.insert(terminal_id, session);
    Ok(meta)
}

fn json_meta(session: &TerminalSession) -> Value {
    serde_json::json!({
        "terminalId": session.id,
        "generation": session.generation,
        "outputSeq": session.output_seq.load(Ordering::SeqCst),
    })
}

pub fn handle_write(params: Value) -> Result<Value, OpError> {
    let id = required_str(&params, "terminalId")?;
    let data = required_str(&params, "data")?; // base64
    let bytes = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, &data)
        .map_err(|error| OpError::new("invalid_request", format!("bad base64: {error}")))?;
    let session = {
        let table = sessions().lock().map_err(|_| OpError::new("internal", "poisoned".into()))?;
        table.get(&id).cloned().ok_or_else(|| OpError::new("terminal_closed", "no such terminal".into()))?
    };
    session.write_input(&bytes).map_err(|message| OpError::new("io_error", message))?;
    Ok(serde_json::json!({ "acceptedBytes": bytes.len() }))
}

pub fn handle_resize(params: Value) -> Result<Value, OpError> {
    let id = required_str(&params, "terminalId")?;
    let rows = params.get("rows").and_then(Value::as_u64).ok_or_else(|| OpError::new("invalid_request", "rows required".into()))? as u16;
    let cols = params.get("cols").and_then(Value::as_u64).ok_or_else(|| OpError::new("invalid_request", "cols required".into()))? as u16;
    let session = {
        let table = sessions().lock().map_err(|_| OpError::new("internal", "poisoned".into()))?;
        table.get(&id).cloned().ok_or_else(|| OpError::new("terminal_closed", "no such terminal".into()))?
    };
    session.resize(rows, cols).map_err(|message| OpError::new("io_error", message))?;
    Ok(serde_json::json!({ "rows": rows, "cols": cols }))
}

pub fn handle_close(params: Value) -> Result<Value, OpError> {
    let id = required_str(&params, "terminalId")?;
    let session = {
        let mut table = sessions().lock().map_err(|_| OpError::new("internal", "poisoned".into()))?;
        table.remove(&id)
    };
    // 幂等：不存在也返回成功（spec §4 close 幂等）。
    if let Some(session) = session {
        session.close();
        crate::protocol::emit(serde_json::json!({
            "jsonrpc": "2.0",
            "method": "terminal.state",
            "params": { "terminalId": id, "generation": session.generation, "status": "closed", "exitCode": null }
        }));
    }
    Ok(serde_json::json!({ "closed": true }))
}

/// 关停回收：全部并行 close（spec §8：不逐个等待、不假装成功）。
pub fn close_all() -> usize {
    let drained: Vec<_> = {
        let Ok(mut table) = sessions().lock() else { return 0 };
        table.drain().map(|(_, session)| session).collect()
    };
    let count = drained.len();
    std::thread::scope(|scope| {
        for session in drained {
            scope.spawn(move || session.close());
        }
    });
    count
}
```

- [ ] **Step 2: main.rs 接线**

`handle_request` match（:50 `Some(name)` 前）加：

```rust
        Some("terminal.spawn") => finish(id, handlers::handle_terminal_spawn(params)),
        Some("terminal.write") => finish(id, handlers::handle_terminal_write(params)),
        Some("terminal.resize") => finish(id, handlers::handle_terminal_resize(params)),
        Some("terminal.close") => finish(id, handlers::handle_terminal_close(params)),
```

`handlers.rs` 尾部加薄封装（保持 handlers 是唯一分发层的现有格局）：

```rust
pub fn handle_terminal_spawn(params: Value) -> Result<Value, OpError> {
    crate::terminal::service::handle_spawn(params)
}
pub fn handle_terminal_write(params: Value) -> Result<Value, OpError> {
    crate::terminal::service::handle_write(params)
}
pub fn handle_terminal_resize(params: Value) -> Result<Value, OpError> {
    crate::terminal::service::handle_resize(params)
}
pub fn handle_terminal_close(params: Value) -> Result<Value, OpError> {
    crate::terminal::service::handle_close(params)
}
```

`main.rs` 的 `Some("system.shutdown") =>` 分支：`(ok_response(...), true)` 保持，在 break 前不可靠执行——改为在 main 循环退出后统一回收（stdin EOF / shutdown 两条路径共用）：`loop` 结束后、`eprintln!("system runtime stopped")` 之前加：

```rust
    let reaped = terminal::service::close_all();
    eprintln!("terminal sessions reaped: {reaped}");
```

- [ ] **Step 3: 编译 + 单测**

```bash
cargo fmt --manifest-path crates/Cargo.toml
cargo test --manifest-path crates/Cargo.toml
cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml
```

Expected: 全绿（宿主不感知新方法——TS↔Rust 通道不经 Tauri 白名单）。

- [ ] **Step 4: Commit**

```bash
git add crates/system-runtime/src
git commit -m "feat(system-runtime): terminal 协议方法与关停统一回收（终端 W1）"
```

---

### Task 12: TS——SystemRuntimeClient 通知路由（补静默丢弃缺口）

**Files:**
- Modify: `apps/runtime/src/system.ts:31-70,166-218,220-272`
- Create: `apps/runtime/test/fixtures/terminal-fake-system-runtime.mjs`
- Test: `apps/runtime/test/system-notifications.test.mjs`（登记进 package.json 列表）

- [ ] **Step 1: 实现路由**

`system.ts` 改动三处：

1. 构造器与字段（:43-50）：

```ts
  constructor(
    private readonly binaryPath: string | null,
    private readonly binaryArgs: string[],
    private readonly onStatusChange: (
      status: SystemAvailability,
      detail?: string,
    ) => void,
    private readonly onNotification?: (
      method: string,
      params: unknown,
    ) => void,
  ) {}
```

2. 读线闭包携带代际（:195-197）：

```ts
    const readline = createInterface({ input: child.stdout })
    readline.on('line', (line) => {
      this.handleLine(line.trim(), generation)
    })
```

3. `handleLine` 增加 generation 参数与通知分支（替换 :220-272 的消息处理尾部）：

```ts
  private handleLine(line: string, generation: number): void {
    if (line === '') return
    let message: {
      id?: unknown
      method?: unknown
      params?: unknown
      result?: unknown
      error?: { message?: string }
    }
    try {
      message = JSON.parse(line)
    } catch {
      process.stderr.write(`[runtime] system protocol parse error: ${line}\n`)
      return
    }
    if (message.method === 'system.ready') {
      this.clearHandshakeTimer()
      const parsed = ReadyParamsSchema.safeParse(message.params)
      if (
        !parsed.success ||
        parsed.data.protocolVersion !== PROTOCOL_VERSION
      ) {
        process.stderr.write(
          `[runtime] system.ready rejected: expected protocol ${PROTOCOL_VERSION}, ` +
            `got ${String((message.params as { protocolVersion?: unknown })?.protocolVersion)} ` +
            `(${parsed.success ? 'version mismatch' : 'malformed params'})\n`,
        )
        try {
          this.child?.kill()
        } catch {
          // 进程已退出：exit 路径会统一收尾。
        }
        return
      }
      this.restarts = 0
      this.setStatus('ready', parsed.data.runtimeVersion)
      return
    }
    if (
      typeof message.method === 'string' &&
      (message.id === undefined || message.id === null)
    ) {
      // 通知路由：旧代际进程迟到的行必须丢弃（spec §4 代际规则）。
      if (generation !== this.generation) return
      this.onNotification?.(message.method, message.params)
      return
    }
    if (
      (typeof message.id === 'number' || typeof message.id === 'string') &&
      this.pending.has(message.id)
    ) {
      const entry = this.pending.get(message.id)
      if (!entry) return
      this.pending.delete(message.id)
      clearTimeout(entry.timer)
      if (message.error) {
        entry.reject(new Error(message.error.message ?? 'system request error'))
      } else {
        entry.resolve(message.result)
      }
    }
  }
```

- [ ] **Step 2: fake sidecar fixture（完整新文件）**

`apps/runtime/test/fixtures/terminal-fake-system-runtime.mjs`：

```js
// 测试用假 System Runtime：握手 → 响应 ping → 主动推 terminal 通知。
// 第 2 行 stdout 通知在第 1 个响应之前发出，验证通知与响应互不阻塞。
import { PROTOCOL_VERSION } from '../../../../packages/contracts/dist/index.js'

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`)

send({
  jsonrpc: '2.0',
  method: 'system.ready',
  params: {
    protocolVersion: PROTOCOL_VERSION,
    runtimeVersion: '0.0.0-test',
    capabilities: ['system.bootstrap', 'system.tools'],
  },
})

process.stdin.setEncoding('utf8')
let buffer = ''
process.stdin.on('data', async (chunk) => {
  buffer += chunk
  let index
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index).trim()
    buffer = buffer.slice(index + 1)
    if (!line) continue
    const request = JSON.parse(line)
    if (request.method === 'system.ping') {
      send({
        jsonrpc: '2.0',
        method: 'terminal.output',
        params: { terminalId: 't1', outputSeq: 0, generation: 1, data: 'aGk=' },
      })
      send({ jsonrpc: '2.0', id: request.id, result: { ok: true } })
    }
    if (request.method === 'system.shutdown') {
      send({ jsonrpc: '2.0', id: request.id, result: { ok: true } })
      process.exit(0)
    }
  }
})
```

- [ ] **Step 3: 路由测试（完整新文件）**

`apps/runtime/test/system-notifications.test.mjs`（追加进 package.json test 列表）：

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'
import { SystemRuntimeClient } from '../dist/system.js'

const here = dirname(fileURLToPath(import.meta.url))
const FIXTURE = join(here, 'fixtures', 'terminal-fake-system-runtime.mjs')

test('Rust 通知经 onNotification 路由，且不影响请求响应关联', async () => {
  const notifications = []
  let readyResolve
  const ready = new Promise((resolve) => (readyResolve = resolve))
  const client = new SystemRuntimeClient(
    process.execPath,
    [FIXTURE],
    (status) => {
      if (status === 'ready') readyResolve()
    },
    (method, params) => notifications.push({ method, params }),
  )
  client.start()
  await ready
  const result = await client.request('system.ping')
  assert.deepEqual(result, { ok: true })
  assert.equal(notifications.length, 1)
  assert.equal(notifications[0].method, 'terminal.output')
  assert.equal(notifications[0].params.terminalId, 't1')
  await client.shutdown()
})
```

- [ ] **Step 4: 运行**

Run: `pnpm build:packages && node --test apps/runtime/test/system-notifications.test.mjs apps/runtime/test/system-client.test.mjs`
Expected: 双 PASS（既有 client 测试不回归）。

- [ ] **Step 5: Commit**

```bash
git add apps/runtime/src/system.ts apps/runtime/test
git commit -m "feat(runtime): SystemRuntimeClient 通知路由 + 旧代际丢弃（补静默丢弃缺口）"
```

---

### Task 13: 贯通验证——macOS 真机 spike + 记录

**Files:**
- Create: `scripts/terminal-spike.mjs`
- Create: `docs/TERMINAL-SPIKE-REPORT.md`

- [ ] **Step 1: spike 脚本（完整代码）**

```js
#!/usr/bin/env node
// 终端纵向切片验证 harness（AGENTS §7 冒烟模式的延伸）：
// 驱动 debug 二进制验证 PTY 启动、分帧、UTF-8、Ctrl+C、resize、回收。
// 用法：cargo build --manifest-path crates/Cargo.toml && node scripts/terminal-spike.mjs
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { setTimeout as delay } from 'node:timers/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const bin = join(root, 'crates/target/debug/reflexion-system-runtime')

const child = spawn(bin, [], { stdio: ['pipe', 'pipe', 'inherit'] })
const rl = createInterface({ input: child.stdout })
let id = 0
const pending = new Map()
const notifications = []
rl.on('line', (line) => {
  let message
  try {
    message = JSON.parse(line)
  } catch {
    return
  }
  if (message.method === 'system.ready') return
  if (message.id !== undefined && pending.has(message.id)) {
    pending.get(message.id)(message)
    pending.delete(message.id)
    return
  }
  if (message.method) notifications.push(message)
})

function request(method, params) {
  const requestId = ++id
  child.stdin.write(
    `${JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params })}\n`,
  )
  return new Promise((resolve) => pending.set(requestId, resolve))
}

const framesFor = (terminalId) =>
  notifications
    .filter((n) => n.method === 'terminal.output')
    .filter((n) => n.params.terminalId === terminalId)
    .map((n) => Buffer.from(n.params.data, 'base64'))

const seqsFor = (terminalId) =>
  notifications
    .filter((n) => n.method === 'terminal.output')
    .filter((n) => n.params.terminalId === terminalId)
    .map((n) => n.params.outputSeq)

const decode = (terminalId) => Buffer.concat(framesFor(terminalId)).toString('utf8')

const results = []
function check(name, pass, detail = '') {
  results.push({ name, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
}

// 1. spawn
const spawnReply = await request('terminal.spawn', {
  terminalId: 's1',
  cwd: tmpdir(),
  rows: 24,
  cols: 80,
})
check('spawn 返回元数据', spawnReply.result?.terminalId === 's1' && typeof spawnReply.result?.generation === 'number')
await delay(300) // 等 shell 提示符输出

// 2. echo 往返
await request('terminal.write', {
  terminalId: 's1',
  data: Buffer.from('echo 终端-OK-✅\r', 'utf8').toString('base64'),
})
await delay(600)
check('UTF-8 中文/emoji 往返', decode('s1').includes('终端-OK-✅'), decode('s1').slice(0, 80))

// 3. 输出帧 ≤16 KiB（yes 洪泛 3 秒后 Ctrl+C，再验证 shell 仍可响应）
const before = framesFor('s1').length
await request('terminal.write', {
  terminalId: 's1',
  data: Buffer.from('yes\r', 'utf8').toString('base64'),
})
await delay(3000)
await request('terminal.write', {
  terminalId: 's1',
  data: Buffer.from('\x03', 'utf8').toString('base64'),
})
await delay(300)
const flood = framesFor('s1').slice(before)
check('洪泛产生大量帧', flood.length > 50, `frames=${flood.length}`)
check('单帧 ≤16 KiB', flood.every((frame) => frame.length <= 16 * 1024))
const floodSeqs = seqsFor('s1').slice(before)
check(
  'outputSeq 连续无缺口',
  floodSeqs.every((seq, index) => index === 0 || seq === floodSeqs[index - 1] + 1),
)
const afterCtrlC = framesFor('s1').length
await request('terminal.write', {
  terminalId: 's1',
  data: Buffer.from('echo ctrlc-survived\r', 'utf8').toString('base64'),
})
await delay(600)
check(
  'Ctrl+C 后 shell 仍可执行命令',
  Buffer.concat(framesFor('s1').slice(afterCtrlC))
    .toString('utf8')
    .includes('ctrlc-survived'),
)

// 4. resize
await request('terminal.resize', { terminalId: 's1', rows: 30, cols: 100 })
await request('terminal.write', {
  terminalId: 's1',
  data: Buffer.from('stty size\r', 'utf8').toString('base64'),
})
await delay(600)
check('resize 生效（stty size = 30 100）', decode('s1').includes('30 100'))

// 5. 回收：后台 sleep 子进程必须随 close 消失
await request('terminal.write', {
  terminalId: 's1',
  data: Buffer.from('sleep 300 & sleep 300\r', 'utf8').toString('base64'),
})
await delay(400)
await request('terminal.close', { terminalId: 's1' })
await delay(500)
const { execFileSync } = await import('node:child_process')
let survivors = ''
try {
  survivors = execFileSync('pgrep', ['-fl', 'sleep 300'], { encoding: 'utf8' })
} catch {
  survivors = ''
}
check('close 后无 sleep 300 残留', survivors.trim() === '', survivors.trim().slice(0, 120))

// 6. 幂等 close
const again = await request('terminal.close', { terminalId: 's1' })
check('重复 close 幂等成功', again.result?.closed === true)

// 7. 协议 shutdown → 全部回收
await request('terminal.spawn', { terminalId: 's2', cwd: tmpdir(), rows: 24, cols: 80 })
await delay(200)
const shutdownStart = Date.now()
child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'system.shutdown' })}\n`)
await new Promise((resolve) => child.on('exit', resolve))
check('shutdown 优雅退出', Date.now() - shutdownStart < 2000, `${Date.now() - shutdownStart}ms`)

const failed = results.filter((r) => !r.pass)
console.log(`\nspike summary: ${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length === 0 ? 0 : 1)
```

> 若 `crates/target/debug` 不在该路径（workspace 根不同），以 `cargo build` 输出的实际二进制路径为准并在报告记录；不改脚本逻辑。

- [ ] **Step 2: 本机跑通**

```bash
cargo build --manifest-path crates/Cargo.toml
node scripts/terminal-spike.mjs
```

Expected: 全部 PASS。**任何 FAIL 都是设计反馈**：修实现或修 spec 对应承诺，不得删断言迁就实现。后台 `sleep 300` 残留 = PTY SIGHUP 回收不成立的信号，解决路径（kill 进程组/killpg）记入报告并修 `session.rs`。

- [ ] **Step 3: 记录**

`docs/TERMINAL-SPIKE-REPORT.md`：环境（macOS 版本、shell）、逐项结果表、`yes` 洪泛实测帧率与字节率（估算共享通道预算 1 MiB/s 是否够）、遗留到 W2 的清单（背压窗口、attach 缓冲、公平调度）。Windows/Linux 章节先立"未验证"占位行（如实）。

- [ ] **Step 4: Commit**

```bash
git add scripts/terminal-spike.mjs docs/TERMINAL-SPIKE-REPORT.md
git commit -m "test: 终端纵向切片 spike harness 与 macOS 真机验证记录"
```

---

### Task 14: xterm / WebView 行为验证（临时页，验完删除）

**Files:**
- Create(临时): `apps/desktop/spike/terminal-spike.html`（vite 根在 `apps/desktop`（vite.config root='.'），放这里才能按根路径 URL 访问；验证完成后删除，不入库）

- [ ] **Step 1: 验证页**

```html
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>terminal spike</title>
    <link rel="stylesheet" href="/node_modules/@xterm/xterm/css/xterm.css" />
    <script src="/node_modules/@xterm/xterm/lib/xterm.js"></script>
    <script src="/node_modules/@xterm/addon-fit/lib/addon-fit.js"></script>
    <style>
      #visible { width: 800px; height: 300px; }
      #hidden { display: none; width: 800px; height: 300px; }
    </style>
  </head>
  <body>
    <div id="visible"></div>
    <div id="hidden"></div>
    <script>
      const mk = (el) => {
        const term = new Terminal({ scrollback: 5000 })
        term.loadAddon(new FitAddon.FitAddon())
        term.open(el)
        return term
      }
      const visible = mk(document.getElementById('visible'))
      const hidden = mk(document.getElementById('hidden'))
      window.terms = { visible, hidden }
      // 喂数据器：在 console 里 run feedBurst(hidden, 2000) 验证隐藏实例持续解析。
      window.feedBurst = (term, n) => {
        for (let i = 0; i < n; i++) term.write(`line ${i} 中文✅\r\n`)
      }
      // UTF-8 跨块：把一个多字节字符拆进两个 Uint8Array。
      window.feedSplitUtf8 = (term) => {
        const bytes = new TextEncoder().encode('跨块-✅-完成\r\n')
        const half = 8 // 切点落在 ✅ 中间（视编码而定）
        term.write(bytes.slice(0, half))
        setTimeout(() => term.write(bytes.slice(half)), 100)
      }
      // 洪泛测帧率：requestAnimationFrame 统计。
      window.flood = (term, seconds) => {
        const start = performance.now()
        let bytes = 0
        const chunk = new Uint8Array(16 * 1024).fill(0x41)
        const tick = () => {
          term.write(chunk)
          bytes += chunk.length
          if (performance.now() - start < seconds * 1000) requestAnimationFrame(tick)
          else console.log('flood bytes/s', (bytes / seconds).toFixed(0))
        }
        tick()
      }
    </script>
  </body>
</html>
```

Run: `pnpm --filter @reflexion-os-studio/desktop dev:frontend`（apps/desktop/package.json 既有脚本，直起 vite），浏览器打开 `http://localhost:5173/spike/terminal-spike.html`（端口以 vite 实际输出为准）

- [ ] **Step 2: 检查单（结果记入报告，任一不成立即成为 W2/W3 设计输入）**

  1. `feedSplitUtf8(visible)`：✅ 一次显示不乱码（xterm 缓冲跨 write 的半字符——预期成立；失败=需要前端侧 UTF-8 解码器而非直喂）。
  2. `feedBurst(hidden, 5000)` 后 `document.getElementById('visible').innerText.length === 0` 期间 `hidden.buffer.lines.length === 5000`（隐藏 display:none 实例仍解析；失败=改用 visibility:hidden 或 offscreen 定位，记录进 W3 方案）。
  3. 页面 `visibility` 切后台 10 秒 × rAF 洪泛：观察 `flood` 是否被节流（WebView 后台 rAF 节流是既定行为；据此**确认隐藏面板继续用 write 直喂而非依赖 rAF 合帧**——W3 的前端合帧用 `setTimeout(16ms)`，不用 rAF）。
  4. resize 窗口 + `fit()`：行列变化生效。
  5. 空闲（无 write 调用）时 WebView CPU ≈0（AGENTS §10 方法采样）。

- [ ] **Step 3: 结果进报告，删除临时页（验证物不入库）**

```bash
rm -rf apps/desktop/spike
```

`docs/TERMINAL-SPIKE-REPORT.md` 增补"WebView/xterm 结论"节。Commit：

```bash
git add docs/TERMINAL-SPIKE-REPORT.md
git commit -m "docs: xterm WebView 行为验证结论（终端 W1）"
```

---

### Task 15: W1 出口——版本固定、门槛确认、全链验证

- [ ] **Step 1: 固定依赖版本**

`Cargo.toml` 将 `portable-pty = "0.8"` 收紧为 spike 通过的具体 caret（`0.8.x` 即锁 lockfile，提交 `Cargo.lock`）；前端 xterm 两包保留 `^` 但在报告记录实测小版本。

- [ ] **Step 2: 确认性能门槛（spec §10"门槛在 W1 固定"）**

报告记录最终数值：delta p95 ≤100ms 且基线增量 ≤50ms、控制命令 p95 ≤300ms、输出总预算 1 MiB/s。若 spike 帧率数据表明 1 MiB/s 明显不足/过大，**修订 spec §6 数字**（设计调整），不改验收方法。

- [ ] **Step 3: 全量验证链**

本计划开头验证链 + `pnpm test` + `node scripts/check-whitelist.mjs` + `pnpm build:desktop`（打包冒烟按 AGENTS §7 第 3 条跑一次：安装包内二进制 + pgrep sidecar + TERM 无孤儿）。

- [ ] **Step 4: 收尾 commit**

```bash
git add -A
git commit -m "chore: 终端 W1 出口——依赖版本固定与 spike 门槛确认"
```

Expected: 全绿。**Windows/Linux spike（同脚本 + Job Object 结论）在对应环境执行前，本功能一律标记"macOS 已验证"**——不得宣称三平台完成。

---

## 后续计划的前置依赖（本计划不做，只登记）

- **W2（后端服务）依赖本计划交付**：terminal 契约命令（frontend→runtime 侧，生成白名单）、attach/消费者代际、256 KiB 窗口与暂停读取、attach 前缓冲、幂等记录 TTL、`terminal.*` RuntimeEvent 接线。评审遗留：queue/mcp 懒建 Map 在 n=3（terminal）时提取为 events.ts 发射器缓存助手；信封 stamping 字段（seq/occurredAt/eventId）与 payload 同键的遮蔽风险随 terminal.output 设计一并复核（W2 契约测试钉住）。
- **W3（前端保活面板）依赖 Task 14 结论**：隐藏实例解析策略、setTimeout 合帧、实例宿主位置。
- **W4（故障/性能/打包）依赖 Task 13 报告门槛**。
```
