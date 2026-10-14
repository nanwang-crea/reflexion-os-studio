# 对话驱动的团队 Skills

`team-create` 根据目标设计可复用角色，`agent-collaboration` 使用这些角色执行任务。
Skill 的方法说明调用受信任的 Runtime TypeScript 工具，不执行第三方 Skill 脚本。

团队采用已有角色模板组成：`domains` 中的 `team:<teamId>` 标识成员，不增加固定 DAG 或新的执行引擎。角色依旧可独立使用，用户可在 Agent 页调整模型、权限、工具和指令。

`agent_team.inspect` 可按 teamId 或 templateId 查询，返回当前项目可见的角色、团队、模型能力和工作区信息；不返回凭据、Provider headers 或 secretRef。角色来自应用存储，无需到工作区寻找模板文件。

`agent_team.create` 批量创建 1–8 个角色，只操作当前项目或全局范围。全部校验后单事务保存；同范围同团队标识重复创建拒绝，不能覆盖已有角色。保存经现有审批队列逐次确认，审批详情提供 Runtime 从实际参数生成的完整配置预览，计划模式拒绝，子 Agent 不具备团队管理工具。Danger 模式也不能跳过团队保存审批。角色模型必须可用，指令拒绝机密；工具不能包含团队管理能力，实际执行仍与父 Run 权限和工具取交集。

创建方法须明确职责、输入、输出、交接、核验和返工；未指定模型时继承当前模型。协作方法须通过 inspect 获取真实模板 ID 和能力，读取实际需要的素材后委派，并将所需 Skill 方法和上下文明确传给子 Agent。已有会话默认模板优先规则保持，团队执行须提示该规则可能限制多角色选择。

产物路径遵循用户及项目现有约定，没有约定时采用任务相关的相对目录并告知用户；团队配置不作为工作区文件落盘。保存通用协作方法仍通过现有用户审阅的 Skill 保存入口。

三个平台共用 contracts、Node SQLite、Runtime 工具和审批 UI，无平台命令或新系统依赖。macOS 自动测试与打包可在本机执行，Windows/Linux 真机以及真实模型行为需要分别验收。

## 验证

- 团队专项 7 项覆盖双注册入口、真实角色持久化与重启、模型和工具校验、跨项目隔离、事务失败回滚、计划模式、子 Agent 管理边界和 Danger 下单次审批。合成 SSE Provider 的真实 Agent 循环分别验证批准后创建及拒绝后零写入，结果经 canonical ToolOutput 保存。
- Chromium 界面回归覆盖完整配置预览的展开、限高滚动、收起和矮窗口内确认按钮可见；原协作面板的空闲 React 更新检查继续通过。未增加事件订阅、轮询或流式状态处理。
- 全量 Runtime 552 项通过、4 项 Windows 测试跳过；前端 82、contracts 81、Agent Core 67、runtime-client 25、Rust 233 项通过。格式、lint、根/前端 typecheck、TS 构建、Rust fmt、Tauri check 与 macOS 打包通过。
- 未使用真实在线 Provider，未完成 Windows/Linux 真机、原生团队配置审批界面与长期运行验收。并行 Provider/上下文改动保持原样，团队变更独立提交。
