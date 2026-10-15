# 团队配置维护

团队仍以相同作用范围下 domains 的 team:<teamId> 成员集合表示，不新增工作流或团队存储表。
主 Agent 可 inspect/create/update/delete；子 Agent 不具备管理能力。update 为增量完整角色配置与显式 removeRoleIds，未提及成员保留。delete 删除整个团队。移除成员时独占角色模板删除；属于其他团队的模板只解除本团队成员关系。历史与正在运行的实例使用原快照，不改写执行记录。

inspect 返回基于完整成员配置的 revision。update/delete 必须携带 expectedRevision，在事务内检查后原子执行；审批期间成员或配置变化则拒绝并要求重新查询和审批。所有变更逐次审批，预览实际参数，禁止会话级操作授权；计划模式与子 Agent 均拒绝。工具只允许当前项目或全局范围，不允许跨项目修改。复用现有模板验证与模型能力校验。

Agent 页已有单角色编辑、删除与 domains 成员配置入口，继续使用同一存储，不建立另一份团队配置。三个平台使用相同 TypeScript/SQLite 与审批链路，无新增系统依赖。
