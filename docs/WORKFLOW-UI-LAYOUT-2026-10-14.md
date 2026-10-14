# Workflow 工作台布局优化

日期：2026-10-14；分支：`feature/workflow`。

## 交互调整

- 页面固定在内容区高度内，顶部为项目与流程/草稿选择、保存操作；中央画布使用剩余空间。
- 右侧提供节点、流程、AI 生成、运行四个可切换面板；只有面板内部滚动。
- 点击画布节点或添加角色后自动打开节点编辑；Prompt/任务直接编辑，权限/预算/端口按需展开。
- 流程名称、说明与高级 JSON 移入流程面板；校验、归档、刷新放入更多菜单。
- 更多菜单复用 Radix DropdownMenu，支持键盘导航、Escape、焦点恢复与视口避让。
- AI 生成、运行输入和未应用的 JSON 编辑在切换/收起面板后保留；底层组件保持挂载。
- 运行尝试按节点折叠，执行中、待验收和失败状态默认展开；运行入口提示待处理审批/验收。
- 窄窗口侧栏覆盖画布，提供关闭按钮与 Escape，关闭后恢复面板入口的键盘焦点。

执行、保存版本、生成候选、审批与恢复的 Runtime/API 语义保持原样。没有新增依赖、
原生 select、事件订阅、轮询、OS 操作或权限放宽。React Flow/Radix 与主题变量继续用于
macOS/Windows/Linux；平台 WebView 验收仍需各自真机。

## Review 与验证

组件按职责拆出 DefinitionToolbar、FlowSettings 与 AttemptList；画布样式归 editor/canvas.css。
新面板使用每个工作台独立的 useId，避免多个已访问项目之间的 aria-controls ID 冲突。
只读快照的节点与流程配置禁用，画布继续使用既有只读操作守卫。

headless Chromium 回归覆盖：节点任务编辑、生成描述、运行输入、未应用 JSON 的保留，
1440×900、950×700、600×650 布局无整页纵向/横向溢出，Escape 与焦点恢复，以及原有
JSON 基线冲突、失败保留、严格端口字段、异常节点 ID、只读删除和端口改名连线回归。
截图使用合成示例流程，不涉及真实 Provider 或用户项目数据。

前端全量 87 项通过；根/前端 typecheck、format:check、lint 通过；Rust 233 项与 Host
cargo check/两套 fmt 通过。前端一次并行回归的既有文件换行测试触发耗时限制，未改动
该模块，其他检查结束后串行复跑 87 项全部通过。

完整窄窗口真机、高 DPI、Windows/Linux 与 dev 空闲进程资源本轮未实测。没有改变
Workflow 事件订阅或流式合帧；截图/组件验收不等价于完整 Tauri 真机验收。

build:packages 与最终 macOS app/DMG 打包通过。主要日志：`/tmp/workflow-layout-tests.log`、
`/tmp/workflow-layout-build.log`、`/tmp/workflow-layout-rust-tests.log`、
`/tmp/workflow-layout-desktop-build.log`。
