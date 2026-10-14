# Agent 协作改造验证记录

## 分支与退役边界

- `codex/archive-workflow-stable-2026-10-14`：改造前 main 的稳定 Workflow 实现。
- `codex/archive-workflow-2026-10-14`：完整历史及未完成的 Workflow 双栏会话草稿，快照 `eb6322c`。
- 当前改造在 main：移除 Workflow 前端、API、协议命令与执行/生成服务。
  旧数据库 schema、历史实体解析、启动终态收敛和内部会话防护保留。
- 已搜索旧 UI 路径、Workflow client/command 类型和 CI 调用，生产代码零残留。
  contracts 中的历史 Workflow 实体与 Store 是刻意保留的兼容边界。

## 行为验收

角色配置支持领域分类、全局/项目范围、固定 Provider/模型/思考等级、
工具集合和权限上限。模板角色不能选另一个项目目录，子实例记录真实
模型与项目工作空间。模型缺失、禁用或思考等级不支持时不静默回退。

主对话右侧协作图展示计划顺序和真实多层委派，支持查看子会话、停止
子 Agent、切换历史任务和审阅保存协作 Skill。候选方法不自动复制
任务全文、文件路径或机密。保存使用标准 SKILL.md 和现有插件校验、
原子安装与项目作用范围；当前对话 Skill 列表由事件即时刷新。

Runtime 专项 7 项通过，包括两个本地合成 Provider 的真实 Agent 循环：
主模型调用 task，角色指定另一 Provider/模型，实际 HTTP 请求携带正确
思考等级并流式返回子结果；运行和委派记录保持该模型快照。

Chromium 集成回归使用真实角色组件、协作图和子会话轨迹窗口，API 为
隔离合成数据。覆盖模型/思考设置、领域与项目持久参数、多层委派事件、
子会话查看、取消、Skill 内容审阅和目录刷新、窄视口、所有节点边界、
事件订阅卸载，以及空闲期间 React commit 数保持不变。

## 自动检查

格式检查、lint、根/前端 typecheck、build:packages、协议/宿主白名单检查、
Rust fmt、Tauri cargo check 通过。Contracts 81、Agent Core 65、
Runtime Client 25、桌面 82、Rust sidecar 233 项通过。
Runtime 全量 535 项通过，4 项 Windows MCP launcher 测试因平台不符跳过；已指定真实 Rust sidecar，文件、Git、启动与恢复端到端用例均执行。

第一次接入真实 sidecar 的全量复测出现一次既有浏览器下载暂存清理时序失败，
该测试单独复测和完整 Runtime 再次复测均通过；没有修改该浏览器实现或测试。

macOS ARM 自包含 .app 与 DMG 构建通过；最终包包含更新后的 Runtime、
模型与角色协议，以及新的 Agent/协作前端。

## 原生与平台限制

隔离临时数据目录的 dev 实例启动成功，Runtime 与 System Runtime 均 ready。
按 `top -l 4 -s 3 -stats pid,cpu,mem` 方法对本次宿主、Node Runtime、
WebView 取四次空闲样本，三者 CPU 均为 0.0%。另以 ps 获取 RSS，
分别约 60 MB、42 MB、27 MB；macOS top 的 MEM 口径与 RSS 不相同。
测试宿主关闭后确认两个 sidecar 均退出。

原生 UI 工具不能可靠区分同 bundle ID 的现有用户实例与 dev 实例，
因此未完成原生协作面板打开/关闭的资源对比；不把上述空闲样本当作
协作面板性能完整验收。已完成的是 Chromium 组件视觉与空闲更新回归。
Windows/Linux 真机、真实在线模型质量与长期运行尚未验收。
