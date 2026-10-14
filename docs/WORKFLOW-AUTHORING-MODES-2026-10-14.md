# Workflow 两种创建模式与运行前校验

日期：2026-10-14；分支：`feature/workflow`；布局基线：`4d02893`。

## 用户路径

默认进入自然语言创建，主区域直接显示模型选择、生成范围和描述输入。支持生成完整新流程，
也支持向当前草稿添加一个节点。生成候选后在主区域展示画布，用户审阅后点击
“应用并编辑画布”，进入画布编辑模式调整角色 Prompt、任务、端口与连线。

画布编辑模式支持从头手动创建和修改已有草稿；切换模式不清空描述、节点编辑、
运行输入或未应用的高级 JSON。已应用候选提供“在画布中继续编辑”，仍指向当前草稿。
生成、候选审阅/应用、版本保存、运行保持独立，生成结果不会自动执行。

顶部始终提供“运行流程”入口，打开运行参数面板。点击“开始运行”时自动校验当前定义：
先复用契约 schema，再调用既有 workflow.validate 进行图校验；失败展示具体问题并阻止
创建 Run。通过后核对当前草稿与保存版本是否一致，再调用 workflow.run.start。
启动侧仍独立校验输入、模型、工具与资源，保留既有权限边界；当前修改未保存时提示保存版本。
独立“校验”菜单已删除，用户无需手动执行前置校验。

## Review 与验证

- 校验使用稳定 callback 与最新定义 ref；异步校验期间检查编辑 epoch，拒绝迟到结果。
- 生成/启动期间冻结相关输入，防止界面展示与本次实际请求的模型、参数不一致。
- 生成面板保持挂载，通过 hidden 切换；候选只有成功应用到草稿后才切换编辑模式。
- 画布按已初始化节点和正数视口尺寸适配；宽高变化采用 primitive 依赖，修复隐藏画布
  再次显示时节点落在可视区域外的问题，没有常驻轮询/动画或不稳定对象依赖。
- 拆出 CreationModes、WorkflowGenerationView 与 WorkflowNotice；业务请求仍统一走 api 层。

headless Chromium 集成回归使用真实 WorkflowWorkspace/useWorkflowEditor 组件和合成 API，
覆盖默认模式、完整图生成、追加节点、候选画布、应用后人工修改、保存、校验失败不启动、
再次校验后启动、运行快照只读以及输入保留。调用顺序断言为 generate → validate →
validate → start，失败校验期间 start 调用次数为零。自然语言主面板与画布面板分别覆盖
1440、950、600 像素宽度的整页溢出检查，截图仅包含合成流程。

前端全量 87 项、根/前端 typecheck、lint、格式检查通过；Rust 233 项、两套 fmt 与 Host
cargo check 通过。无新增依赖、协议/存储迁移或 OS 逻辑，三平台共用 React/Radix 与
既有 Runtime API。真实模型、原生跨平台、高 DPI 和 dev 空闲资源本轮未实测；组件
回归不替代真机验收。用户纠正已记录在项目 MEMORY.md。

主要日志：`/tmp/workflow-modes-tests.log`、`/tmp/workflow-modes-build.log`、
`/tmp/workflow-modes-rust-tests.log`。build:packages 与最终 macOS app/DMG 打包通过，
打包日志为 `/tmp/workflow-modes-desktop-build.log`。
