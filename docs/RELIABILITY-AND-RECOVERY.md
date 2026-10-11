# Reliability and Recovery

## M0 Bootstrap

只验证 sidecar 的 ready、status、ping、shutdown、协议解析和退出状态。Rust 未 ready 不阻塞 TypeScript Runtime 或纯 Chat；工具能力显示 unavailable。

## MVP Chat

Run：`created → running → completed|failed|cancelled|interrupted`。Approval、ToolCall、waiting_approval 和 checkpoint 在 1A-2 再加入。终态不可逆。

Provider chunk 带 `messageId` 和递增 `chunkSeq`；UI 按 messageId 累积 delta，Runtime 最终写入完整 Message，并保存 `finishReason`、usage 和 provider request id。MVP 不支持 Tool Call 增量。

MVP 取消从 Renderer → Tauri Host → TypeScript Runtime → Provider 传播，使用 requestId 关联。取消请求幂等；若完成和取消竞态，先提交 canonical 终态者生效。1A-2 再扩展到 Rust Tool 子进程。

MVP 应用重启后以 SQLite canonical state 为准，将未完成 Run 标记为 interrupted。未完成模型回复保留 partial 内容，不假装完整。Retry 创建新的 Run，并关联 `retryOfRunId`；MVP 不自动重试有副作用的操作。

Runtime 在打开业务数据库、迁移及启动恢复之前，必须持有数据目录内 `runtime-lock.db` 的 SQLite 独占事务锁。macOS / Windows / Linux 共用 SQLite 文件锁：同目录第二个 Runtime 立即启动失败，不发布 ready、不改写活动轮次；不同目录可并行运行。锁连接保持至进程退出，正常退出或崩溃后由操作系统释放，无需删除锁文件。锁文件不能在运行期间删除或替换。该保护要求所有实例使用带此检查的版本，升级时应先退出旧版实例。

## Agent Loop Hardening 与 Atomic Finalizer（2026-09）

- **完成状态机**：只有 `finish_reason=stop` 且无工具调用的轮次才能完成 Run；`length` 在续写预算内（默认 2 轮）继续，耗尽为 `output_truncated`；`content_filter` 失败且草稿落 failed（不伪造 completed）；finish reason 缺失/未知或与 toolCalls 不一致失败为 `provider_protocol`。稳定错误码：`max_turns` / `output_truncated` / `content_filtered` / `provider_protocol` / `no_progress` / `run_timeout` / `run_token_budget` / `tool_call_budget`。
- **Atomic Run Finalizer**：全部 Run 终态唯一生产入口，单个 SQLite 事务内收尾 pending 消息（含首轮失败悬挂的草稿清扫）、取消未终态 ToolCall（预建行一并收敛）、收敛活动 Plan（含未完成步骤）、写 Run 终态与失败事件；提交后按序发事件并执行回调（回调最多一次，通知器抛错不吞回调）。事务失败受控重试一次。终态不再创建自动记忆任务，Memory V2 以文件即记忆为准。
- **ToolCall 批量预建**：Provider 返回合法 tool_calls 后，模型轮事务内按声明顺序创建全部行（初始 pending），提交后发 `tool.requested`；进程在工具执行前退出时全部调用可审计，启动恢复统一 cancelled。
- **副作用调度**：相邻 pure/read 且资源不冲突的调用并行成批；write/shell/state 串行独占批，mutation 完成前后续 read 不交叉；结果按声明顺序回填；审批按声明顺序弹出，不允许后批准操作越过前一操作。
- **Loop Guard**：调用指纹 = 工具名 + canonicalJson(args) + freshness epoch（mutation 成功/Plan 变化/新消息递增）；相同只读指纹两次相同结果后第三次拦截（Run 失败 `no_progress`）；已成功 mutation 立即重放拦截（`duplicate_side_effect` 工具错误），模型仍重复一次失败 `no_progress`。
- **Run 预算**（AgentSettings，null = 内置默认而非无限制）：总时长 7200s（2 小时）、累计 token 2 亿（Provider usage 口径）、工具调用 1000 次、续写 2 轮、最大轮次 100。
- **Memory V2 边界**：启动恢复不处理任何 `memory_jobs`；AGENTS.md/MEMORY.md 由指令注入链路按当前文件内容读取，`memory.remember` 的写入仍遵守单条长度、单行与敏感内容拒绝规则。

## 计划审批恢复与临时文档清理

计划审批等待项持久化完整正文快照，重启续答前复核文件摘要与计划规格；旧审批缺少快照时保持计划模式并重新提交。活动计划文档跨失败与重启保留，仅计划完成或明确取消后清理，删除失败登记重试，人工修改或用户选择保留的文件不自动删除。历史审阅读取 canonical ToolOutput 中的快照。详见 [计划模式设计](PLAN-MODE.md)。

### 任务上下文与失败恢复

- 每轮从活动计划及其触发请求、后续用户约束生成 `task_context`，作为 user 控制帧注入；裁剪保护该帧与最新用户请求。计划创建绑定 assistant 消息时回溯到触发请求。无活动计划时保留当前请求；checkpoint 仍负责旧历史摘要。不改变 stop 收尾，不增加完成检查。
- 失败反思要求依据错误证据采取恢复动作并继续执行；未知原因先验证。有效读取快照不因锚点错误强制重读整文件，也不机械要求拆成单点编辑。
- 精确指纹保护之外，同一操作、规范化资源、错误类别累计四次失败后，下一次相同操作/资源以 `no_progress` 停止。参数变化、同版本读取和计划文字更新不清空记录；相关资源成功 mutation 或 file.read 返回不同 sha256 清空该资源记录。没有可识别资源的工具仍采用原有指纹保护。记录只在 Run 内存中存在。
