# Reliability and Recovery

## M0 Bootstrap

只验证 sidecar 的 ready、status、ping、shutdown、协议解析和退出状态。Rust 未 ready 不阻塞 TypeScript Runtime 或纯 Chat；工具能力显示 unavailable。

## MVP Chat

Run：`created → running → completed|failed|cancelled|interrupted`。Approval、ToolCall、waiting_approval 和 checkpoint 在 1A-2 再加入。终态不可逆。

Provider chunk 带 `messageId` 和递增 `chunkSeq`；UI 按 messageId 累积 delta，Runtime 最终写入完整 Message，并保存 `finishReason`、usage 和 provider request id。MVP 不支持 Tool Call 增量。

MVP 取消从 Renderer → Tauri Host → TypeScript Runtime → Provider 传播，使用 requestId 关联。取消请求幂等；若完成和取消竞态，先提交 canonical 终态者生效。1A-2 再扩展到 Rust Tool 子进程。

MVP 应用重启后以 SQLite canonical state 为准，将未完成 Run 标记为 interrupted。未完成模型回复保留 partial 内容，不假装完整。Retry 创建新的 Run，并关联 `retryOfRunId`；MVP 不自动重试有副作用的操作。

## Agent Loop Hardening 与 Atomic Finalizer（2026-09）

- **完成状态机**：只有 `finish_reason=stop` 且无工具调用的轮次才能完成 Run；`length` 在续写预算内（默认 2 轮）继续，耗尽为 `output_truncated`；`content_filter` 失败且草稿落 failed（不伪造 completed）；finish reason 缺失/未知或与 toolCalls 不一致失败为 `provider_protocol`。稳定错误码：`max_turns` / `output_truncated` / `content_filtered` / `provider_protocol` / `no_progress` / `run_timeout` / `run_token_budget` / `tool_call_budget`。
- **Atomic Run Finalizer**：全部 Run 终态唯一生产入口，单个 SQLite 事务内收尾 pending 消息（含首轮失败悬挂的草稿清扫）、取消未终态 ToolCall（预建行一并收敛）、收敛活动 Plan（含未完成步骤）、写 Run 终态与失败事件、幂等创建 memory job；提交后按序发事件并执行回调（回调最多一次，通知器抛错不吞回调）。事务失败受控重试一次。
- **ToolCall 批量预建**：Provider 返回合法 tool_calls 后，模型轮事务内按声明顺序创建全部行（初始 pending），提交后发 `tool.requested`；进程在工具执行前退出时全部调用可审计，启动恢复统一 cancelled。
- **副作用调度**：相邻 pure/read 且资源不冲突的调用并行成批；write/shell/state 串行独占批，mutation 完成前后续 read 不交叉；结果按声明顺序回填；审批按声明顺序弹出，不允许后批准操作越过前一操作。
- **Loop Guard**：调用指纹 = 工具名 + canonicalJson(args) + freshness epoch（mutation 成功/Plan 变化/新消息递增）；相同只读指纹两次相同结果后第三次拦截（Run 失败 `no_progress`）；已成功 mutation 立即重放拦截（`duplicate_side_effect` 工具错误），模型仍重复一次失败 `no_progress`。
- **Run 预算**（AgentSettings，null = 内置默认而非无限制）：总时长 900s、累计 token 120k（Provider usage 口径）、工具调用 64 次、续写 2 轮。
- **Memory Job 恢复**：启动时遗留 running job 放回 pending（不计失败）；前台 Run 到达可抢占后台提取。
