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
- **增量 Checkpoint**（`context_checkpoints` 表，v20）：只覆盖终态化的稳定历史。source hash（稳定 Frame 内容 + summary schema version）命中即复用；watermark 之后的新增 Frame 做一次分批增量摘要（输入 = 旧摘要 + 新增帧）；相同 sessionId+hash 并发 single-flight；同 hash 失败短暂冷却，保留旧摘要并走确定性裁剪，冷却后允许重试。Checkpoint 是可失效、可重建的派生缓存，canonical tables 仍是唯一事实源。
- **结构化摘要**：`ContextCheckpointSummarySchema`（zod）限定 goal/constraints/decisions/completed/pending/toolFacts/knownErrors 的长度与数量上限，secret 行过滤后落库。
- **过期描述删除**：旧"Run 内不再重算摘要 / 按消息数量切割"的描述已失效——同 source hash 的并发摘要合并，成功结果复用；失败结果冷却后可重试，切割以 Frame 为原子。

## 摘要正确性修复（2026-10-19）

参考 ZCode 的协议统一调用、摘要结果校验和有界重试，保留既有 Atomic Frames 与增量 checkpoint。

- 摘要按当前供应商 API 格式调用，显式限制输出、超时和重试；仅接受正常完成、无工具调用且 schema 有效、清理后非空的结构化摘要。
- 输入保留全部待摘要正文、工具参数、结果与图片引用元数据，不再先截每条头部或全部前 12000 字符。超长输入按 token 分批增量合并；所有批次成功后才提交整个覆盖区间，失败不推进 source hash / watermark，也不覆盖旧摘要。单条超长 Frame 可在摘要专用文本投影中分片，实际模型工具历史仍按原子 Frame 保持配对。
- checkpoint schema version 升到 2，使旧的覆盖不完整或空摘要缓存失效。格式错误、完成状态异常和过滤后为空按失败处理；同 hash 失败使用有界短时冷却，取消不缓存失败。
- 请求预算计入工具和 MCP 定义，最终检查计入消息协议开销与输出预留。`contextBudget` 是软预算，受保护用户内容导致超出时记录诊断；仅在已配置的模型真实窗口无法容纳估算请求时提前返回明确错误。保留用户约束，不为凑软预算强行删除。
- 预算与摘要实现位于 Runtime / 纯 TS 层，macOS、Windows、Linux 共用；不增加系统依赖，不引入检索式记忆或扩展到轮内语义压缩。

验证：format、lint、根级/前端 typecheck、build:packages、Rust fmt/test（237 项）、Tauri check 和最终 macOS .app/DMG 打包通过；上下文、Run、三协议、Store 及真实 Rust 集成相关回归 127/127，无跳过。纯合成协议和上下文测试覆盖晚到用户纠正、工具参数和错误尾部、超长单帧的完整分批输入、后续批次失败不提交、取消后可重试、空/非法/不完整摘要拒绝、旧缓存失效、工具定义占预算、软预算超出放行及模型窗口不足时发送前拦截。未做真实供应商长会话 A/B 或 Windows/Linux 真机验收；不据此声称模型摘要质量无损。
