1. 调整 Run 分组与渲染边界：保留每个 Run 一个 `RunBlock`，确保最终回复正文在过程块外；若最终 assistant 轮同时带有 reasoning，则把该 reasoning 作为过程时间线中的独立段渲染，最终消息区域只负责正文、资源、状态、tokens/耗时和操作按钮，避免思考出现在最终回复区。
2. 完善 `ReasoningBlock` 两级交互：保留 Run 级折叠由 `RunBlock` 控制；思考段默认只显示单行摘要（统一做可见文本截断/省略），点击摘要切换该段完整文本，再次点击收起；保证每个 reasoning 段各自按消息顺序排列，并使用可访问的 `aria-expanded`/按钮语义。
3. 保留工具行的参数/结果点击查看能力，但明确它不是另一层“工作摘要”折叠：移除/避免旧 `WorkSummary` 路径在当前 Run UI 中参与渲染，保留 `ToolTraceItem` 仅作为工具详情 disclosure，不改变工具调用在时间线中的位置与状态展示。
4. 收敛组件职责与状态：让 `RunProcess` 专注按 `ProcessItem` 顺序渲染 reasoning、中间普通消息和工具轨迹；清理 `AssistantMessage` 中未使用的 `runActivity`，或仅保留必要的最终回复流式状态参数，避免 Run 活动状态重复推断。RunBlock 继续在运行时展开、完成后自动收起，同时不让普通活动刷新破坏用户手动切换后的状态。
5. 更新 `chat.css`：确保 Run 级按钮、过程时间线、思考单行摘要/展开全文、普通中间消息和工具行层级有清晰的缩进与视觉区分；保留工具详情样式；清理当前 UI 不再使用的旧 `work-summary` 样式（先确认无引用后删除），并处理长文本、换行和窄屏场景。
6. 验证：运行 `pnpm format:check`、`pnpm lint`、根级及 desktop `typecheck`，并按项目流程执行可用的构建/相关测试；如环境导致某一步失败，记录真实失败输出，不将未执行项表述为通过。