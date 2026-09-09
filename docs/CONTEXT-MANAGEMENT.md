# Context Management

Context 是 Agent、Memory、Skill、Tool 和模型之间的显式数据边界，不允许通过全局变量隐式共享。

Context Pipeline：

```text
任务输入 → Session facts → Project memory → Skill instructions → Tool summaries → Token budget → Model request
```

Working Context 只属于一个 Run；Session Context 属于会话；Project Context 属于 Workspace；子 Agent 默认获得经过筛选的任务 Context，而不是完整父对话。Context Envelope 记录来源、范围、敏感级别和 token 预算。压缩时优先保留用户目标、约束、决定和未完成步骤，原始工具输出通过引用按需加载。

Context 必须支持截断、摘要、恢复和审计；敏感信息不因上下文拼接自动扩大可见范围。

## Atomic Context Frames 与增量 Checkpoint（2026-09，Context Engine V2）

- **Atomic Frames**：canonical 历史重建为 Provider 无关的原子帧（`ContextFrame`），assistant tool calls 与其全部 tool results 绑定为不可拆分的 `ToolRoundFrame`。所有压缩、最近窗口保留、token 估算与兜底裁剪只处理 Frame，杜绝按消息下标切割造成的悬空/重复 tool result。
- **请求前校验**：每次发 Provider 前执行 `validateModelMessages`（system 位置、call id 全局唯一、result 恰好一次且相邻、无悬空引用）；本地数据损坏以 `FrameError` 失败为 internal，不猜测伪造 tool result。
- **增量 Checkpoint**（`context_checkpoints` 表，v20）：只覆盖终态化的稳定历史。source hash（稳定 Frame 内容 + summary schema version）命中即复用；watermark 之后的新增 Frame 只做一次增量摘要（输入 = 旧摘要 + 新增帧）；相同 sessionId+hash 并发 single-flight；同 hash 失败缓存，本进程内不重试，直接走确定性裁剪。Checkpoint 是可失效、可重建的派生缓存，canonical tables 仍是唯一事实源。
- **结构化摘要**：`ContextCheckpointSummarySchema`（zod）限定 goal/constraints/decisions/completed/pending/toolFacts/knownErrors 的长度与数量上限，secret 行过滤后落库。
- **过期描述删除**：旧"Run 内不再重算摘要 / 按消息数量切割"的描述已失效——同 source hash 摘要调用严格不超过一次（Run 内与跨 Run 均成立），切割以 Frame 为原子。
