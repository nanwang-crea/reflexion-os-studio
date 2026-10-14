# Workflow W0 review 与 W1–W3 实施记录

> 历史文档：2026-10-14 已退役独立 Workflow 编排。实现保留于 `codex/archive-workflow-2026-10-14`，当前方向见 [Agent 协作](AGENT-COLLABORATION-2026-10-14.md)。

日期：2026-10-13；分支：`feature/workflow`。本记录评审当前本地变更，不涉及远程 PR。

## W0 发现与修正

| 问题                            | 影响                             | 修正                                                   |
| ------------------------------- | -------------------------------- | ------------------------------------------------------ |
| 可选端口读取未检查 own property | constructor 等键可能读到原型成员 | 所有成果/输入查找使用 Object.hasOwn                    |
| 成果集合只有单值限制            | 多个大值可突破输入/结果总预算    | 集合在递归解析前做整体大小/深度/项数限制               |
| 工具列表未去重                  | 执行快照可能重复声明能力         | 策略交集去重，管理/委派能力不开放                      |
| 状态表未被持久化写入使用        | 错误调用可能复活终态或回退计数   | Store 强制状态转换、stateVersion 与预算不可递减        |
| 模型仅冻结标识                  | 运行期间配置变化可能改变实际行为 | 冻结模型合并后的 Provider 配置，执行时仅解析 secretRef |

## W1–W3 重点风险与闭环

- 使用独立 WorkflowRun，节点关联真实 Agent Run/Session，不伪造 task 或父 Run。
- 节点尝试/Run/消息原子关联；Run 终态与结果 checkpoint 同事务提交。
  成果发布前校验端口、内容和资源；迟到结果不能发布。
- 成功成果不可覆盖；恢复检查 hash、资源指纹、节点契约与输入 hash。
  已完成且 checkpoint 有效的节点补齐发布，不能再次执行工具。
- 写入/Shell/MCP/网络等操作在调用前持久化可能副作用；记录的文件变更另作标记。
  失败或中断后需显式核查承认相关尝试才能重新执行，无通用回滚承诺。
- 并行节点共享工具/token/尝试/时间预算、权限域与写协调器；重试不重置计数。
  Provider 未报告 usage 时采用保守估算；未知崩溃请求成本按节点 token 预算扣除。
  usage 事后计量仍可能超出一次响应，发现后停止，不把它解释为供应商费用硬上限。
- Workflow ask-everything 不能被 MCP/路径/命令会话规则复用绕过；Danger 不生效。
- 内部节点会话不进入普通列表，不受理普通 message.send/retry/edit-resend 或独立删除。
  项目删除与定义归档检查活动流程，项目删除在事务内再次复核。
- 业务确认绑定节点尝试、输入 hash、token 和有效期；重启旧 token 作废。
  确认与工具审批独立，拒绝验收不能作为普通失败偷偷续跑。
- 控制命令具备 requestId 重放/冲突检查；确认和恢复结果随状态修改原子记录。
  重放记录绑定项目，删除项目后不残留旧 Prompt/成果。
- 不可信输入只作为用户数据进入上下文；已知凭据形态阻止定义/结构化成果保存与交接，
  敏感资源路径在任何读取前拒绝。形态检查不声称能识别任意凭据或消除所有提示注入。

## 范围

W1：串行执行、成果交接、轨迹、取消与 API；W2：并行汇合、共享预算、写协调与失败收敛；
W3：人工确认、重启收敛、显式恢复与手动重试。代码 Builder 和写作使用合成输入/Provider 验证。

W4 画布与正式入口、W5 自然语言生成未实现；Automations 仍为占位页面。
三平台真机、真实模型质量、用户 GUI、长稳/空闲性能结论不得从合成测试推导。

目录审查覆盖 Runtime、前端、Rust 与 contracts：Workflow Store 已按定义与执行拆分；
执行目录按调度、节点执行、确认、计时状态与恢复分文件。剩余密集目录分别是协议 schema、
API/工具注册、共享组件、Run 生命周期、权限策略、平台文件服务和 Provider 适配边界，
本批没有新增跨域文件。新实现文件均低于 300 行；现有装配/执行模块保持低于 500 行。

## 最终验证

Workflow 相关 56 项测试通过（contracts 6、Runtime 50）。全量回归：Contracts 81、
Agent Core 65、Runtime Client 25、Runtime 578 pass / 4 平台 skip、前端 81、
System Runtime 233；宿主默认测试 41。协议/Chat/工作区/迁移等冒烟、终端故障矩阵
26/26、Host 白名单检查通过。format/lint、根/前端 typecheck、build:packages、
两个 Rust workspace 格式检查、宿主 cargo check 与 macOS app/DMG 打包通过。

独立临时数据目录启动 dev 应用，Host 80174、其直接子 Runtime 80304、单一新建
WebContent Renderer 80298；不任选系统中同名进程。top -l 4 -s 3 四轮均为
0.0% CPU；ps RSS 为 122.75 / 84.70 / 265.61 MiB。采样期间不构建或修改 Renderer。
此前 Browser 验收的同方法空闲 CPU 也是 0.0%，RSS 为 127.6 / 87.5 / 285.7 MiB，
本次未重建相同代码/数据基线，RSS 差异不归因于本次变更，也不作为长稳结论。
退出后本次 Host/Runtime/Renderer/System 四个已关联 PID 均不存在。
采样原始记录位于 `/tmp/reflexion-workflow-idle.UhCyUI`。

未执行 Windows/Linux 真机、Workflow GUI（W4 尚未实现）、真实模型任务效果和
Workflow 长稳验收；未将已有 Browser/Terminal GUI 记录当成本次 Workflow 证据。
