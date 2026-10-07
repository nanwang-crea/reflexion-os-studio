export const MANAGE_PLAN_DESCRIPTION = `管理当前任务的活动计划及其步骤。仅在任务确实包含多个需要跟踪的步骤时使用；简单任务不要创建计划。

核心约束：
- 同一任务同一时刻最多存在一个活动计划。
- 如果已经存在活动计划，禁止再次 create；必须沿用已有 planId 推进（update_step）或整体调整
  （modify_plan）。
- 不要自创 action。另支持 write_document 和 retain_document。
- 计划模式审批前必须 write_document：传 planId 与 markdown 完整方案（目标、实施步骤、涉及范围、验证方式和必要取舍）。写入临时计划文件；用户可直接编辑。若文件已被人工修改，先 get 读取全文，再基于该内容修订并传 document.sha256 为 expectedSha256，禁止盲目覆盖。
- retain_document：传 planId 与 retain=true 保留文件；默认在完成/取消后安全删除。独立会话无项目时使用会话内快照。
- 工具返回错误时，先根据错误信息修正参数，再重试；禁止使用相同参数盲目重试。

动作：
1. get
   只读查询，无副作用。不确定当前是否已有活动计划、或记不清 planId/步骤状态时先调用它，
   再决定后续动作；不要凭上下文记忆猜测。可省略 planId（返回当前会话的活动计划，
   无活动计划时返回 null）；提供 planId 时返回该计划详情（限本会话）。

2. create
   创建活动计划。必须提供 goal 和 steps。
   每个步骤必须包含 id 和 title；id 在同一计划内必须唯一，创建后不可复用。
   步骤 id 建议使用带唯一前缀的形式（如 plan-s1-<名称>），避免与历史计划冲突。
   新建步骤状态固定为 pending；create 时不要传步骤 status。
   create 之前先 get 确认当前没有活动计划。

3. update_step
   推进已有计划中的一个步骤。必须提供 planId、stepId 和 status。
   正常步骤必须按 pending → in_progress → completed 依次流转；禁止从 pending 直接变为
   completed，已 completed 的步骤不可回退或重新打开。
   status 也可以是 skipped 或 cancelled，用于明确放弃某个步骤；这些是终止状态，不可再次推进。
   某次尝试受挫时步骤保持 in_progress，修正后重试即可；可选 note 记录进展或结果。

4. modify_plan
   原地整体修改当前活动计划（planId 不变）。必须提供 planId、goal 和 steps（声明式全量规格）。
   合并规则：与新规格同 id 的步骤保留 status/note，仅更新 title（改标题不算重做）；
   全新 id 的步骤插入为 pending；未出现在新规格中的现有步骤被删除。
   需要重做已完成的工作时用新步骤 id（如 plan-s3-verify-v2）表达，不要复用已完成步骤的 id。
   仅允许修改 active 状态的计划；适用于范围变化、步骤增减、目标修正等计划修订场景。

5. complete_plan
   在所有必要步骤都已 completed 或 skipped 后结束计划。必须提供 planId；可选 summary。
   不得在仍有未处理步骤时调用。

6. cancel_plan
   在用户明确放弃整个任务时将计划标记为取消。必须提供 planId；可选 summary 或 note。

计划卫生（必读）：
- 创建前检查：create 之前先用 get 确认当前没有活动计划（读 canonical 状态，不靠上下文记忆）；
  已有活动计划时禁止再 create，应沿用返回的 planId 推进（update_step）、整体调整（modify_plan）
  或收尾（complete_plan/cancel_plan）。
- 收尾检查：任务收尾时先用 get 确认活动计划状态——必要步骤已全部终态则调用 complete_plan；
  目标已明显失效（被取代、演示完成等）可调用 cancel_plan 并在 note 说明原因；
  拿不准计划是否还有用时，先询问用户再决定，不要留一个无人推进的活动计划占位。

planId 规则：
- 仅 get 的 planId 可省略；create 不需要 planId；其余动作（update_step/modify_plan/
  complete_plan/cancel_plan）都必须提供 planId，缺失会被拒绝。
- 记不清 planId 时先调用 get（省略 planId）找回当前活动计划，不要凭记忆猜测。

状态规则：
- 计划状态：active → completed 或 cancelled；终止状态不可回退。
- 步骤状态：pending → in_progress → completed；也可从 pending 或 in_progress 进入
  skipped 或 cancelled。
- 状态流转属于运行时状态机，调用参数 schema 只能校验字段格式，不能替代运行时校验。`
