# 设计：LLM 自动会话标题 + 最后一条用户消息编辑重发

日期：2026-09-19
状态：已实施（2026-09-24）
前置：Phase 1A Chat Core（`message.send` / `run.retry` / `session.rename` / superseded 过滤）已上线

## 1. 背景与问题

当前会话标题由 [`apps/runtime/src/agent/title.ts`](workspace:///apps/runtime/src/agent/title.ts) 的 `deriveSessionTitle` 在 [`ChatAgent.startSend`](workspace:///apps/runtime/src/agent/index.ts) 里同步写入：仅当标题仍是 `DEFAULT_SESSION_TITLE`（`新对话`）时，把首条用户消息 trim / 折叠空白后截断到 24 字。没有 LLM 总结。

写入走 `store.sessions.rename`（只改 `title`、不动 `updated_at`），**不发会话更新事件**。前端 [`useAppBootstrap`](workspace:///apps/desktop/frontend/hooks/useAppBootstrap.ts) 的刷新集只在 run 作用域终态事件里顺带刷侧栏，注释写「Run 结束后标题可能已被自动命名」。若标题在 Run 结束后才被 LLM 改写，侧栏会一直显示旧标题。

最后一条用户消息不能编辑。[`ChatView`](workspace:///apps/desktop/frontend/features/chat/ChatView.tsx) 用户气泡只有 `CopyButton`。[`QueueBar`](workspace:///apps/desktop/frontend/features/chat/QueueBar.tsx) 已有排队项行内编辑，不能覆盖已落库的用户消息。[`run.retry`](workspace:///apps/runtime/src/agent/index.ts) 是「同文案重跑 assistant」：不改 user、不新建 user，只把原 Run 的 **assistant** 标 `superseded`。

用户要求：

1. 新开会话用 LLM 生成标题，不超过 30 字；落库方式与现有会话标题一致。
2. 最后一条用户消息可编辑并重发；产品语义对齐普通发送、与 retry 区分。
3. 先设计再实现。

## 2. 目标与非目标

**目标**

- 默认标题会话在首条 `startSend` 成功后：先用现有 24 字派生存占位，再异步用当前 Provider 调一次 LLM，生成 ≤30 字中文标题并覆盖占位；失败回退占位，不拦对话。
- 标题保存仍走 `store.sessions.rename`。新增 `session.updated` 事件，侧栏收到后刷新列表。
- 用户已手动改过标题则不再覆盖。
- 仅最后一条可见 user 消息可编辑重发：提交后以新内容作为新一轮发送；被替换的旧轮次（旧 user + 该 Run 的 assistant）标 `superseded`，**不物理删除**。
- 前端用户气泡补编辑入口（`PencilIcon` + 行内 textarea，对齐 QueueBar：Enter 提交 / Esc 取消）。

**非目标**

- 不给任意历史 user 做分支编辑（ChatGPT 式 fork）；MVP 只允许最后一条。
- 不把编辑重发做成 `run.retry` 的参数变体。
- 不新增独立「轻量补全」Provider 入口；标题 LLM 复用现有 `streamChatCompletion`。
- 不改会话列表排序（rename 仍不动 `updated_at`）。
- 不在本阶段做标题流式展示、多语言检测或用户可配置的标题 prompt。

## 3. 现有锚点（实现必须复用）

| 能力         | 位置                                                                                       | 要点                                                |
| ------------ | ------------------------------------------------------------------------------------------ | --------------------------------------------------- |
| 默认标题常量 | [`apps/runtime/src/store/shared.ts`](workspace:///apps/runtime/src/store/shared.ts)        | `DEFAULT_SESSION_TITLE = '新对话'`                  |
| 截断派生     | [`apps/runtime/src/agent/title.ts`](workspace:///apps/runtime/src/agent/title.ts)          | 24 字 + 省略号；空内容返回 null                     |
| 发送时写入   | [`ChatAgent.startSend`](workspace:///apps/runtime/src/agent/index.ts)                      | 仅 `session.title === DEFAULT_SESSION_TITLE`        |
| 重命名落库   | [`SessionStore.rename`](workspace:///apps/runtime/src/store/sessions.ts)                   | 只改 title                                          |
| 命令         | [`session.rename`](workspace:///apps/runtime/src/handlers.ts)                              | 无事件                                              |
| 压缩 LLM     | [`summarizeFrames`](workspace:///apps/runtime/src/agent/context.ts)                        | 动态/`streamChatCompletion`，失败降级               |
| retry        | `startRetry` + [`replaceWithRetry`](workspace:///apps/runtime/src/store/runs.ts)           | 新 Run、`retryOfRunId`；**只 superseded assistant** |
| 消息过滤     | [`MessageStore.listBySession`](workspace:///apps/runtime/src/store/messages.ts)            | 默认 `status <> 'superseded'`                       |
| 上下文重建   | [`reconstructSessionFramesWithIds`](workspace:///apps/runtime/src/agent/context-frames.ts) | 走 `listBySession()`，故 superseded 不进模型        |
| UI 隐藏 Run  | [`ChatView.visibleRuns`](workspace:///apps/desktop/frontend/features/chat/ChatView.tsx)    | `supersededByRunId === null`                        |
| 队列编辑     | [`QueueBar`](workspace:///apps/desktop/frontend/features/chat/QueueBar.tsx)                | 行内 textarea；Enter / Esc                          |
| 图标         | [`PencilIcon`](workspace:///apps/desktop/frontend/ui/icons.tsx)                            | SessionRow 已用                                     |

## 4. 自动标题

### 4.1 时机

1. `startSend` 创建 user 消息后，若当时 `session.title === DEFAULT_SESSION_TITLE`：
   - 同步：`deriveSessionTitle(content)` 非空则 `sessions.rename`（保持现有「侧栏立刻有字」的体验）。记下 `placeholderTitle`。
   - 异步：不阻塞 `startSend` 返回、不阻塞 Run。用本次已解析的 Provider 配置发起标题补全。
2. 仅此一次自动升级路径。之后即使用户把标题改回 `新对话`，也不再自动生成（避免手动命名被抢）。实现用进程内 `Set<sessionId>` 或「本 Run 启动时标题曾是默认值」的闭包标志，不落盘。
3. 队列出队走同一 `startSend`：只有仍是默认标题的会话才会触发（通常是首条）。

### 4.2 LLM 调用

- 复用 [`streamChatCompletion`](workspace:///apps/runtime/src/provider.ts)（与压缩器相同），`onDelta` 丢弃。
- 独立 prompt 文件 [`apps/runtime/src/agent/prompts/title.ts`](workspace:///apps/runtime/src/agent/prompts/title.ts)，经 `prompts/index.ts` 导出。禁止在 `title.ts` / `index.ts` 内联长 prompt。
- 输入：首条用户消息正文，截断到约 500 字（避免标题请求比对话还贵）。
- 采样：`temperature` 0 或沿用 Provider 默认的偏低值；`maxTokens` 小（建议 64）；`timeoutMs` 短于对话（建议 15s）。
- 失败 / 取消 / 空输出：保留占位标题，stderr 打一行，不发错误给 UI。
- Abort：会话删除或 Runtime shutdown 时 abort；不绑到对话 Run 的 AbortSignal（停回复不应取消标题）。

建议 system prompt 口径：

> 根据用户的第一条消息，生成一个简短的中文会话标题。不超过 30 个字（汉字/字母/数字均计 1）。不要引号、不要句号、不要解释、不要换行。直接输出标题。

### 4.3 清洗与回退

1. trim，去掉包裹引号，折叠内部空白为单空格，去掉末尾标点。
2. 空串 → 放弃，保留占位。
3. 长度 > 30 → 截断到 30（**不再加省略号**，标题不是预览）。
4. 写回前重新 `sessions.get`：仅当当前标题仍等于 `placeholderTitle` 或仍为 `新对话` 时才 `rename`。用户已在侧栏改名则跳过。
5. 成功 rename 后发 `session.updated`。

派生占位仍用现有 24 字规则，与 LLM 的 30 字上限刻意不同：占位是截断预览，LLM 标题是完整短句。

### 4.4 事件与前端刷新

新增事件（协议 1.2 加法，不升主版本）：

```ts
RuntimeEventEnvelopeSchema.extend({
  type: z.literal('session.updated'),
  scope: z.literal('session'),
  sessionId: z.string().min(1),
  session: SessionSchema,
})
```

- 发射器：session 作用域长生命周期实例（对齐 `QueueService` 的 `EmitterRegistry`），禁止每次 emit 新建。
- `session.rename` handler 成功后同样 emit，方便多窗口；当前单窗口手动改名已靠命令返回刷新，事件是补齐而不是替换。
- [`useAppBootstrap`](workspace:///apps/desktop/frontend/hooks/useAppBootstrap.ts) **不能**只把类型加进 `EVENT_TYPES_TRIGGERING_REFRESH`：现有分支要求 `event.scope === 'run'` 且使用 `event.runId`。应单独处理 `session.updated`：刷新独立会话列表 + 当前项目会话列表；若 `sessionId === activeSessionId` 则顺带 `refreshSessionData`。不要走 run 结算逻辑。

### 4.5 三平台

标题生成是纯 TS Runtime + Provider HTTP，无 OS 差异。密钥仍只经 `secrets.json` / `apiKey` 进入 `streamChatCompletion`，不得写入事件、日志或错误详情。

## 5. 编辑重发

### 5.1 会不会把脏记忆带进下一轮？

会——如果旧 user 仍保持 `completed`。

证据：

- [`listBySession`](workspace:///apps/runtime/src/store/messages.ts) 默认只排除 `superseded`。
- [`reconstructSessionFramesWithIds`](workspace:///apps/runtime/src/agent/context-frames.ts) 对 user **不看 status**，只要还在列表里且文本非空就推进模型。
- Checkpoint 的 source hash 含 user frame 正文；旧句若仍在稳定窗口，摘要会记住改前意图。

因此「新建一条 user、旧 user 原样保留」作为 canonical 历史可以，但 **旧 user 必须退出默认列表**。否则模型会看到：

```text
user: 请把按钮改成红色     ← 脏记忆
assistant: 已改为红色
user: 请把按钮改成蓝色     ← 新意图
```

### 5.2 为什么不物理删除

- 项目已有 `superseded` 语义（retry 用它藏旧 assistant）；上下文 / `session.get` / UI 都认这一档。
- 物理删除会拆审计链、外键（`run_id`、tool_calls、run_events）和未来 mem0 检索对象（原始事实层承诺不删）。
- 删除成功、发送失败会留下「最后一条 user 消失」的窗口；superseded + 新发送可以放在同一事务里。

**结论：逻辑替换，不是 DELETE。** UI 与模型都只看见新 user；DB 仍留旧行。

这与 retry 的差异必须写进实现，避免误复用 `markSupersededByRun`：

|                 | `run.retry`                              | 编辑重发                                         |
| --------------- | ---------------------------------------- | ------------------------------------------------ |
| 用户文案        | 不变                                     | 变了                                             |
| 旧 user         | **保持 completed**（同文案，不是脏记忆） | **标 superseded**（旧文案是脏记忆）              |
| 旧 assistant    | superseded                               | superseded                                       |
| 新 user 消息    | 不建                                     | 新建（走发送路径）                               |
| 新 Run          | `retryOfRunId` 指向旧 Run                | 普通新 Run，**不**填 `retryOfRunId`              |
| Provider / 权限 | 沿用原 Run；权限回落 `workspace-read`    | 沿用当前 Composer 快照（与 `message.send` 相同） |
| 技能            | 沿用原 `skillId`                         | 按新内容重新解析斜杠 / 显式 skillId              |

`retryOfRunId` 留给「同一句重跑」。编辑重发是新的一轮发送，只是先把上一轮从可见历史拿掉。

### 5.3 命令

新增 `message.edit_resend`，不要塞进 `message.send` 或 `run.retry`。

```ts
params: {
  requestId,
  sessionId,
  messageId,          // 被替换的 user 消息
  content,            // 新正文，min 1
  providerId?, model?,
  temperature?, maxTokens?,
  permissionPreset?,
  skillId?,
}
result: 与 message.send 空闲成功时相同
  { queued: false, messageId, runId, queueId: null, position: null }
```

编辑重发 **拒绝入队**：目标是替换最后一轮，不是在忙碌时再塞一条。会话有进行中的 Run → `invalid_request`（「请先停止当前回复」）。前端在 `runActive` 时不展示编辑按钮。

排队中的消息继续只走 QueueBar，不走本命令。

### 5.4 Runtime 流程（单事务）

校验：

1. 会话存在。
2. `requireIdleSession`。
3. `messageId` 存在、同会话、`role === 'user'`、`status !== 'superseded'`。
4. 它是默认列表里**最后一条** user；否则拒绝（防止误改历史）。
5. 新 `content` trim 后非空；技能与 Provider 校验同 `send`（先校验再写库）。

事务内：

1. 若该 user 有 `runId`：`runs.markSuperseded(oldRunId, newRunId)` 不能在 create 之前做——顺序为：先 `runs.create` 得到 `newRun`，再 `markSuperseded(oldRunId, newRun.id)`，再把旧 Run 上 **user + assistant** 全部标 `superseded`。
2. 新方法（名称建议 `markSupersededRound(runId)`）：`UPDATE messages SET status = 'superseded' WHERE run_id = ?`（不限制 role）。**禁止**改现有 `markSupersededByRun` 的 assistant-only 语义，retry 测试会红。
3. 其后走与 `startSend` 相同的创建：新 user（`completed`）+ pending assistant + `run.started` / 两条 `message.created` + `launch`。
4. `sessions.touch`。
5. 自动标题：若事务前标题仍是默认值，沿用 §4（编辑首条且尚未 LLM 升级时仍可生成）。已有非默认标题不改。

事务外：`launch` 后台跑。返回新 `messageId` / `runId`。

若旧 user 的 `runId` 为空（防御）：仍把它自身标 `superseded`，再 `startSend`。

Checkpoint：旧 user 被 listBySession 排除后，source hash 变化，旧摘要自动失效并按需重建，不必手工清 checkpoint。

### 5.5 前端

- 仅当该 user 是可见列表最后一条、且会话无进行中 Run 时，在 `.user-actions` 显示编辑按钮（`PencilIcon`，与复制并排）。
- 交互对齐 QueueBar / SessionRow：行内 textarea、Enter 提交（Shift+Enter 换行）、Esc 取消；可保留保存/取消按钮。
- 提交走 `api/chat.ts` 新方法 → `message.edit_resend`，不要先改本地再 `sendMessage`（两轮请求会竞态）。
- 成功后现有 `message.created` / 流式事件足够刷新 transcript；superseded 行随下一次 `session.get` 消失（run 终态刷新路径已有）。若希望提交后立刻消失，可乐观地从本地 `sessionData.messages` 去掉旧 id，但必须以服务端快照为准做对账。
- 不把编辑按钮画在 assistant / RunBlock 的 retry 旁边，避免与「重试」混淆。retry 仍只出现在最后一条可重试 Run 上。

### 5.6 与主流产品的对照（MVP 取舍）

- ChatGPT / Claude：可改任意 user，并隐藏该条之后的回复；有的保留分支。我们只做「最后一条」，没有分支切换 UI。
- Cursor：编辑后重发当前 round。我们同此，但存储用 superseded 而不是改写原文。
- 视觉结果应对齐主流：时间线上仍是一条 user 气泡（新正文）+ 新的 assistant，看不到改前那句。

## 6. 协议与文档

- `packages/contracts/src/events.ts`：加 `session.updated`。
- `packages/contracts/src/commands.ts`：加 `message.edit_resend`；`runtimeMethodNames` 自动纳入。
- Tauri 白名单：随 contracts 的 command 名同步（现有「新增业务命令需更新 Rust 白名单」纪律）。
- `PROTOCOL_VERSION` 保持 `'1.2'`（加法变更）。
- [`docs/EVENT-PROTOCOL.md`](workspace:///docs/EVENT-PROTOCOL.md)、[`docs/MVP-PROTOCOL.md`](workspace:///docs/MVP-PROTOCOL.md)：事件清单补 `session.updated`，命令清单补 `message.edit_resend`。
- prompt 新文件走 `apps/runtime/src/agent/prompts/`，禁止内联。

## 7. 实现步骤

1. 契约：事件 + 命令 schema；前端 runtime-client 随包导出。
2. Store：`markSupersededRound`；单测钉住「retry 仍只藏 assistant、edit-resend 藏整轮」。
3. Agent：`generateSessionTitle`（`title.ts` 扩展清洗 + LLM，派生函数保留）；`startSend` 接异步标题；`startEditResend`；session emitter。
4. Handler：`session.rename` emit；注册 `message.edit_resend`。
5. 前端：bootstrap 听 `session.updated`；ChatView 编辑 UI；`useSessionActions` / `api/chat.ts`。
6. 文档：协议两页 + 本 spec 状态改为已实施（实施后补差异）。

## 8. 测试要点

**标题**

- 默认标题：先占位 24 字，LLM 成功后变为清洗过的 ≤30 字，并出现 `session.updated`。
- LLM 失败 / 超时：保留占位，对话不受影响。
- 用户在 LLM 返回前 rename：不覆盖。
- 非默认标题的后续 `startSend`：不调 LLM。

**编辑重发**

- 最后一条 user：旧 user+assistant 为 `superseded`，默认 `listBySession` 与上下文重建均不含旧正文；新 user 在列。
- `session.get` 给前端的 messages 不含旧 user（与默认 list 一致）。
- 旧 Run `supersededByRunId` 指向新 Run；UI `visibleRuns` 不显示旧 Run。
- 非最后一条 / 非 user / 已 superseded / 会话忙碌：`invalid_request`。
- retry 回归：重试后旧 user 仍在、旧 assistant 消失。
- 编辑重发的新 Run **没有** `retryOfRunId`。

**前端**

- 仅最后一条 user 且非忙碌显示铅笔；提交后气泡正文换成新内容。
- 自动标题完成后侧栏不待 Run 结束也能更新（用 `session.updated`，不要等 `run.completed`）。

## 9. 风险

- 标题多一次 Provider 调用：短超时 + 失败静默；费用可接受。
- 编辑后 Checkpoint 失效重摘要：预期行为，避免脏记忆留在摘要里。
- 误把 user 标 superseded 接到 retry：用独立 store 方法隔离。

## 10. 决策记录

- **脏记忆**：旧 user 必须 `superseded`，不能以 `completed` 留在默认历史上。
- **不物理删除**：审计与现有过滤机制优先；UI/模型都看不见即足够。
- **不复用 retry**：retry 保留旧 user 是正确的（文案没变）；编辑重发文案变了，必须换 user 行。
- **标题**：占位派生 + 异步 LLM 覆盖；事件补齐侧栏。
