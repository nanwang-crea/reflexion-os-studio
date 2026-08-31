# Agent Loop 增强待做清单

> 来源:2026-08-31 主 Agent 循环与主流 Agent（Claude Code / Codex / Cursor / Aider / OpenHands）差距分析。
> 状态标记:`✅ done` / `🔨 in-progress` / `⬜ pending`。与 Phase 边界冲突的项在括号内注明。
> 序号与差距分析报告一一对应,便于回查。

## 状态总览

| 进度           | 当前                                                               |
| -------------- | ------------------------------------------------------------------ |
| ✅ done        | #1 并行工具调用、#4 网络/限流自动重试、#2 上下文窗口动态感知(主体) |
| 🔨 in-progress | 无                                                                 |
| ⬜ pending     | 其余(#2 后续项:模型 contextWindow 元数据 / 轮内摘要压缩)           |

## 条目

### #1 并行工具调用 ✅ done

- **差距**:provider 已把同轮多个 `tool_calls` 按 index 聚合,但 `runAgentLoop` 用串行 for 逐个 await,多工具轮次耗时线性累加。
- **目标**:同轮工具并行执行,结果按原始顺序回填(保证 provider 方言语义稳定);宿主侧 in-flight 工具行改为集合,取消时全量收尾。
- **边界**:无(agent-core 与 runner 均为内核内改动)。审批卡在并行 ask 时逐卡弹出,属预期行为。

### #2 上下文窗口动态感知 ✅ done（主体）

- **差距**:`CONTEXT_TOKEN_BUDGET = 24_000` 固定且只在 Run 启动时压缩一次;轮内消息(尤其多个工具结果)持续膨胀,超预算后会直接触达模型上下文上限报错。
- **目标(主体)**:轮内每轮发送前按预算裁剪 —— 优先折叠最老的"assistant 工具轮 + 其 tool 结果"为一句话(成对删除,保证 provider 对 tool_call_id 的配对要求),仍超则截断历史到最近窗口。
- **后续项(未做)**:
  - 模型 contextWindow 元数据:ProviderProfile 增加可选 `contextWindow`,预算动态取 `min(24k, window * 0.75)`;
  - 轮内可选的摘要压缩(现为纯裁剪,不额外调用模型)。

### #3 失败反思/复盘（Reflexion 机制）⬜

- **差距**:无显式反思。工具连续失败或 N 轮不收敛时,失败教训没有自动注入下一轮;项目名即 ReflexionOS,该机制与产品定位最契合。
- **方向**:runner 检测"同一工具失败 ≥2 次 / 轮次过半未收敛"时,附加一条反思 user 消息(可落记忆),下一轮带教训继续。

### #4 网络/限流自动重试 ✅ done

- **差距**:429、瞬时网络错误、5xx 直接失败,仅靠手动 Retry。
- **目标**:请求建立阶段失败(网络错误、429、5xx)自动重试 ≤2 次,指数退避(1s→2.5s),尊重取消信号;**流式读中断不重试**(已吐出的 delta 无法回滚,避免 UI 文本重复);连接测试(maxTokens=1)关闭重试快速失败。

### #5 验证-修复循环 ⬜

- **差距**:无内置"跑测试/构建 → 修 → 再跑"模板,主流 coding agent 的核心工作模式靠用户 prompt 隐式驱动。
- **方向**:builtin skill(如 `verify-fix`):改代码 → shell 跑测试 → 失败分析 → 再改,循环上限内收敛。【零内核改动】

### #6 Plan/Execute ⬜

- **差距**:无"计划"概念,复杂任务直接动手。
- **方向**:任务含多文件/多步骤时,先输出计划清单再执行(计划工具或 prompt 规范),执行中对照勾选。

### #7 usage/token 展示 ⬜

- **差距**:`message.completed` 已携带 usage,UI 未展示 token 与耗时。
- **方向**:助手消息 meta 行展示 tokens/耗时;Run 列表可合计成本(需 token 计价配置,成本属后续)。

### #8 中断续跑（resume）⬜

- **差距**:interrupted Run 只能"重新生成",不能从断点继续。
- **方向**:草稿消息(内容/工具进行中状态)已有落库基础,恢复为"继续"即可继续后续轮次。

### #9 模型参数暴露 ⬜

- **差距**:无 temperature 传递,maxTokens 仅测试用。
- **方向**:Provider 配置项增加 temperature/maxTokens,message.send 可选覆盖。

### #10 MCP 接入 ⬜（Phase 2 边界内）

- **差距**:工具集完全静态内置,无外部工具生态接入。
- **方向**:runtime 侧 MCP client + 工具桥,contracts 增加 mcp.* 命令;大改动,单独排期。

### #11 多 Agent 委派 ⬜（Phase 3 边界,不得提前实现）

- 差 subagent 委派(Claude Code subagents / AutoGen 式);`RunSchema` 的 agentId/parentRunId/delegationId 字段已预留,仅契约级占位。

### #12 浏览器工具 / 多模态 / 附件 ⬜（Phase 2/5）

- 浏览器工具属 Phase 2 边界;多模态与附件属 Phase 5,不提前实现。

## 推进记录

- 2026-08-31:差距分析成文;#1(并行工具调用)、#4(请求建立阶段自动重试)、#2 主体(轮内预算约束)完成并全量验证通过;#2 后续项(模型 contextWindow 元数据、轮内摘要压缩)待做。
- 2026-08-31:#1/#4/#2 完成后 review,修复发现的问题:(a) 并行工具轮次下,先完成的审批把 Run 状态无条件回置 running,其余 ask 等待期间状态错报 —— ApprovalGateway 记录 pending 所属 runId 并新增 `hasPendingRun`,runner 仅在无其它未决审批时回置;(b) JSON 美化预览成功后仍显示"加载更多",续页拼装会导致行号漂移 —— 美化生效时隐藏分页入口;(c) provider 重试退避索引含 `.at(-1) ?? 1000` 死代码分支 —— 收敛为显式 min 下标。新增审批网关单测(runtime 49/49)。
